//! A disk in memory that tracks what has reached stable storage, so tests can
//! stop the Runner at any write and cut the power in several ways.
//!
//! Data written to a file is durable once the file is synced. When a new or
//! renamed name is durable depends on the [`Names`] model. A power cut keeps
//! the durable state plus some part of the rest, chosen by [`Cut`].

use std::collections::BTreeMap;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::{Disk, Reader, Writer};

/// What a power cut keeps of the writes that were never synced.
#[derive(Clone, Copy, Debug)]
pub enum Cut {
    /// Only what was synced.
    Synced,
    /// Everything, as when only the process died.
    Everything,
    /// New names and renames, but not unsynced data: the directory reached
    /// the disk before the file's contents did.
    NamesWithoutData,
    /// Unsynced data, but not the names: the contents reached the disk and
    /// the rename didn't.
    DataWithoutNames,
    /// Files keep their new length, but bytes appended since the last sync
    /// read as zeros.
    ZeroedTail,
    /// Half of the bytes appended since the last sync.
    TornTail,
}

/// When new names and renames reach stable storage.
#[derive(Clone, Copy, Debug, Default)]
pub enum Names {
    /// Once their directory is synced, as POSIX promises after `fsync` on
    /// the directory.
    #[default]
    DirectorySync,
    /// In order, with the next sync of any file, as NTFS commits its
    /// metadata journal. The Runner can't sync a directory on Windows.
    Journal,
}

pub const CUTS: [Cut; 6] = [
    Cut::Synced,
    Cut::Everything,
    Cut::NamesWithoutData,
    Cut::DataWithoutNames,
    Cut::ZeroedTail,
    Cut::TornTail,
];

#[derive(Clone, Default)]
struct Inode {
    data: Vec<u8>,
    synced: Vec<u8>,
    /// Bytes before this offset haven't changed since the last sync.
    clean: usize,
}

impl Inode {
    fn changed_from(&mut self, offset: usize) {
        self.clean = self.clean.min(offset);
    }

    fn sync(&mut self) {
        self.synced.truncate(self.clean);
        self.synced.extend_from_slice(&self.data[self.clean..]);
        self.clean = self.data.len();
    }

    fn after(&self, cut: Cut) -> Vec<u8> {
        let appended = self.clean >= self.synced.len() && self.data.len() > self.synced.len();
        let extra = self.data.len().saturating_sub(self.synced.len());
        match cut {
            Cut::Everything | Cut::DataWithoutNames => self.data.clone(),
            Cut::ZeroedTail if appended => {
                let mut out = self.synced.clone();
                out.resize(self.data.len(), 0);
                out
            }
            Cut::TornTail if appended => self.data[..self.synced.len() + extra / 2].to_vec(),
            _ => self.synced.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Entry {
    Dir,
    File(usize),
}

#[derive(Default)]
struct State {
    root: PathBuf,
    inodes: Vec<Inode>,
    /// Names as the running process sees them.
    names: BTreeMap<PathBuf, Entry>,
    /// Names as stable storage has them.
    synced_names: BTreeMap<PathBuf, Entry>,
    model: Names,
    ops: usize,
    crash_at: Option<usize>,
    crashed: bool,
    fail_at: Option<usize>,
}

impl State {
    /// Counts a change to the disk. From the crash point on, every change
    /// fails, as the process is gone.
    fn op(&mut self) -> io::Result<()> {
        if self.crash_at.is_some_and(|at| self.ops >= at) {
            self.crashed = true;
            return Err(io::Error::other("simulated crash"));
        }
        self.ops += 1;
        if self.fail_at == Some(self.ops - 1) {
            return Err(io::Error::other("simulated write error"));
        }
        Ok(())
    }

    /// True if the next change won't happen as asked.
    fn faulty(&self) -> bool {
        self.crash_at.is_some_and(|at| self.ops >= at) || self.fail_at == Some(self.ops)
    }

    fn file(&self, path: &Path) -> io::Result<usize> {
        match self.names.get(path) {
            Some(Entry::File(i)) => Ok(*i),
            Some(Entry::Dir) => Err(io::Error::other("is a directory")),
            None => Err(io::ErrorKind::NotFound.into()),
        }
    }

    fn mkdirs(&mut self, dir: &Path) -> io::Result<()> {
        let root = self.root.clone();
        let missing: Vec<PathBuf> = dir
            .ancestors()
            .take_while(|a| *a != root)
            .map(Path::to_path_buf)
            .collect();
        for path in missing.into_iter().rev() {
            match self.names.get(&path) {
                Some(Entry::Dir) => {}
                Some(Entry::File(_)) => return Err(io::Error::other("not a directory")),
                None => {
                    self.names.insert(path, Entry::Dir);
                }
            }
        }
        Ok(())
    }

    fn new_file(&mut self, path: &Path) -> io::Result<usize> {
        let parent = path.parent().unwrap_or(Path::new(""));
        if parent != self.root && self.names.get(parent) != Some(&Entry::Dir) {
            return Err(io::ErrorKind::NotFound.into());
        }
        self.inodes.push(Inode::default());
        let i = self.inodes.len() - 1;
        self.names.insert(path.to_path_buf(), Entry::File(i));
        Ok(i)
    }
}

#[derive(Clone)]
pub struct SimDisk(Arc<Mutex<State>>);

impl SimDisk {
    /// An empty disk whose `root` directory already exists.
    pub fn new(root: &Path) -> SimDisk {
        SimDisk::with_names(root, Names::default())
    }

    pub fn with_names(root: &Path, model: Names) -> SimDisk {
        SimDisk(Arc::new(Mutex::new(State {
            root: root.to_path_buf(),
            model,
            ..State::default()
        })))
    }

    /// Makes the change `n` from now fail, and every change after it, as if
    /// the process died there. A write that fails this way leaves the first
    /// half of its bytes in the file.
    pub fn crash_after(&self, n: usize) {
        let mut s = self.0.lock().unwrap();
        s.crash_at = Some(s.ops + n);
    }

    /// Makes only the change `n` from now fail, as a full disk would.
    pub fn fail_after(&self, n: usize) {
        let mut s = self.0.lock().unwrap();
        s.fail_at = Some(s.ops + n);
    }

    /// True once a change failed because of `crash_after`.
    pub fn crashed(&self) -> bool {
        self.0.lock().unwrap().crashed
    }

    /// The disk as the next boot finds it.
    pub fn power_cut(&self, cut: Cut) -> SimDisk {
        let s = self.0.lock().unwrap();
        let names = match cut {
            Cut::Synced | Cut::DataWithoutNames => &s.synced_names,
            _ => &s.names,
        };
        let mut next = State {
            root: s.root.clone(),
            model: s.model,
            ..State::default()
        };
        for (path, entry) in names {
            // A name whose directory didn't survive is gone with it.
            let reachable = path
                .ancestors()
                .skip(1)
                .take_while(|a| *a != s.root)
                .all(|a| names.get(a) == Some(&Entry::Dir));
            if !reachable {
                continue;
            }
            let entry = match entry {
                Entry::Dir => Entry::Dir,
                Entry::File(i) => {
                    let data = s.inodes[*i].after(cut);
                    next.inodes.push(Inode {
                        clean: data.len(),
                        synced: data.clone(),
                        data,
                    });
                    Entry::File(next.inodes.len() - 1)
                }
            };
            next.names.insert(path.clone(), entry);
        }
        next.synced_names = next.names.clone();
        SimDisk(Arc::new(Mutex::new(next)))
    }

    /// Puts a file on the disk as if it had been synced long ago.
    pub fn put(&self, path: &Path, data: &[u8]) {
        let mut s = self.0.lock().unwrap();
        s.mkdirs(path.parent().unwrap()).unwrap();
        let i = match s.file(path) {
            Ok(i) => i,
            Err(_) => s.new_file(path).unwrap(),
        };
        s.inodes[i] = Inode {
            data: data.to_vec(),
            synced: data.to_vec(),
            clean: data.len(),
        };
        s.synced_names = s.names.clone();
    }
}

struct SimWriter {
    disk: SimDisk,
    inode: usize,
}

impl Writer for SimWriter {
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut s = self.disk.0.lock().unwrap();
        // A write cut short by a crash or an error leaves part of its bytes.
        if !s.crashed {
            let kept = if s.faulty() {
                &bytes[..bytes.len() / 2]
            } else {
                bytes
            };
            let inode = &mut s.inodes[self.inode];
            inode.changed_from(inode.data.len());
            inode.data.extend_from_slice(kept);
        }
        s.op()
    }

    fn sync(&mut self) -> io::Result<()> {
        let mut s = self.disk.0.lock().unwrap();
        s.op()?;
        s.inodes[self.inode].sync();
        if let Names::Journal = s.model {
            s.synced_names = s.names.clone();
        }
        Ok(())
    }
}

impl Disk for SimDisk {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        s.mkdirs(dir)
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let s = self.0.lock().unwrap();
        let i = s.file(path)?;
        Ok(s.inodes[i].data.clone())
    }

    fn reader(&self, path: &Path) -> io::Result<Box<dyn Reader>> {
        Ok(Box::new(Cursor::new(self.read(path)?)))
    }

    fn append(&self, path: &Path) -> io::Result<Box<dyn Writer>> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        let inode = match s.file(path) {
            Ok(i) => i,
            Err(e) if e.kind() == io::ErrorKind::NotFound => s.new_file(path)?,
            Err(e) => return Err(e),
        };
        Ok(Box::new(SimWriter {
            disk: self.clone(),
            inode,
        }))
    }

    fn create(&self, path: &Path) -> io::Result<Box<dyn Writer>> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        let inode = match s.file(path) {
            Ok(i) => {
                s.inodes[i].changed_from(0);
                s.inodes[i].data.clear();
                i
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => s.new_file(path)?,
            Err(e) => return Err(e),
        };
        Ok(Box::new(SimWriter {
            disk: self.clone(),
            inode,
        }))
    }

    fn len(&self, path: &Path) -> io::Result<u64> {
        let s = self.0.lock().unwrap();
        let i = s.file(path)?;
        Ok(s.inodes[i].data.len() as u64)
    }

    fn set_len(&self, path: &Path, len: u64) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        let i = s.file(path)?;
        let inode = &mut s.inodes[i];
        inode.changed_from(inode.data.len().min(len as usize));
        inode.data.resize(len as usize, 0);
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        let entry = s.names.remove(from).ok_or(io::ErrorKind::NotFound)?;
        s.names.insert(to.to_path_buf(), entry);
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        s.file(path)?;
        s.names.remove(path);
        Ok(())
    }

    fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        s.names.retain(|path, _| !path.starts_with(dir));
        Ok(())
    }

    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        s.op()?;
        if let Names::Journal = s.model {
            return Ok(());
        }
        let in_dir = |path: &Path| path.parent() == Some(dir);
        s.synced_names.retain(|path, _| !in_dir(path));
        let children: Vec<(PathBuf, Entry)> = s
            .names
            .iter()
            .filter(|(path, _)| in_dir(path))
            .map(|(path, entry)| (path.clone(), *entry))
            .collect();
        s.synced_names.extend(children);
        Ok(())
    }
}

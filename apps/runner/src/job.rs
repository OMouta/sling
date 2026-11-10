//! Holds every process a command starts on Windows, so stopping the command
//! stops all of them. A job object does that there: killing it ends each
//! process in it, and closing it, when the Runner drops it or exits, kills
//! whatever is left. Unix uses process groups instead, so there a `Job` is
//! empty and does nothing.

pub struct Job {
    #[cfg(windows)]
    handle: Option<windows_sys::Win32::Foundation::HANDLE>,
}

// SAFETY: a job handle can be used and closed from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

impl Job {
    /// Puts process `pid` in a new job. Processes it starts from then on
    /// join the job too. A process that can't be put in one is left out,
    /// and `kill` does nothing for it.
    #[cfg(windows)]
    pub fn adopt(pid: Option<u32>) -> Job {
        Job {
            handle: pid.and_then(adopt),
        }
    }

    #[cfg(not(windows))]
    pub fn adopt(_pid: Option<u32>) -> Job {
        Job {}
    }

    /// Kills every process in the job.
    pub fn kill(&self) {
        #[cfg(windows)]
        if let Some(h) = self.handle {
            // SAFETY: `h` is a job handle this `Job` owns and hasn't closed.
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(h, 1);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            // SAFETY: closes the handle this `Job` owns, once.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(h);
            }
        }
    }
}

#[cfg(windows)]
fn adopt(pid: u32) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // SAFETY: plain Win32 calls. Every handle opened here is either closed
    // before returning or handed to the caller, who closes it on drop.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        let assigned = !process.is_null() && AssignProcessToJobObject(job, process) != 0;
        if !process.is_null() {
            CloseHandle(process);
        }
        if set == 0 || !assigned {
            CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

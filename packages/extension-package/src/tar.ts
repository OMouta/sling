/**
 * A small ustar reader and writer. Packages hold only regular files, so the
 * reader refuses links, devices, and anything else, and the writer makes the
 * same bytes for the same files every time.
 */

export class PackageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageError";
    this.code = code;
  }
}

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = enc.encode(value);
  if (bytes.length > length) throw new PackageError("bad_path", `"${value}" is too long`);
  buf.set(bytes, offset);
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** Splits a path into ustar's prefix and name fields. */
function splitPath(path: string): [prefix: string, name: string] {
  if (enc.encode(path).length <= 100) return ["", path];
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return [prefix, name];
  }
  throw new PackageError("bad_path", `${path} is too long for a package`);
}

/** Regular files only, in path order, with mtime 0, owner 0, and mode 0644. */
export function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const paths = [...files.keys()].sort(comparePaths);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const path of paths) {
    const data = files.get(path) as Uint8Array;
    const header = new Uint8Array(BLOCK);
    const [prefix, name] = splitPath(path);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30; // '0': regular file
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeString(header, 345, 155, prefix);
    let sum = 0;
    for (const b of header) sum += b;
    writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, data);
    total += BLOCK + data.length;
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      total += pad;
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Byte order of the UTF-8 path, so every platform sorts the same way. */
export function comparePaths(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return dec.decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const first = buf[offset] as number;
  // Base-256 sizes mean an entry far over any limit here.
  if (first & 0x80) throw new PackageError("too_large", "an entry in the package is too large");
  const text = readString(buf, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text))
    throw new PackageError("bad_archive", "the package isn't a valid tar");
  return Number.parseInt(text, 8);
}

/** Path as stored in a package: relative, `/`-separated, no `.` or `..` parts. */
export function normalizePath(raw: string, maxLength: number): string {
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (
    p === "" ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.includes("\0") ||
    /^[A-Za-z]:/.test(p) ||
    p.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PackageError("bad_path", `The package has an unsafe path: ${JSON.stringify(raw)}`);
  }
  if (p.length > maxLength) throw new PackageError("bad_path", `The path ${p} is too long`);
  return p;
}

export interface TarLimits {
  maxFiles: number;
  maxBytes: number;
  maxPathLength: number;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number.parseInt(dec.decode(data.subarray(at, space)), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > data.length) {
      throw new PackageError("bad_archive", "the package has a broken extended header");
    }
    const record = dec.decode(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/** Regular files by path. Directories are skipped; links and special files are refused. */
export function readTar(bytes: Uint8Array, limits: TarLimits): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let at = 0;
  let nextPath: string | null = null;
  let nextSize: number | null = null;
  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
    if (sum !== readOctal(header, 148, 8)) {
      throw new PackageError("bad_archive", "the package isn't a valid tar (bad checksum)");
    }
    const type = String.fromCharCode(header[156] as number);
    const meta = type === "x" || type === "g" || type === "L";
    // A pax size describes the entry after the extended headers, never another header.
    const size = (meta ? null : nextSize) ?? readOctal(header, 124, 12);
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new PackageError("bad_archive", "the package is truncated");
    const data = bytes.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const pax = parsePax(data);
      if (pax.path !== undefined) nextPath = pax.path;
      if (pax.size !== undefined) {
        const n = /^\d+$/.test(pax.size) ? Number(pax.size) : Number.NaN;
        if (!Number.isSafeInteger(n)) {
          throw new PackageError("bad_archive", "the package has a broken extended header");
        }
        nextSize = n;
      }
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextPath = readString(data, 0, data.length);
      continue;
    }
    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
    const name = readString(header, 0, 100);
    const rawPath = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = null;
    nextSize = null;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new PackageError(
        "special_file",
        `The package has a link or special file (${rawPath}). Only regular files are allowed`,
      );
    }
    const path = normalizePath(rawPath, limits.maxPathLength);
    if (files.has(path)) throw new PackageError("bad_archive", `${path} appears twice`);
    if (files.size >= limits.maxFiles) {
      throw new PackageError(
        "too_many_files",
        `The package has more than ${limits.maxFiles} files`,
      );
    }
    total += size;
    if (total > limits.maxBytes) {
      throw new PackageError(
        "too_large",
        `The package is over ${Math.round(limits.maxBytes / 1024 / 1024)} MB unpacked`,
      );
    }
    files.set(path, data.slice());
  }
  return files;
}

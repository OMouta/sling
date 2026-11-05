const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Prefixed, time-sortable IDs such as `tsk_01jc...`. 48 bits of milliseconds
 * plus 80 random bits, Crockford base32, like a lowercase ULID.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ALPHABET[(bytes[i] ?? 0) % 32];
  }
  return `${prefix}_${time}${rand}`;
}

/** Branch the Runner creates for a task, for example `sling/k3v9qa-footer-year`. */
export function taskBranch(taskId: string, title: string): string {
  const short = taskId.slice(-6);
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `sling/${short}-${slug}` : `sling/${short}`;
}

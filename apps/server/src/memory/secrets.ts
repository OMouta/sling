/**
 * What a memory may never hold. A memory goes into every prompt, so a secret
 * in one would reach every model the user chats with. The server checks this
 * whoever saves it, the model or the user.
 */

/** Keys and tokens with a known shape. */
const TOKEN_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "a SendGrid key"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "a Telegram bot token"],
  [/\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/, "a Discord bot token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a login token"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, "a login token"],
  [
    /\b(?:api[_ -]?key|secret(?:[_ -]?key)?|access[_ -]?key|auth[_ -]?token|access[_ -]?token|token|client[_ -]?secret)\b\s*(?:is\s+|[:=]\s*)["'`]?[A-Za-z0-9_\-./+=]{12,}/i,
    "an API key or token",
  ],
];

const PASSWORD_WORD = "(?:password|passwd|passcode|passphrase|pwd)";
/** "password: x", "my wifi password is x", "the password for the NAS is x". */
const PASSWORD_AFTER = new RegExp(
  String.raw`\b${PASSWORD_WORD}\b(?:\s+(?:for|to|of|on)\s+[^,.;:\n]{1,40}?)?\s*(?:[:=]|\bis\b|\bwas\b|\bare\b)\s*\S`,
  "i",
);
/** "hunter2 is my password", "use hunter2 as the password", but not "1Password is my password manager". */
const PASSWORD_BEFORE = new RegExp(
  String.raw`\S+\s+(?:is|was|as)\s+(?:my|the|our|their|his|her)\s+(?:[\w-]+\s+){0,3}${PASSWORD_WORD}\b(?!\s+(?:manager|app|vault|keeper|hint|reset)s?\b)`,
  "i",
);
/** "password hunter2", "password 'x'": a password word followed right away by a value. */
const PASSWORD_VALUE = new RegExp(
  String.raw`\b${PASSWORD_WORD}\b\s*["'\`]\S+|\b${PASSWORD_WORD}\b\s+(?=\S*[\d!@#$%^&*])\S{4,}`,
  "i",
);
/** A PIN with its digits. */
const PIN = /\bpin(?:\s+(?:code|number))?\b\s*(?:[:=]|\bis\b|\bwas\b)?\s*\d{4,8}\b/i;

/** Long runs that mix upper and lower case and digits, as generated keys do. */
const KEYLIKE = /[A-Za-z0-9_\-+=]{32,}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 13 to 19 digits, maybe grouped with spaces or dashes, that pass the Luhn check. */
function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function hasKeylikeRun(text: string): boolean {
  for (const m of text.matchAll(KEYLIKE)) {
    const run = m[0];
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

/**
 * Why `text` can't be a memory, in words for whoever tried, or null when it
 * can. It errs on the side of refusing: the user can still say it in a chat.
 */
export function secretReason(text: string): string | null {
  for (const [re, what] of TOKEN_PATTERNS) {
    if (re.test(text)) return `It looks like it holds ${what}, and secrets are never remembered.`;
  }
  if (
    PASSWORD_AFTER.test(text) ||
    PASSWORD_BEFORE.test(text) ||
    PASSWORD_VALUE.test(text) ||
    PIN.test(text)
  ) {
    return "It looks like it holds a password or PIN, and secrets are never remembered.";
  }
  if (hasCardNumber(text)) {
    return "It looks like it holds a card number, and those are never remembered.";
  }
  if (hasKeylikeRun(text)) {
    return "It looks like it holds a key or token, and secrets are never remembered.";
  }
  return null;
}

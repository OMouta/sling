import { MEMORY_PROMPT_BYTES, MEMORY_TEXT_MAX } from "@sling/core";
import { describe, expect, it } from "vitest";
import { BLOCK_HEADER, memoryBlock } from "./block.ts";
import { secretReason } from "./secrets.ts";
import { normalizeMemory } from "./service.ts";

describe("secrets in memories", () => {
  it("refuses keys and tokens by their shape", () => {
    for (const text of [
      "OpenAI key sk-proj-abcdefghijklmnopqrstuvwx1234",
      "Anthropic: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF",
      "stripe sk_live_51HxxxxxxxxxxxxxxxxXYZ",
      "GitHub token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "AWS AKIAIOSFODNN7EXAMPLE",
      "Google AIzaSyA-1234567890abcdefghijklmnopqrstu",
      "slack xoxb-1234567890-abcdefghij",
      "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "the api key is 9f8e7d6c5b4a39281706",
      "token: abcdefghijklmnopqrst",
      "my key Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb",
    ]) {
      expect(secretReason(text), text).not.toBeNull();
    }
  });

  it("refuses passwords and PINs next to their word", () => {
    for (const text of [
      "My bank password is hunter2",
      "wifi password: correct horse battery staple",
      "The password for the NAS is Tr0ub4dor&3",
      "password=letmein",
      "hunter2 is my email password",
      "Use Summer2026! as the password",
      "password 'swordfish'",
      "password hunter2",
      "Passcode is 4821",
      "Their PIN is 4821",
      "card pin 0000",
    ]) {
      expect(secretReason(text), text).toMatch(/password or PIN/);
    }
  });

  it("refuses card numbers that pass Luhn, grouped or not", () => {
    for (const text of [
      "Card 4111 1111 1111 1111",
      "visa 4111-1111-1111-1111 exp 12/29",
      "5500005555555559",
      "Amex 378282246310005",
    ]) {
      expect(secretReason(text), text).toMatch(/card number/);
    }
  });

  it("keeps everyday facts", () => {
    for (const text of [
      "Vegetarian",
      "Jo Silva is their accountant, jo@silva.pt",
      "Phone +351 912 345 678",
      "Uses 1Password for passwords",
      "Prefers a password manager",
      "1Password is their password manager",
      "Lives at Rua Augusta 123, 1100-048 Lisboa",
      "Born 1988-04-12",
      "Order number 4111111111111112 for the sofa",
      "Takes the 07:42 train on weekdays",
      "Pinned the 2024 tax return in Notes",
      "Likes the token ring song",
      "https://calendar.example.com/feeds/family.ics",
    ]) {
      expect(secretReason(text), text).toBeNull();
    }
  });
});

describe("the prompt's memory block", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it("lists memories after the header, most recent first", () => {
    const { text, used } = memoryBlock(["Vegetarian", "Jo Silva is their accountant"]);
    expect(text).toBe(`${BLOCK_HEADER}\n- Vegetarian\n- Jo Silva is their accountant`);
    expect(used).toBe(2);
    expect(memoryBlock([])).toEqual({ text: "", used: 0 });
  });

  it("stays within 6 KB, counting bytes, and keeps the most recent", () => {
    const texts = Array.from({ length: 2000 }, (_, i) => `Fact ${i}: ${"é".repeat(40)}`);
    const { text, used } = memoryBlock(texts);
    expect(bytes(text)).toBeLessThanOrEqual(MEMORY_PROMPT_BYTES);
    expect(used).toBeGreaterThan(50);
    expect(used).toBeLessThan(2000);
    expect(text).toContain("- Fact 0:");
    expect(text).toContain(`- Fact ${used - 1}:`);
    expect(text).not.toContain(`- Fact ${used}:`);
    // Nearly full: one more line wouldn't have fit.
    expect(bytes(text) + bytes(`\n- ${texts[used]}`)).toBeGreaterThan(MEMORY_PROMPT_BYTES);
  });

  it("fits the longest memory, and stops at the first that doesn't fit", () => {
    const long = "x".repeat(MEMORY_TEXT_MAX);
    const { text, used } = memoryBlock([long, "short"], bytes(BLOCK_HEADER) + 510);
    expect(used).toBe(1);
    expect(text.endsWith(long)).toBe(true);
  });

  it("puts a memory on one line", () => {
    expect(normalizeMemory("  Jo Silva\n is their\taccountant  ")).toBe(
      "Jo Silva is their accountant",
    );
  });
});

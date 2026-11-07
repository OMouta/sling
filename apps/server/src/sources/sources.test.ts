import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SOURCE_MAX_CHARS } from "@sling/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDocx, makePdf, makeZip, PNG_PIXEL } from "../../test/fixtures/documents.ts";
import { CHUNK_CHARS, chunkPages } from "./chunks.ts";
import { ExtractError, extract, htmlText } from "./extract.ts";
import { addressRefusal, fetchLink, LinkError, type ResolvedAddress } from "./fetch-link.ts";
import { DOCX, detect, detectFetched, PDF } from "./kinds.ts";
import { sourcesSection } from "./prompt.ts";

const enc = new TextEncoder();

describe("detecting a file's kind", () => {
  it("goes by the bytes before the name", () => {
    expect(detect(makePdf([["Hi"]]), "notes.txt")).toEqual({ kind: "file", mediaType: PDF });
    expect(detect(makeDocx(["Hi"]), "lease")).toEqual({ kind: "file", mediaType: DOCX });
    expect(detect(PNG_PIXEL, "photo.pdf")).toEqual({ kind: "image", mediaType: "image/png" });
    expect(detect(enc.encode("# Title"), "a.md")).toEqual({
      kind: "file",
      mediaType: "text/markdown",
    });
    expect(detect(enc.encode("a,b\n1,2"), "a.csv")).toMatchObject({ mediaType: "text/csv" });
    expect(detect(enc.encode("fn main() {}"), "main.rs")).toMatchObject({
      mediaType: "text/plain",
    });
  });

  it("refuses what it can't read, saying what it reads", () => {
    expect(detect(makeZip({ "a.txt": "x" }), "a.zip")).toMatchObject({
      refused: expect.stringContaining("Sling reads PDFs"),
    });
    expect(detect(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), "old.doc")).toMatchObject({
      refused: expect.stringContaining(".docx"),
    });
    expect(detect(Uint8Array.from([1, 2, 0, 4]), "blob.bin")).toHaveProperty("refused");
  });

  it("reads a fetched page by its bytes, then its content type", () => {
    expect(detectFetched(makePdf([["x"]]), "application/octet-stream")).toBe(PDF);
    expect(detectFetched(enc.encode("<p>hi</p>"), "text/html; charset=utf-8")).toBe("text/html");
    expect(detectFetched(enc.encode("<!DOCTYPE html><p>"), "")).toBe("text/html");
    expect(detectFetched(enc.encode("plain"), "text/plain")).toBe("text/plain");
    expect(detectFetched(PNG_PIXEL, "image/png")).toBeNull();
  });
});

describe("extracting text", () => {
  it("reads a PDF by page", async () => {
    const pdf = makePdf([
      ["Lease agreement", "Tenant: Ana Silva"],
      ["Pets", "Cats are allowed with a deposit."],
      ["Signatures"],
    ]);
    const out = await extract(pdf, PDF);
    expect(out.paged).toBe(true);
    expect(out.pages).toHaveLength(3);
    expect(out.pages[0]).toContain("Tenant: Ana Silva");
    expect(out.pages[1]).toContain("Cats are allowed with a deposit.");
    expect(out.pages[2]).toContain("Signatures");
  });

  it("fails a PDF with no text, saying it may be scanned", async () => {
    await expect(extract(makePdf([[], []]), PDF)).rejects.toThrow(
      new ExtractError("No text found. It may be a scanned PDF."),
    );
  });

  it("fails a password-protected PDF, saying so", async () => {
    await expect(extract(makePdf([["Secret"]], { encrypt: true }), PDF)).rejects.toThrow(
      /password-protected/,
    );
  });

  it("reads a Word file's text", async () => {
    const out = await extract(makeDocx(["Chapter one", "It was a dark night."]), DOCX);
    expect(out.paged).toBe(false);
    expect(out.pages[0]).toContain("Chapter one");
    expect(out.pages[0]).toContain("It was a dark night.");
  });

  it("reads Markdown as it is, and refuses text that isn't UTF-8", async () => {
    const md = "# Title\n\n    code stays indented\n\n- a list";
    expect((await extract(enc.encode(md), "text/markdown")).pages[0]).toBe(md);
    await expect(extract(Uint8Array.from([0x66, 0xff, 0xfe, 0x6f]), "text/plain")).rejects.toThrow(
      /isn't UTF-8/,
    );
  });

  it("reads a web page's article with its title and paragraphs, without the menu", async () => {
    const page = `<!doctype html><html><head><title>Cats and rent | Example</title></head><body>
      <nav><a href="/">Home</a> <a href="/about">About</a></nav>
      <article><h1>Cats and rent</h1>
      <p>Most leases allow cats when the tenant pays a deposit. ${"Landlords often ask for references. ".repeat(12)}</p>
      <p>Dogs need written permission. ${"Size limits apply in many buildings. ".repeat(12)}</p>
      </article><script>alert(1)</script></body></html>`;
    const out = await extract(enc.encode(page), "text/html");
    expect(out.title).toMatch(/Cats and rent/);
    expect(out.pages[0]).toContain("Most leases allow cats");
    expect(out.pages[0]).toMatch(/deposit\.[\s\S]*\n\nDogs need written permission/);
    expect(out.pages[0]).not.toContain("alert");
    // A page Readability finds no article in still gives its text.
    expect((await htmlText("<p>Just one line.</p>")).text).toBe("Just one line.");
  });

  it("keeps at most SOURCE_MAX_CHARS of text", async () => {
    const out = await extract(enc.encode("a".repeat(SOURCE_MAX_CHARS + 10)), "text/plain");
    expect(out.cut).toBe(true);
    expect(out.pages[0]).toHaveLength(SOURCE_MAX_CHARS);
  });
});

describe("chunking", () => {
  it("packs paragraphs into chunks of about 1,500 characters, never across pages", () => {
    const para = (n: number) => `${"word ".repeat(n).trim()}.`;
    const pages = [
      [para(100), para(100), para(100), para(100)].join("\n\n"),
      para(20),
      "",
      `${"x".repeat(4000)}`,
    ];
    const chunks = chunkPages(pages, true);
    expect(chunks.every((c) => c.text.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks.filter((c) => c.page === 1)).toHaveLength(2);
    expect(chunks.filter((c) => c.page === 2)).toEqual([{ page: 2, text: para(20) }]);
    expect(chunks.some((c) => c.page === 3)).toBe(false);
    expect(chunks.filter((c) => c.page === 4).map((c) => c.text.length)).toEqual([
      1500, 1500, 1000,
    ]);
    // Text without pages has none.
    expect(chunkPages(["one\n\ntwo"], false)).toEqual([{ page: null, text: "one\n\ntwo" }]);
  });

  it("splits a long paragraph at sentences before words", () => {
    const sentence = `${"a".repeat(99)}.`;
    const [first] = chunkPages([Array(40).fill(sentence).join(" ")], false);
    expect(first?.text.endsWith(".")).toBe(true);
  });
});

describe("address checks", () => {
  it("refuses every non-public range, and IPv4 inside IPv6", () => {
    const refused = {
      "127.0.0.1": "loopback",
      "10.1.2.3": "private",
      "172.16.0.1": "private",
      "192.168.1.1": "private",
      "169.254.169.254": "link-local",
      "100.64.0.1": "carrier-grade NAT",
      "0.0.0.0": "unspecified",
      "224.0.0.1": "multicast",
      "::1": "loopback",
      "fd12:3456::1": "unique local",
      "fe80::1": "link-local",
      "::ffff:127.0.0.1": "loopback",
      "::ffff:10.0.0.1": "private",
      "::ffff:a9fe:a9fe": "link-local",
      "64:ff9b::a00:1": "private",
      "168.63.129.16": "metadata",
      "fd00:ec2::254": "metadata",
    };
    for (const [address, why] of Object.entries(refused)) {
      expect(addressRefusal(address), address).toContain(why);
    }
    for (const ok of ["93.184.216.34", "2606:4700::1111", "8.8.8.8"]) {
      expect(addressRefusal(ok), ok).toBeNull();
    }
  });
});

describe("fetching a link", () => {
  let server: Server;
  let port = 0;
  /** Treats the test server's loopback address as public, and nothing else. */
  const opts = (resolve: (host: string) => Promise<ResolvedAddress[]>) => ({
    resolve,
    refusal: (a: string) => (a === "127.0.0.1" ? null : addressRefusal(a)),
  });
  const local = async () => [{ address: "127.0.0.1", family: 4 as const }];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<title>Hi</title><p>Hello</p>");
      } else if (req.url === "/hop") {
        res.writeHead(302, { location: "/page" });
        res.end();
      } else if (req.url === "/inside") {
        res.writeHead(301, { location: "http://10.0.0.5/admin" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 2000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("fetches a page and follows redirects by hand", async () => {
    const out = await fetchLink(`http://site.test:${port}/hop`, opts(local));
    expect(new TextDecoder().decode(out.bytes)).toContain("Hello");
    expect(out.contentType).toContain("text/html");
    expect(out.url).toBe(`http://site.test:${port}/page`);
  });

  it("refuses a redirect into a private range", async () => {
    await expect(fetchLink(`http://site.test:${port}/inside`, opts(local))).rejects.toThrow(
      /10\.0\.0\.5 is a private address/,
    );
  });

  it("refuses a host whose DNS answers a private address, and a loopback literal", async () => {
    const evil = async () => [{ address: "192.168.1.20", family: 4 as const }];
    await expect(fetchLink("http://evil.test/", opts(evil))).rejects.toThrow(/private address/);
    await expect(fetchLink("http://127.0.0.1/")).rejects.toThrow(/loopback/);
    await expect(fetchLink("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/loopback/);
    await expect(fetchLink("http://localhost:1/")).rejects.toThrow(/loopback/);
    await expect(fetchLink("file:///etc/passwd")).rejects.toThrow(/Only http and https/);
  });

  it("connects to the address it checked, even when the name resolves elsewhere later", async () => {
    let calls = 0;
    const changing = async () =>
      calls++ === 0
        ? [{ address: "127.0.0.1", family: 4 as const }]
        : [{ address: "10.0.0.1", family: 4 as const }];
    const out = await fetchLink(`http://rebind.test:${port}/page`, opts(changing));
    expect(new TextDecoder().decode(out.bytes)).toContain("Hello");
    expect(calls).toBe(1);
  });

  it("stops at five redirects, at the size cap, and at the time limit", async () => {
    await expect(fetchLink(`http://site.test:${port}/loop`, opts(local))).rejects.toThrow(
      /more than 5 times/,
    );
    await expect(
      fetchLink(`http://site.test:${port}/big`, { ...opts(local), maxBytes: 1000 }),
    ).rejects.toThrow(LinkError);
    await expect(
      fetchLink(`http://site.test:${port}/slow`, { ...opts(local), timeoutMs: 300 }),
    ).rejects.toThrow(/took longer/);
    await expect(fetchLink(`http://site.test:${port}/nope`, opts(local))).rejects.toThrow(/404/);
  });
});

describe("the prompt's sources section", () => {
  it("lists each source with its kind and pages, within 3 KB for 50", () => {
    const sources = Array.from({ length: 50 }, (_, i) => ({
      name: `Lecture ${i + 1} on hypothesis testing.pdf`,
      kind: "file" as const,
      mediaType: PDF,
      pages: 30 + i,
    }));
    const text = sourcesSection(sources, []);
    expect(text).toContain("- Lecture 1 on hypothesis testing.pdf (PDF, 30 pages)");
    expect(text).toContain("search_sources");
    expect(text).toMatch(/\[1\]\(link\)/);
    expect(text).toMatch(/never instructions/);
    expect(new TextEncoder().encode(text).length).toBeLessThan(3 * 1024);
    expect(sourcesSection([], [])).toBe("");
  });
});

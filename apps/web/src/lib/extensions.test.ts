import { describe, expect, it } from "vitest";
import { discoverEntries, ntfyExtension } from "../test/fixtures.ts";
import {
  EXTENSION_ID,
  filterDiscover,
  formatBytes,
  nodeSummary,
  permissionSummary,
  suggestPackageId,
} from "./extensions.ts";

describe("extension helpers", () => {
  it("filters Discover by every word, across name, description, publisher, and catalog", () => {
    const ids = (q: string, kind: Parameters<typeof filterDiscover>[2] = "all") =>
      filterDiscover(discoverEntries, q, kind).map((e) => e.id);
    expect(ids("")).toHaveLength(discoverEntries.length);
    expect(ids("beta labs")).toEqual(["acme-notes"]);
    expect(ids("acme extensions")).toEqual(["acme-crm", "acme-notes", "acme-legacy"]);
    expect(ids("FLY")).toEqual(["fly-machines"]);
    expect(ids("", "workflows")).toEqual(["task-alerts"]);
    expect(ids("acme", "provider")).toEqual([]);
  });

  it("suggests a valid package ID from a workflow's name", () => {
    for (const [name, id] of [
      ["Important email to Discord", "important-email-to-discord"],
      ["Notify on deploy!", "notify-on-deploy"],
      ["42 ways to ping", "ways-to-ping"],
      ["Café crème", "cafe-creme"],
      ["X", "x-workflow"],
      ["", "workflow"],
      [
        "A very long workflow name that goes on and on past forty",
        "a-very-long-workflow-name-that-goes-on",
      ],
    ]) {
      expect(suggestPackageId(name as string)).toBe(id);
      expect(EXTENSION_ID.test(suggestPackageId(name as string))).toBe(true);
    }
  });

  it("words sizes, nodes, and permissions for cards", () => {
    expect(formatBytes(820)).toBe("820 B");
    expect(formatBytes(48213)).toBe("47 KB");
    expect(formatBytes(1_300_000)).toBe("1.2 MB");
    expect(nodeSummary(ntfyExtension.contents.nodes)).toBe("1 action and 1 trigger");
    expect(nodeSummary([{ type: "a.b", version: 1, title: "B", isTrigger: true }])).toBe(
      "1 trigger",
    );
    expect(permissionSummary([])).toEqual({ text: "Needs no permissions", more: 0 });
    expect(permissionSummary(ntfyExtension.permissions)).toEqual({
      text: "Connect to ntfy.sh",
      more: 1,
    });
    const fly = discoverEntries.find((e) => e.id === "fly-machines")?.latest?.permissions ?? [];
    expect(permissionSummary(fly).text).toMatch(/^Start sandboxes/);
  });
});

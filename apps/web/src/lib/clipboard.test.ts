// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.ts";

function withClipboard(clipboard: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

/** Stands in for the copy command, recording what was selected when it ran. */
function copyCommand(result = true) {
  const selected: string[] = [];
  const exec = vi.fn((command: string) => {
    const field = document.activeElement as HTMLTextAreaElement;
    if (command === "copy")
      selected.push(field.value.slice(field.selectionStart, field.selectionEnd));
    return result;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  return { exec, selected };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("copying text", () => {
  it("uses the Clipboard API where the page has it", async () => {
    const writeText = vi.fn(async () => {});
    withClipboard({ writeText });
    const { exec } = copyCommand();
    expect(await copyText("sling-runner pair")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("sling-runner pair");
    expect(exec).not.toHaveBeenCalled();
  });

  it("selects the text and runs the copy command on plain HTTP, where there's no Clipboard API", async () => {
    withClipboard(undefined);
    const { selected } = copyCommand();
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    expect(await copyText("curl -fsSL http://192.168.1.20:8080/install.sh | sh")).toBe(true);
    expect(selected).toEqual(["curl -fsSL http://192.168.1.20:8080/install.sh | sh"]);
    // The hidden field is gone and the button keeps focus.
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("falls back to the copy command when the Clipboard API refuses", async () => {
    withClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("not allowed"))) });
    const { selected } = copyCommand();
    expect(await copyText("K7QM-2XVD-HP4R")).toBe(true);
    expect(selected).toEqual(["K7QM-2XVD-HP4R"]);
  });

  it("says so when nothing could copy", async () => {
    withClipboard(undefined);
    copyCommand(false);
    expect(await copyText("x")).toBe(false);
  });
});

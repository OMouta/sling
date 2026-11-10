// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./components/Composer.tsx";
import { useDictation } from "./lib/dictation.ts";

const sent: string[] = [];

function Harness() {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation(text, setText);
  return (
    <Composer
      variant="reply"
      text={text}
      setText={setText}
      onSubmit={() => sent.push(text)}
      inputRef={input}
      dictation={dictation}
      placeholder="Message Sling"
      busy={false}
      controls={null}
    />
  );
}

/** A screen whose main pointer is a finger, or a mouse. Width doesn't matter. */
function pointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query === "(pointer: coarse)" ? coarse : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

const box = () => screen.getByRole("textbox", { name: "Message" });
const enter = (shiftKey = false) => fireEvent.keyDown(box(), { key: "Enter", shiftKey });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe("Enter in the composer", () => {
  it("sends with a mouse, and Shift+Enter doesn't", () => {
    pointer(false);
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "first line" } });
    expect(enter(true)).toBe(true);
    expect(sent).toEqual([]);
    expect(enter()).toBe(false);
    expect(sent).toEqual(["first line"]);
  });

  it("adds a line on a touch screen, and the send button sends", () => {
    pointer(true);
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "first line" } });
    // Not prevented, so the keyboard puts in its new line.
    expect(enter()).toBe(true);
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual(["first line"]);
  });
});

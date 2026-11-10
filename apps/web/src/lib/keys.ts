import type { KeyboardEvent } from "react";

/** Whether the main pointer is a finger, as on a phone or tablet, whatever the screen's width. */
function touchFirst(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Whether a key sends what's typed in a message box. With a mouse, Enter
 * sends and Shift+Enter adds a line. A touch keyboard has no Shift+Enter, so
 * there Enter adds a line and the send button sends.
 */
export function sendsOnEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchFirst();
}

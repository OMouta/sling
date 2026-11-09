// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearDrafts, useDraft, useSendId } from "./drafts.ts";

afterEach(() => sessionStorage.clear());

describe("drafts", () => {
  it("keeps each chat's text apart, and brings it back after switching or reloading", () => {
    const { result, rerender, unmount } = renderHook(({ id }) => useDraft(id), {
      initialProps: { id: "cnv_1" },
    });
    act(() => result.current[1]("half a thought"));
    rerender({ id: "cnv_2" });
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("another"));
    rerender({ id: "cnv_1" });
    expect(result.current[0]).toBe("half a thought");
    unmount();

    // A reload starts the page over; this tab's storage still has it.
    const again = renderHook(() => useDraft("cnv_2"));
    expect(again.result.current[0]).toBe("another");
  });

  it("forgets a draft once it's cleared, and every draft on sign-out", () => {
    const { result } = renderHook(() => useDraft("cnv_1"));
    act(() => result.current[1]("sent soon"));
    act(() => result.current[1](""));
    expect(sessionStorage.length).toBe(0);

    act(() => result.current[1]("left behind"));
    sessionStorage.setItem("sling.theme", "dark");
    clearDrafts();
    expect(renderHook(() => useDraft("cnv_1")).result.current[0]).toBe("");
    expect(sessionStorage.getItem("sling.theme")).toBe("dark");
  });
});

describe("send IDs", () => {
  it("keeps the ID for the same message sent again, and gives a new one otherwise", () => {
    const { result } = renderHook(() => useSendId());
    const first = result.current.take("hello");
    expect(result.current.take("hello")).toBe(first);
    const edited = result.current.take("hello!");
    expect(edited).not.toBe(first);
    result.current.done();
    // The same words after a message went out are a new message.
    expect(result.current.take("hello!")).not.toBe(edited);
  });
});

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Dialog, Menu, MenuItem, TabPanel, Tabs } from "./ui.tsx";

afterEach(cleanup);

function Opener({ inner = false, menu = false }: { inner?: boolean; menu?: boolean }) {
  const [open, setOpen] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind</button>
      {open && (
        <Dialog
          title="Rename"
          onClose={() => setOpen(false)}
          footer={
            <>
              {inner && <Button onClick={() => setSecond(true)}>More</Button>}
              <Button onClick={() => setOpen(false)}>Done</Button>
            </>
          }
        >
          <input aria-label="Name" />
          {menu && (
            <Menu
              label="Options"
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle}>
                  Options
                </button>
              )}
            >
              <MenuItem onSelect={() => {}}>First</MenuItem>
            </Menu>
          )}
        </Dialog>
      )}
      {second && (
        <Dialog title="Sure?" onClose={() => setSecond(false)}>
          <p>Nothing to type here.</p>
        </Dialog>
      )}
    </main>
  );
}

const key = (k: string, shift = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, shiftKey: shift });

describe("dialogs", () => {
  it("starts on the first field, keeps Tab inside, and goes back to its opener", () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));

    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    key("Tab");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    key("Tab", true);
    expect(document.activeElement).toBe(done);

    // The page behind can't be reached while it's open.
    expect(screen.getByRole("button", { name: "Behind" }).closest("[inert]")).not.toBeNull();
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("button", { name: "Behind" }).closest("[inert]")).toBeNull();
  });

  it("focuses the panel when there's nothing to type, and Escape closes only the top one", () => {
    render(<Opener inner />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const more = screen.getByRole("button", { name: "More" });
    more.focus();
    fireEvent.click(more);
    const [first, second] = screen.getAllByRole("dialog");
    expect(document.activeElement).toBe(second);
    // The first dialog waits behind the second.
    expect(first?.closest("[inert]")).not.toBeNull();

    key("Escape");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(more);
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets Escape close a menu inside without closing the dialog", () => {
    render(<Opener menu />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Focus goes back to what opened the menu.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Options" }));
  });
});

function Tabbed() {
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  return (
    <TabPanel.Provider value="panel">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "a", label: "All" },
          { id: "b", label: "Busy" },
          { id: "c", label: "Closed" },
        ]}
      />
      <div role="tabpanel" id="panel" aria-labelledby="panel-tab">
        {tab}
      </div>
    </TabPanel.Provider>
  );
}

describe("tabs", () => {
  it("moves and selects with the arrow keys, Home and End, and names the panel", () => {
    render(<Tabbed />);
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect(tab("All").tabIndex).toBe(0);
    expect(tab("Busy").tabIndex).toBe(-1);
    expect(tab("All").getAttribute("aria-controls")).toBe("panel");
    expect(screen.getByRole("tabpanel", { name: "All" })).toBeTruthy();

    tab("All").focus();
    key("ArrowRight");
    expect(tab("Busy").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Busy"));
    expect(screen.getByRole("tabpanel", { name: "Busy" })).toBeTruthy();
    key("End");
    expect(document.activeElement).toBe(tab("Closed"));
    key("ArrowRight");
    expect(document.activeElement).toBe(tab("All"));
    key("ArrowLeft");
    expect(document.activeElement).toBe(tab("Closed"));
    key("Home");
    expect(tab("All").getAttribute("aria-selected")).toBe("true");
  });
});

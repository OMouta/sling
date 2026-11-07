// @vitest-environment happy-dom
import type { AssistantChoice, ModelCatalogView, PersonalityView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./components/Composer.tsx";
import { MentionList } from "./components/MentionList.tsx";
import { MentionText } from "./components/MentionText.tsx";
import { PersonalityModel } from "./components/PersonalityModel.tsx";
import { useDictation } from "./lib/dictation.ts";
import { mentionAt, replyAuthor, useMention } from "./lib/mentions.ts";

const model = (id: string, label: string) => ({
  id,
  label,
  description: "",
  efforts: ["low", "high"],
  defaultEffort: "low",
  fast: false,
});
const catalog: ModelCatalogView = {
  assistant: [
    {
      provider: "claude-code",
      kind: "cli",
      label: "Claude Code",
      connected: true,
      machines: ["devbox"],
      login: null,
      error: null,
      models: [model("claude-haiku-5-5", "Claude Haiku 5.5"), model("claude-opus-5-5", "Opus 5.5")],
    },
  ],
  agents: [],
  defaults: {
    assistant: { provider: "claude-code", model: "claude-opus-5-5", effort: null, fast: false },
    agent: { harness: "codex", model: null, effort: null, fast: false },
  },
};

const person = (id: string, name: string, color: PersonalityView["color"]): PersonalityView => ({
  id,
  name,
  description: name === "Chef" ? "Recipes." : "",
  instructions: `You are ${name}.`,
  tools: [],
  color,
  shape: "bloom",
  assistant: null,
  isDefault: false,
  position: 0,
  revision: 1,
  templateKey: null,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});
const writer = person("prs_writer", "Writer", "orange");
const coach = person("prs_coach", "Language coach", "blue");
const chef = person("prs_chef", "Chef", "pink");

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/api/models") return Response.json(catalog);
      return Response.json(null);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function wrapRouted(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The picker links to Machines when nothing can chat.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------- model

function ModelHarness({
  start,
  onChange,
}: {
  start: AssistantChoice | null;
  onChange: (c: unknown) => void;
}) {
  const [value, setValue] = useState(start);
  return (
    <PersonalityModel
      value={value}
      onChange={(c) => {
        onChange(c);
        setValue(c);
      }}
    />
  );
}

describe("a personality's Model section", () => {
  it("starts on the workspace default, listed first in the chat's picker", async () => {
    const changes: unknown[] = [];
    wrapRouted(<ModelHarness start={null} onChange={(c) => changes.push(c)} />);
    expect(await screen.findByRole("heading", { name: "Model" })).toBeTruthy();
    const pill = await screen.findByRole("button", { name: "Model: Workspace default" });
    // Its icon is the default's, once the models are in.
    await waitFor(() => expect(pill.querySelector("svg, img")).toBeTruthy());
    fireEvent.click(pill);
    const options = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Workspace defaultOpus 5.5",
      "Claude Haiku 5.5",
      "Opus 5.5",
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    // No mode here: it's only the model.
    expect(screen.queryByRole("button", { name: /Permission mode/ })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Claude Haiku 5.5/ }));
    expect(changes.at(-1)).toMatchObject({ provider: "claude-code", model: "claude-haiku-5-5" });
    expect(screen.getByRole("button", { name: "Model: Haiku 5.5, Low" })).toBeTruthy();
  });

  it("goes back to the default from the keyboard", async () => {
    const changes: unknown[] = [];
    wrapRouted(
      <ModelHarness
        start={{ provider: "claude-code", model: "claude-haiku-5-5", effort: null, fast: false }}
        onChange={(c) => changes.push(c)}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Model: Haiku 5.5/ }));
    await screen.findAllByRole("option", { name: /Opus 5.5/ });
    const dialog = screen.getByRole("dialog", { name: "Choose a model" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(changes).toEqual([null]);
    expect(screen.getByRole("button", { name: "Model: Workspace default" })).toBeTruthy();
    // A search that doesn't match it leaves it out.
    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), {
      target: { value: "opus" },
    });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Opus 5.5"]);
  });
});

// ---------------------------------------------------------------- mentions

const sent: { text: string; personalityId?: string }[] = [];

function MentionHarness() {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation(text, setText);
  const mention = useMention({
    text,
    setText,
    inputRef: input,
    personalities: [writer, coach, chef],
  });
  return (
    <>
      <Composer
        variant="reply"
        text={text}
        setText={setText}
        onSubmit={() => {
          sent.push({
            text,
            ...(mention.mentioned ? { personalityId: mention.mentioned.id } : {}),
          });
          setText("");
        }}
        inputRef={input}
        dictation={dictation}
        placeholder="Message Sling"
        busy={false}
        controls={null}
        overlay={<MentionList mention={mention} />}
        onKeyDown={mention.onKeyDown}
      />
      <p data-testid="mentioned">{mention.mentioned?.name ?? "nobody"}</p>
    </>
  );
}

describe("@mentions", () => {
  const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  const type = (value: string) => {
    box().focus();
    fireEvent.change(box(), { target: { value } });
  };
  const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
  const selected = () =>
    screen
      .queryAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true")
      ?.textContent?.replace(/Recipes\.$/, "");
  const mentioned = () => screen.getByTestId("mentioned").textContent;
  const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  beforeEach(() => {
    sent.length = 0;
  });

  it("lists the others when @ starts a word, filtered as you type", () => {
    wrap(<MentionHarness />);
    type("email@");
    expect(options()).toEqual([]);
    type("Make this a poem @");
    expect(options()).toEqual(["Writer", "Language coach", "ChefRecipes."]);
    type("Make this a poem @co");
    expect(options()).toEqual(["Language coach"]);
    type("Make this a poem @language c");
    expect(options()).toEqual(["Language coach"]);
    type("Make this a poem @zed");
    expect(options()).toEqual([]);
  });

  it("moves with the arrows, picks with Enter or Tab, and closes on Escape", async () => {
    wrap(<MentionHarness />);
    type("@");
    expect(selected()).toBe("Writer");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(selected()).toBe("Language coach");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(selected()).toBe("Chef");
    // Enter picks; it doesn't send.
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(box().value).toBe("@Chef ");
    expect(mentioned()).toBe("Chef");
    expect(sent).toEqual([]);
    expect(options()).toEqual([]);

    type("@Chef make it short @wr");
    fireEvent.keyDown(box(), { key: "Tab" });
    await flush();
    // One mention per message: Writer takes Chef's place.
    expect(box().value).toBe("make it short @Writer ");
    expect(mentioned()).toBe("Writer");

    type("make it short @Writer and @");
    expect(options()).toHaveLength(3);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(options()).toEqual([]);
  });

  it("picks by tap, sends the mention, and drops it with its text", async () => {
    wrap(<MentionHarness />);
    type("@");
    fireEvent.click(screen.getByRole("option", { name: /Language coach/ }));
    await flush();
    expect(box().value).toBe("@Language coach ");
    type("@Language coach say hi in French");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(sent).toEqual([{ text: "@Language coach say hi in French", personalityId: coach.id }]);

    type("@");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(mentioned()).toBe("Writer");
    type("@Writ");
    expect(mentioned()).toBe("nobody");
  });

  it("finds the @ word at the caret", () => {
    expect(mentionAt("hi @wr", 6)).toEqual({ start: 3, end: 6, text: "wr" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, text: "" });
    expect(mentionAt("a@b", 3)).toBeNull();
    expect(mentionAt("hi @wr there", 6)).toEqual({ start: 3, end: 6, text: "wr" });
  });
});

describe("a mention in the chat", () => {
  it("colors the @Name in the user's message", () => {
    render(<MentionText text="Hey @Writer, a poem" personality={writer} />);
    const name = screen.getByText("@Writer");
    expect(name.getAttribute("style")).toContain("var(--p-orange)");
  });

  it("names a reply by the personality in its trace", () => {
    const sling = person("prs_sling", "Sling", "violet");
    const reply = (id?: string) => ({ trace: id ? { personality: { id } } : null });
    expect(replyAuthor(reply(writer.id), [writer, chef], sling)).toBe(writer);
    expect(replyAuthor(reply(sling.id), [writer, chef], sling)).toBe(sling);
    expect(replyAuthor(reply(), [writer], sling)).toBe(sling);
    // Deleted since: shown as the chat's own.
    expect(replyAuthor(reply("prs_gone"), [writer], sling)).toBe(sling);
  });
});

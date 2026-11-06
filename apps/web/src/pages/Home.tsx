import type {
  AssistantChoice,
  ConversationView,
  PermissionMode,
  RunnerView,
  TaskView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ArrowUp, Check, ChevronDown, Cpu, Laptop } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useModeChange } from "../components/ConfirmFullAccess.tsx";
import { Logo } from "../components/Logo.tsx";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { TaskStateBadge } from "../components/TaskCard.tsx";
import { Button, Card, cx, ErrorText, Kbd } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { machinesOnly } from "../lib/machines.ts";
import { CHAT_WIDTH, useModelCatalog } from "../lib/models.ts";
import { NEW_CHAT_EVENT } from "../lib/newChat.ts";
import type { Settings } from "../lib/types.ts";

export function HomePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
  });
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<TaskView[]>("/api/tasks"),
  });
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const catalog = useModelCatalog();
  // "New chat" lands here; the composer takes the focus, keeping any draft.
  useEffect(() => {
    const focus = () => input.current?.focus({ preventScroll: true });
    window.addEventListener(NEW_CHAT_EVENT, focus);
    return () => window.removeEventListener(NEW_CHAT_EVENT, focus);
  }, []);
  // Unset means "the workspace default", so a default changed elsewhere still applies.
  const [assistant, setAssistant] = useState<AssistantChoice | undefined>();
  const [mode, setMode] = useState<PermissionMode | undefined>();
  const modeChange = useModeChange(setMode);

  const start = useMutation({
    mutationFn: async (message: string) => {
      const c = await api.post<ConversationView>("/api/conversations");
      if (mode || assistant) {
        await api.patch(`/api/conversations/${c.id}`, {
          ...(mode ? { mode } : {}),
          ...(assistant ? { settings: { assistant } } : {}),
        });
      }
      await api.post(`/api/conversations/${c.id}/messages`, { text: message });
      return c;
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void navigate({ to: "/c/$id", params: { id: c.id } });
    },
  });

  const machines = machinesOnly(runners.data ?? []);
  const hasMachine = machines.length > 0;
  // A machine's logged-in CLI is enough to chat; an API key is the other way.
  const hasModel = Boolean(catalog.data?.defaults.assistant) || Boolean(settings.data?.model);
  const ready = hasModel && hasMachine;
  // The composer is disabled until Sling knows it can chat, so focus it then.
  useEffect(() => {
    if (ready) input.current?.focus({ preventScroll: true });
  }, [ready]);
  const recent = (tasks.data ?? []).slice(0, 5);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && !start.isPending) start.mutate(text.trim());
  }

  return (
    <Page title="Chat">
      {/* The first screen: a greeting, then the composer at the bottom. Recent tasks sit below it. */}
      <div className="flex min-h-full flex-col">
        <div className={cx("mx-auto flex w-full flex-1 flex-col px-5", CHAT_WIDTH)}>
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <span className="mb-4 grid size-11 place-items-center rounded-xl bg-accent text-white shadow-primary">
              <Logo className="size-6" />
            </span>
            <h2 className="text-2xl font-medium tracking-tight text-balance">
              What should we work on?
            </h2>
            <p className="mt-1.5 max-w-md text-[13px] leading-5 text-pretty text-muted">
              Sling runs commands on your machines and hands coding work to your coding agent, there
              or in a fresh sandbox.
            </p>
            {!ready && settings.isSuccess && runners.isSuccess && (
              <Card className="mt-6 w-full max-w-xl divide-y divide-border text-left">
                <Step
                  done={hasMachine}
                  n={1}
                  icon={Laptop}
                  title="Pair a machine"
                  to="/machines"
                  search={{ pair: true }}
                >
                  The computer that has your repos and a coding agent logged in, Codex or Claude
                  Code. Sling chats and codes through it, on your own subscription.
                </Step>
                <Step
                  done={hasModel}
                  n={2}
                  icon={Cpu}
                  title="Log in to a coding agent"
                  to="/machines"
                >
                  Run codex login or claude auth login on that machine. No API key needed.
                </Step>
              </Card>
            )}
          </div>

          <form onSubmit={submit}>
            <div
              className={cx(
                "rounded-2xl bg-surface shadow-card transition-shadow duration-150 has-[textarea:focus]:shadow-focus",
                !ready && "opacity-60",
              )}
            >
              <textarea
                ref={input}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) submit(e);
                }}
                aria-label="Message"
                placeholder="The footer year in site is hardcoded. Make it dynamic and add a test."
                className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm leading-6 outline-none placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed"
                disabled={!ready}
              />
              <div className="flex items-center gap-2 px-2 pt-1 pb-2">
                <ChatControls
                  className="min-w-0 flex-1"
                  catalog={catalog.data}
                  assistant={assistant ?? catalog.data?.defaults.assistant ?? null}
                  onAssistant={setAssistant}
                  mode={mode ?? settings.data?.defaultMode ?? "auto"}
                  onMode={modeChange.change}
                />
                <div className="flex shrink-0 items-center gap-2">
                  <ErrorText error={start.error} />
                  <Button
                    type="submit"
                    variant="primary"
                    icon={ArrowUp}
                    busy={start.isPending}
                    disabled={!ready || !text.trim()}
                  >
                    Start
                  </Button>
                </div>
              </div>
            </div>
          </form>
          <div className="flex items-center justify-between gap-3 px-1 pt-2 pb-5 text-xs text-subtle">
            <span className="flex items-center gap-1 max-sm:hidden">
              <Kbd>↵</Kbd> to send, <Kbd>⇧</Kbd>
              <Kbd>↵</Kbd> for a new line
            </span>
            {recent.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  document.getElementById("recent-tasks")?.scrollIntoView({ behavior: "smooth" })
                }
                className="ml-auto flex cursor-pointer items-center gap-1 transition-colors duration-150 hover:text-text"
              >
                Recent tasks <ChevronDown aria-hidden="true" size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
      {modeChange.dialog}

      {recent.length > 0 && (
        <section
          id="recent-tasks"
          aria-label="Recent tasks"
          className={cx("mx-auto w-full scroll-mt-4 px-5 pt-4 pb-16", CHAT_WIDTH)}
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="section-label">Recent tasks</span>
            <Link
              to="/tasks"
              className="flex items-center gap-1 text-xs text-subtle transition-colors duration-150 hover:text-text"
            >
              All tasks <ArrowRight aria-hidden="true" size={12} />
            </Link>
          </div>
          <Card className="divide-y divide-border overflow-hidden">
            {recent.map((t) => (
              <Link
                key={t.id}
                to="/tasks/$id"
                params={{ id: t.id }}
                className="flex h-11 items-center gap-3 px-4 transition-colors duration-150 hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                <span className="text-xs text-subtle max-sm:hidden">{t.repoName}</span>
                <TaskStateBadge task={t} />
                <span className="tabular w-20 text-right text-xs text-subtle">
                  {ago(t.createdAt)}
                </span>
              </Link>
            ))}
          </Card>
        </section>
      )}
    </Page>
  );
}

function Step({
  done,
  n,
  icon: Icon,
  title,
  to,
  search,
  children,
}: {
  done: boolean;
  n: number;
  icon: typeof Cpu;
  title: string;
  to: string;
  search?: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          done
            ? "bg-[var(--tag-green-bg)] text-[var(--tag-green-text)] shadow-[inset_0_0_0_1px_var(--tag-green-border)]"
            : "bg-surface-2 text-icon shadow-raised",
        )}
      >
        {done ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
        <span className="sr-only">{done ? "Done:" : `Step ${n}:`}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("text-[13px] font-medium", done && "text-muted line-through")}>{title}</p>
        <p className="text-xs leading-4 text-muted">{children}</p>
      </div>
      {!done && (
        <Link
          to={to}
          search={search as never}
          className="pressable flex h-[26px] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs font-medium shadow-raised hover:shadow-raised-hover"
        >
          Set up <ArrowRight aria-hidden="true" size={12} />
        </Link>
      )}
    </div>
  );
}

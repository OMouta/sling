import type {
  AgentChoice,
  AssistantChoice,
  ConversationView,
  PermissionMode,
  RunnerView,
  TaskView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ArrowUp, Check, Cpu, Laptop } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useModeChange } from "../components/ConfirmFullAccess.tsx";
import { Logo } from "../components/Logo.tsx";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { TaskStateBadge } from "../components/TaskCard.tsx";
import { Button, Card, cx, ErrorText, Kbd } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { machinesOnly } from "../lib/machines.ts";
import { useModelCatalog } from "../lib/models.ts";
import type { Settings } from "../lib/types.ts";

const SUGGESTIONS = [
  "Fix the failing test in CI and open a PR",
  "Add a dark mode toggle to the settings page",
  "Bump dependencies and make sure the build passes",
];

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
  const catalog = useModelCatalog();
  // Unset means "the workspace default", so a default changed elsewhere still applies.
  const [assistant, setAssistant] = useState<AssistantChoice | undefined>();
  const [agent, setAgent] = useState<AgentChoice | undefined>();
  const [mode, setMode] = useState<PermissionMode | undefined>();
  const modeChange = useModeChange(setMode);

  const start = useMutation({
    mutationFn: async (message: string) => {
      const c = await api.post<ConversationView>("/api/conversations");
      const settings = {
        ...(assistant ? { assistant } : {}),
        ...(agent ? { agent } : {}),
      };
      if (mode || assistant || agent) {
        await api.patch(`/api/conversations/${c.id}`, {
          ...(mode ? { mode } : {}),
          ...(assistant || agent ? { settings } : {}),
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

  const hasModel = Boolean(settings.data?.model);
  const hasMachine = machinesOnly(runners.data ?? []).length > 0;
  const ready = hasModel && hasMachine;
  const recent = (tasks.data ?? []).slice(0, 5);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && !start.isPending) start.mutate(text.trim());
  }

  return (
    <Page title="Chat">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-5 pt-[12vh] pb-10">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-4 grid size-11 place-items-center rounded-xl bg-accent text-white shadow-primary">
            <Logo className="size-6" />
          </span>
          <h2 className="text-2xl font-medium tracking-tight text-balance">
            What should we work on?
          </h2>
          <p className="mt-1.5 max-w-md text-[13px] leading-5 text-pretty text-muted">
            Sling hands coding work to Codex or Claude Code, on your machines or in a fresh sandbox.
          </p>
        </div>

        {!ready && settings.isSuccess && runners.isSuccess && (
          <Card className="mb-4 divide-y divide-border">
            <Step done={hasModel} n={1} icon={Cpu} title="Connect a model" to="/settings">
              Sling's assistant needs an OpenAI, Anthropic, or OpenAI-compatible model.
            </Step>
            <Step
              done={hasMachine}
              n={2}
              icon={Laptop}
              title="Pair a machine"
              to="/machines"
              search={{ pair: true }}
            >
              Install sling-runner on the computer that has your repos and Codex or Claude Code.
            </Step>
          </Card>
        )}

        <form onSubmit={submit}>
          <div
            className={cx(
              "rounded-2xl bg-surface shadow-card transition-shadow duration-150 has-[textarea:focus]:shadow-focus",
              !ready && "opacity-60",
            )}
          >
            <textarea
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
                agent={
                  agent ??
                  catalog.data?.defaults.agent ?? {
                    harness: "codex",
                    model: null,
                    effort: null,
                    fast: false,
                  }
                }
                onAssistant={setAssistant}
                onAgent={setAgent}
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
        <p className="mt-2 flex items-center justify-center gap-1 text-xs text-subtle max-sm:hidden">
          <Kbd>↵</Kbd> to send, <Kbd>⇧</Kbd>
          <Kbd>↵</Kbd> for a new line
        </p>
        {modeChange.dialog}

        {ready && !text && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setText(s)}
                className="pressable h-[26px] cursor-pointer rounded-full bg-surface-2 px-2.5 text-xs text-muted shadow-raised hover:text-text hover:shadow-raised-hover"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <div className="mt-12">
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
          </div>
        )}
      </div>
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

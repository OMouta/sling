import type { ConversationView, RunnerView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { Button, Card, cx, ErrorText, Textarea } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
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
  const [text, setText] = useState("");

  const start = useMutation({
    mutationFn: async (message: string) => {
      const c = await api.post<ConversationView>("/api/conversations");
      await api.post(`/api/conversations/${c.id}/messages`, { text: message });
      return c;
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void navigate({ to: "/c/$id", params: { id: c.id } });
    },
  });

  const hasModel = Boolean(settings.data?.model);
  const hasMachine = (runners.data?.length ?? 0) > 0;
  const ready = hasModel && hasMachine;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) start.mutate(text.trim());
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="size-9" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">What should we work on?</h1>
          <p className="text-sm text-muted">
            Sling hands coding work to Codex on your own machines.
          </p>
        </div>
      </div>

      {!ready && settings.isSuccess && runners.isSuccess && (
        <Card className="mb-6 divide-y divide-border">
          <Step done={hasModel} n={1} title="Connect a model" to="/settings">
            Sling's assistant needs an OpenAI, Anthropic, or OpenAI-compatible model.
          </Step>
          <Step done={hasMachine} n={2} title="Pair a machine" to="/machines">
            Install sling-runner on the computer that has your repos and Codex.
          </Step>
        </Card>
      )}

      <form onSubmit={submit}>
        <Card className="p-2">
          <Textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) submit(e);
            }}
            placeholder="The footer year in site is hardcoded. Make it dynamic and add a test."
            className="resize-none border-0 focus:border-0"
            disabled={!ready}
          />
          <div className="flex items-center justify-end gap-2 px-1 pt-1">
            <ErrorText error={start.error} />
            <Button
              type="submit"
              variant="primary"
              busy={start.isPending}
              disabled={!ready || !text.trim()}
            >
              Start
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}

function Step({
  done,
  n,
  title,
  to,
  children,
}: {
  done: boolean;
  n: number;
  title: string;
  to: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 p-4">
      <span
        className={cx(
          "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
          done ? "bg-ok text-white" : "bg-surface-2 text-muted",
        )}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("font-medium", done && "text-muted line-through")}>{title}</p>
        <p className="text-sm text-muted">{children}</p>
      </div>
      {!done && (
        <Link to={to} className="text-sm font-medium text-accent">
          Set up
        </Link>
      )}
    </div>
  );
}

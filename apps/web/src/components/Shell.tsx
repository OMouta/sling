import type { ApprovalView, ConversationView, RunnerView, TaskView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { MessageSquare, Plus, SquarePen } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { decisionCount } from "../lib/approvals.ts";
import { machinesOnly } from "../lib/machines.ts";
import { connectRealtime, useConnection } from "../lib/realtime.ts";
import { useSandboxes } from "../lib/sandboxApi.ts";
import type { Status } from "../lib/types.ts";
import { Logo } from "./Logo.tsx";
import { NAV, type NavItem } from "./nav.ts";
import { ShellContext } from "./Page.tsx";
import { Button, Count, cx, Spinner } from "./ui.tsx";

const CommandPalette = lazy(() =>
  import("./CommandPalette.tsx").then((m) => ({ default: m.CommandPalette })),
);

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => api.get<Status>("/api/status") });
}

/** Gate for the signed-in app: setup, then login, then the shell. */
export function AppLayout() {
  const status = useStatus();
  if (status.isPending) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (status.data?.needsSetup) return <Navigate to="/setup" />;
  if (!status.data?.signedIn) return <Navigate to="/login" />;
  return <Shell />;
}

function Shell() {
  const qc = useQueryClient();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => connectRealtime(qc), [qc]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer on navigation.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const shell = useMemo(
    () => ({ openNav: () => setNavOpen(true), openSearch: () => setSearchOpen(true) }),
    [],
  );

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-full">
        <aside
          className={cx(
            "fixed inset-y-0 left-0 z-30 flex w-[254px] flex-col border-r border-border bg-sidebar transition-transform duration-300 ease-[var(--ease-out)] md:static md:translate-x-0 md:transition-none",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar />
        </aside>
        {navOpen && (
          <button
            type="button"
            aria-label="Close menu"
            className="anim-fade fixed inset-0 z-20 bg-black/50 md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <CommandPalette onClose={closeSearch} />
        </Suspense>
      )}
    </ShellContext.Provider>
  );
}

const navRow =
  "group flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted transition-colors duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] hover:text-text";
const navActive = "active bg-surface-3 text-text! shadow-active";

function NavLink({ item, count, warn }: { item: NavItem; count?: number; warn?: boolean }) {
  const Icon = item.icon;
  return (
    <Link to={item.to} className={navRow} activeProps={{ className: navActive }}>
      <Icon
        aria-hidden="true"
        className="text-subtle transition-colors duration-150 group-hover:text-icon group-[.active]:text-icon"
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count ? <Count tone={warn ? "warn" : undefined}>{count}</Count> : null}
    </Link>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pr-1 pl-2">
      <span className="section-label">{children}</span>
      {action}
    </div>
  );
}

function Sidebar() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<ConversationView[]>("/api/conversations"),
  });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalView[]>("/api/approvals"),
  });
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<TaskView[]>("/api/tasks"),
  });
  const sandboxes = useSandboxes();
  const create = useMutation({
    mutationFn: () => api.post<ConversationView>("/api/conversations"),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void navigate({ to: "/c/$id", params: { id: c.id } });
    },
  });

  const machines = machinesOnly(runners.data ?? []);
  const online = machines.filter((m) => m.online).length;
  const activeTasks = (tasks.data ?? []).filter(
    (t) => t.state === "queued" || t.state === "dispatched" || t.state === "running",
  ).length;
  const counts: Partial<Record<NavItem["to"], { n?: number; warn?: boolean }>> = {
    "/tasks": { n: activeTasks },
    "/approvals": { n: decisionCount(approvals.data), warn: true },
    "/machines": { n: online },
    "/sandboxes": { n: sandboxes.data?.usage.running },
  };
  const section = (s: NavItem["section"]) =>
    NAV.filter((n) => n.section === s).map((n) => (
      <NavLink key={n.to} item={n} count={counts[n.to]?.n} warn={counts[n.to]?.warn} />
    ));

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg">
          <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-accent text-white shadow-primary">
            <Logo className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm leading-4 font-medium">Sling</span>
            <span className="block truncate text-xs leading-4 text-subtle">Personal workspace</span>
          </span>
        </Link>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={SquarePen}
          aria-label="New conversation"
          title="New conversation"
          busy={create.isPending}
          onClick={() => create.mutate()}
        />
      </div>

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-2">
        <div className="space-y-px">
          <Link
            to="/"
            className={navRow}
            activeOptions={{ exact: true }}
            activeProps={{ className: navActive }}
          >
            <MessageSquare
              aria-hidden="true"
              className="text-subtle transition-colors duration-150 group-hover:text-icon group-[.active]:text-icon"
            />
            <span className="flex-1">Chat</span>
          </Link>
          {section("main")}
        </div>

        <div className="mt-5 space-y-px">
          <SectionLabel>Automation</SectionLabel>
          {section("automation")}
        </div>

        <div className="mt-5 space-y-px">
          <SectionLabel>Infrastructure</SectionLabel>
          {section("infrastructure")}
        </div>

        <div className="mt-5 space-y-px">
          <SectionLabel
            action={
              <button
                type="button"
                aria-label="Start a conversation"
                onClick={() => create.mutate()}
                className="grid size-5 cursor-pointer place-items-center rounded-md text-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-icon"
              >
                <Plus aria-hidden="true" size={12} />
              </button>
            }
          >
            Conversations
          </SectionLabel>
          {conversations.data?.slice(0, 40).map((c) => (
            <Link
              key={c.id}
              to="/c/$id"
              params={{ id: c.id }}
              className="group flex h-[30px] items-center gap-2.5 rounded-lg px-2 text-sm text-muted transition-colors duration-150 hover:text-text"
              activeProps={{ className: navActive }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-faint transition-colors duration-150 group-hover:bg-subtle group-[.active]:bg-accent-text" />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
            </Link>
          ))}
          {conversations.data?.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-subtle">No conversations yet.</p>
          )}
        </div>
      </nav>

      <div className="shrink-0 space-y-2 px-3 pb-3">
        <div className="space-y-px">{section("footer")}</div>
        <StatusCard machines={machines.length} online={online} usage={sandboxes.data?.usage} />
      </div>
    </>
  );
}

function StatusCard({
  machines,
  online,
  usage,
}: {
  machines: number;
  online: number;
  usage?: { monthMinutes: number; monthlyMinutesBudget: number };
}) {
  const connection = useConnection();
  const budget = usage?.monthlyMinutesBudget ?? 0;
  const used = Math.round(usage?.monthMinutes ?? 0);
  const filled = budget > 0 ? Math.min(20, Math.round((used / budget) * 20)) : 0;
  return (
    <div className="rounded-xl bg-surface p-3 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium">
          {machines === 0 ? "No machines yet" : `${online} of ${machines} machines online`}
        </p>
        <span
          className={cx(
            "flex shrink-0 items-center gap-1 text-[11px]",
            connection === "open" ? "text-status" : "text-warn",
          )}
          title={connection === "open" ? "Live updates are on" : "Reconnecting to the server"}
        >
          <span
            className={cx(
              "size-1.5 rounded-full",
              connection === "open" ? "bg-status" : "bg-warn motion-safe:animate-pulse",
            )}
          />
          {connection === "open" ? "Live" : "Reconnecting"}
        </span>
      </div>
      {budget > 0 ? (
        <>
          <div className="mt-2.5 flex gap-[3px]" aria-hidden="true">
            {Array.from({ length: 20 }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments of a meter.
                key={i}
                className={cx(
                  "h-2.5 flex-1 rounded-[2px]",
                  i < filled ? (filled >= 18 ? "bg-warn" : "bg-accent-text") : "bg-surface-3",
                )}
              />
            ))}
          </div>
          <p className="tabular mt-2 text-[11px] text-subtle">
            {used.toLocaleString()} of {budget.toLocaleString()} sandbox minutes this month
          </p>
        </>
      ) : (
        <p className="mt-1 text-[11px] leading-4 text-subtle">
          {machines === 0
            ? "Pair the computer that has your repos."
            : "Tasks go to the first machine that fits."}
        </p>
      )}
      {machines === 0 && (
        <Link
          to="/machines"
          className="pressable mt-2.5 flex h-[26px] items-center justify-center rounded-full bg-surface-2 text-xs font-medium shadow-raised hover:shadow-raised-hover"
        >
          Pair a machine
        </Link>
      )}
    </div>
  );
}

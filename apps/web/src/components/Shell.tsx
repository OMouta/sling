import type { ApprovalView, RunnerView, TaskView } from "@sling/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { PanelLeftClose, SquarePen } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { decisionCount } from "../lib/approvals.ts";
import { useConversations } from "../lib/conversations.ts";
import { machinesOnly } from "../lib/machines.ts";
import { NEW_CHAT_EVENT } from "../lib/newChat.ts";
import { connectRealtime, setOpenConversation, useConnection } from "../lib/realtime.ts";
import { useSandboxes } from "../lib/sandboxApi.ts";
import { useDefaultTimeZone } from "../lib/timezone.ts";
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

const SIDEBAR_KEY = "sling.sidebar";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function Shell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // A page in focus mode hides the sidebar; showing it then lasts until the page closes.
  const [focus, setFocusState] = useState(false);
  const [peek, setPeek] = useState(false);
  const setFocus = useCallback((on: boolean) => {
    setFocusState(on);
    setPeek(false);
  }, []);
  const hidden = focus ? !peek : collapsed;
  // A new chat is the empty composer. The conversation is made when the
  // first message is sent, so nothing empty piles up in the list.
  const newChat = useCallback(() => {
    void navigate({ to: "/" }).then(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT)));
  }, [navigate]);
  const toggleSidebar = useCallback(() => {
    if (focus) {
      setPeek((p) => !p);
      return;
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? "open" : "collapsed");
      } catch {
        // Not remembered; still applies for this tab.
      }
      return !c;
    });
  }, [focus]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => connectRealtime(qc), [qc]);
  // Replies in the chat on screen aren't pushed to this person's devices.
  useEffect(() => setOpenConversation(/^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null), [pathname]);
  useDefaultTimeZone();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer on navigation.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (key === "b" && window.matchMedia("(min-width: 48rem)").matches) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const shell = useMemo(
    () => ({
      openNav: () => setNavOpen(true),
      openSearch: () => setSearchOpen(true),
      collapsed: hidden,
      toggleSidebar,
      newConversation: newChat,
      setFocus,
    }),
    [hidden, toggleSidebar, newChat, setFocus],
  );

  return (
    <ShellContext.Provider value={shell}>
      {/* The installed app draws edge to edge; env() insets are zero everywhere else. */}
      <div className="flex h-full pr-[env(safe-area-inset-right)]">
        <aside
          className={cx(
            "fixed inset-y-0 left-0 z-30 flex w-[calc(254px+env(safe-area-inset-left))] flex-col border-r border-border bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-transform duration-300 ease-[var(--ease-out)] md:static md:translate-x-0 md:transition-none",
            navOpen ? "translate-x-0" : "-translate-x-full",
            hidden && "md:hidden",
          )}
        >
          <Sidebar onNew={newChat} onCollapse={toggleSidebar} />
        </aside>
        {navOpen && (
          <button
            type="button"
            aria-label="Close menu"
            className="anim-fade fixed inset-0 z-20 bg-black/50 md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}
        <main
          className={cx(
            "min-w-0 flex-1 max-md:pl-[env(safe-area-inset-left)]",
            hidden && "md:pl-[env(safe-area-inset-left)]",
          )}
        >
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

function NavLink({
  item,
  count,
  warn,
  active,
}: {
  item: NavItem;
  count?: number;
  warn?: boolean;
  active?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cx(navRow, active && navActive)}
      activeProps={{ className: navActive }}
    >
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

function Sidebar({ onNew, onCollapse }: { onNew: () => void; onCollapse: () => void }) {
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
  const conversations = useConversations();
  // An open chat is one of the Chats page's.
  const inChat = useRouterState({ select: (s) => s.location.pathname.startsWith("/c/") });

  const machines = machinesOnly(runners.data ?? []);
  const online = machines.filter((m) => m.online).length;
  const activeTasks = (tasks.data ?? []).filter(
    (t) => t.state === "queued" || t.state === "dispatched" || t.state === "running",
  ).length;
  const counts: Partial<Record<NavItem["to"], { n?: number; warn?: boolean }>> = {
    "/chats": { n: (conversations.data ?? []).filter((c) => c.waiting).length, warn: true },
    "/tasks": { n: activeTasks },
    "/approvals": { n: decisionCount(approvals.data), warn: true },
    "/machines": { n: online },
    "/sandboxes": { n: sandboxes.data?.usage.running },
  };
  const section = (s: NavItem["section"]) =>
    NAV.filter((n) => n.section === s).map((n) => (
      <NavLink
        key={n.to}
        item={n}
        count={counts[n.to]?.n}
        warn={counts[n.to]?.warn}
        active={n.to === "/chats" && inChat}
      />
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
          aria-label="New chat"
          title="New chat"
          onClick={onNew}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={PanelLeftClose}
          aria-label="Hide sidebar"
          title="Hide sidebar (⌘B)"
          className="max-md:hidden"
          onClick={onCollapse}
        />
      </div>

      {/* On a short screen it scrolls and fades out above Settings; the padding keeps the last link clear. */}
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]">
        <div className="space-y-px">{section("main")}</div>

        <div className="mt-5 space-y-px">
          <SectionLabel>Automation</SectionLabel>
          {section("automation")}
        </div>

        <div className="mt-5 space-y-px">
          <SectionLabel>Infrastructure</SectionLabel>
          {section("infrastructure")}
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
      {budget > 0 && (
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

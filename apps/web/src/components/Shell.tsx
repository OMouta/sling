import type { ApprovalView, ConversationView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { connectRealtime, useConnection } from "../lib/realtime.ts";
import type { Status } from "../lib/types.ts";
import { Logo } from "./Logo.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => api.get<Status>("/api/status") });
}

/** Gate for the signed-in app: setup, then login, then the shell. */
export function AppLayout() {
  const status = useStatus();
  if (status.isPending) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (status.data?.needsSetup) return <Navigate to="/setup" />;
  if (!status.data?.signedIn) return <Navigate to="/login" />;
  return <Shell email={status.data.email} />;
}

function Shell({ email }: { email: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => connectRealtime(qc), [qc]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer on navigation.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex h-full">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar email={email} />
      </aside>
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            className="-ml-1 rounded-md p-1.5 hover:bg-surface-2"
            onClick={() => setOpen(true)}
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden="true">
              <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
            </svg>
          </button>
          <Logo className="size-6" />
          <span className="font-semibold">Sling</span>
          <div className="ml-auto">
            <ConnectionDot />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ConnectionDot() {
  const state = useConnection();
  if (state === "open") return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-warn">
      <Spinner className="size-3" /> Reconnecting
    </span>
  );
}

function NavLink({ to, children, count }: { to: string; children: ReactNode; count?: number }) {
  return (
    <Link
      to={to}
      className="flex h-9 items-center justify-between rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-text"
      activeProps={{ className: "bg-surface-2 !text-text font-medium" }}
    >
      {children}
      {count ? (
        <span className="rounded-full bg-warn px-1.5 text-xs font-semibold text-white">
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function Sidebar({ email }: { email: string | null }) {
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
  const create = useMutation({
    mutationFn: () => api.post<ConversationView>("/api/conversations"),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void navigate({ to: "/c/$id", params: { id: c.id } });
    },
  });

  return (
    <>
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo className="size-6" />
          <span className="font-semibold tracking-tight">Sling</span>
        </Link>
        <div className="ml-auto hidden md:block">
          <ConnectionDot />
        </div>
      </div>
      <div className="px-3">
        <Button
          variant="primary"
          className="w-full"
          busy={create.isPending}
          onClick={() => create.mutate()}
        >
          New conversation
        </Button>
      </div>
      <nav className="mt-4 space-y-0.5 px-3">
        <NavLink to="/approvals" count={approvals.data?.length}>
          Approvals
        </NavLink>
        <NavLink to="/workflows">Workflows</NavLink>
        <NavLink to="/connectors">Connectors</NavLink>
        <NavLink to="/machines">Machines</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="mt-5 px-6 text-xs font-medium tracking-wide text-muted uppercase">
        Conversations
      </div>
      <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {conversations.data?.map((c) => (
          <Link
            key={c.id}
            to="/c/$id"
            params={{ id: c.id }}
            className="block truncate rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text"
            activeProps={{ className: "bg-surface-2 !text-text" }}
          >
            {c.title}
          </Link>
        ))}
        {conversations.data?.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted">Nothing yet.</p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{email}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await authClient.signOut();
            qc.clear();
            void navigate({ to: "/login" });
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Sun,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useId } from "react";
import { api } from "../lib/api.ts";
import { decisionCount, useApprovalCounts } from "../lib/approvals.ts";
import { authClient } from "../lib/auth.ts";
import { clearDrafts } from "../lib/drafts.ts";
import { setTheme, type ThemePref, useTheme } from "../lib/theme.ts";
import type { Status } from "../lib/types.ts";
import {
  Avatar,
  Button,
  cx,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  TabPanel,
} from "./ui.tsx";

/** What the shell lends to pages: the sidebar, the search palette, and new chats. */
export const ShellContext = createContext<{
  openNav: () => void;
  openSearch: () => void;
  collapsed: boolean;
  toggleSidebar: () => void;
  newConversation: () => void;
  /**
   * For pages that need the whole width, such as the workflow editor: the
   * sidebar hides while they're open, without changing the saved choice.
   */
  setFocus: (on: boolean) => void;
}>({
  openNav: () => {},
  openSearch: () => {},
  collapsed: false,
  toggleSidebar: () => {},
  newConversation: () => {},
  setFocus: () => {},
});

/** Hides the sidebar while the calling page is open. */
export function useFocusMode(on = true) {
  const { setFocus } = useContext(ShellContext);
  useEffect(() => {
    if (!on) return;
    setFocus(true);
    return () => setFocus(false);
  }, [on, setFocus]);
}

/**
 * A page inside the shell: the header bar, then an optional tab row and
 * toolbar, then the scrolling body, then an optional footer bar.
 */
export function Page({
  title,
  crumb,
  badge,
  controls,
  tabs,
  toolbar,
  footer,
  children,
  bodyClassName,
}: {
  /** A string becomes the page's heading; anything else is shown as is. */
  title: ReactNode;
  /** The parent page, shown before the title. */
  crumb?: { label: string; to: string; params?: Record<string, string> };
  badge?: ReactNode;
  /** Page-specific controls in the header, before search and the account menu. */
  controls?: ReactNode;
  tabs?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const panel = useId();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar title={title} crumb={crumb} badge={badge} controls={controls} />
      {tabs && (
        <TabPanel.Provider value={panel}>
          <div className="shrink-0 border-b border-border px-5">{tabs}</div>
        </TabPanel.Provider>
      )}
      {toolbar}
      <div
        className={cx("min-h-0 flex-1 overflow-y-auto", bodyClassName)}
        {...(tabs ? { role: "tabpanel", id: panel, "aria-labelledby": `${panel}-tab` } : {})}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}

/** The row under the tabs: filters on the left, actions on the right. */
export function Toolbar({
  children,
  actions,
  className,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex shrink-0 flex-wrap items-center gap-2 px-5 py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A line of help text for a toolbar that has no filters. */
export function ToolbarText({ children }: { children: ReactNode }) {
  return <p className="min-w-0 text-xs leading-4 text-muted">{children}</p>;
}

/** The totals bar at the bottom of a list. */
export function StatsBar({ items }: { items: (ReactNode | false | null | undefined)[] }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch overflow-x-auto border-t border-border text-xs text-muted">
      {items.filter(Boolean).map((item, i) => (
        <div
          // Fixed positions in a short list.
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity of their own.
          key={i}
          className="tabular flex shrink-0 items-center gap-1.5 border-r border-border px-5 whitespace-nowrap"
        >
          {item}
        </div>
      ))}
    </div>
  );
}

/** The centered column used by form and detail pages. */
export function Content({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("w-full max-w-3xl px-5 py-6", className)}>{children}</div>;
}

function TopBar({
  title,
  crumb,
  badge,
  controls,
}: {
  title: ReactNode;
  crumb?: { label: string; to: string; params?: Record<string, string> };
  badge?: ReactNode;
  controls?: ReactNode;
}) {
  const shell = useContext(ShellContext);
  return (
    <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-3 border-b border-border px-5 pt-[env(safe-area-inset-top)] max-md:px-3">
      <Button
        variant="ghost"
        iconOnly
        icon={MenuIcon}
        aria-label="Open menu"
        className="md:hidden"
        onClick={shell.openNav}
      />
      {shell.collapsed && (
        <span className="-ml-1.5 flex items-center gap-0.5 max-md:hidden">
          <Button
            variant="ghost"
            iconOnly
            icon={PanelLeft}
            aria-label="Show sidebar"
            title="Show sidebar (⌘B)"
            onClick={shell.toggleSidebar}
          />
          <Button
            variant="ghost"
            iconOnly
            icon={SquarePen}
            aria-label="New chat"
            title="New chat"
            onClick={shell.newConversation}
          />
          <span className="mx-1.5 h-4 w-px bg-border" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {crumb && (
          <>
            <Link
              to={crumb.to}
              params={crumb.params as never}
              className="shrink-0 text-base text-subtle transition-colors duration-150 hover:text-text max-sm:hidden"
            >
              {crumb.label}
            </Link>
            <ChevronRight
              aria-hidden="true"
              size={14}
              className="shrink-0 text-faint max-sm:hidden"
            />
          </>
        )}
        {typeof title === "string" ? (
          <h1 className="truncate text-base font-medium">{title}</h1>
        ) : (
          title
        )}
        {badge}
      </div>
      {controls && <div className="flex shrink-0 items-center gap-2">{controls}</div>}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          iconOnly
          icon={Search}
          aria-label="Search"
          title="Search (⌘K)"
          onClick={shell.openSearch}
          className="max-sm:hidden"
        />
        <ApprovalsBell />
        <AccountMenu />
      </div>
    </header>
  );
}

function ApprovalsBell() {
  const counts = useApprovalCounts();
  const n = decisionCount(counts.data);
  return (
    <Link
      to="/approvals"
      aria-label={n ? `Approvals, ${n} waiting` : "Approvals"}
      title={n ? `${n} waiting for you` : "Approvals"}
      className="pressable relative grid size-[30px] place-items-center rounded-full bg-surface-2 text-icon shadow-raised hover:shadow-raised-hover"
    >
      <Bell aria-hidden="true" />
      {n > 0 && (
        <span className="absolute top-[7px] right-[8px] size-[7px] rounded-full bg-danger shadow-[0_0_0_2px_var(--surface-2)]" />
      )}
    </Link>
  );
}

const THEMES: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "System", icon: Monitor },
];

function AccountMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const theme = useTheme();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => api.get<Status>("/api/status", { signal }),
  });
  const email = status.data?.email ?? "";
  const name = email.split("@")[0] || "Account";
  return (
    <Menu
      label="Account"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          onClick={toggle}
          className="pressable flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full bg-surface-2 py-[5px] pr-[9px] pl-[5px] text-xs font-medium shadow-raised hover:shadow-raised-hover"
        >
          <Avatar name={email || "?"} />
          <span className="max-w-32 truncate max-sm:hidden">{name}</span>
          <ChevronDown aria-hidden="true" size={12} className="text-subtle" />
        </button>
      )}
    >
      <MenuLabel>
        <span className="block truncate text-text">{name}</span>
        <span className="block truncate">{email}</span>
      </MenuLabel>
      <MenuSeparator />
      <MenuItem icon={Settings} onSelect={() => void navigate({ to: "/settings" })}>
        Settings
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      {THEMES.map((t) => (
        <MenuItem
          key={t.id}
          icon={t.icon}
          onSelect={() => setTheme(t.id)}
          trailing={theme === t.id ? <Check aria-hidden="true" className="text-text" /> : null}
        >
          {t.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={LogOut}
        onSelect={async () => {
          await authClient.signOut();
          clearDrafts();
          qc.clear();
          void navigate({ to: "/login" });
        }}
      >
        Sign out
      </MenuItem>
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-xs text-subtle">
        <span>Search</span>
        <span className="flex gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </div>
    </Menu>
  );
}

import {
  CONVERSATION_FILTERS,
  type ConversationFilter,
  HARNESSES,
  type Harness,
  TASK_VIEWS,
  type TaskListView,
} from "@sling/core";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { PAGE_SCROLLER } from "./components/Page.tsx";
import { AppLayout } from "./components/Shell.tsx";
import { returnPath } from "./lib/returnTo.ts";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { ChatsPage } from "./pages/Chats.tsx";
import { HomePage } from "./pages/Home.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TaskPage } from "./pages/Task.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { WorkflowsPage } from "./pages/Workflows.tsx";

/** A search value from a fixed list, other than the one the page shows by default. */
function oneOf<T extends string>(values: readonly T[], value: unknown, fallback?: T): value is T {
  return typeof value === "string" && value !== fallback && values.includes(value as T);
}

export interface ChatsSearch {
  q?: string;
  filter?: ConversationFilter;
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});
export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // `next` is the page to open after signing in; `step` resumes at the second factor.
  validateSearch: (search: Record<string, unknown>): { next?: string; step?: "2fa" } => ({
    next: returnPath(search.next),
    step: search.step === "2fa" ? "2fa" : undefined,
  }),
  component: LoginPage,
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout });

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });
export const chatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/c/$id",
  component: ChatPage,
});
export const chatsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/chats",
  // `q` searches names and messages; `filter` is the tab.
  validateSearch: (search: Record<string, unknown>): ChatsSearch => ({
    q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
    filter: oneOf(CONVERSATION_FILTERS, search.filter, "all") ? search.filter : undefined,
  }),
  component: ChatsPage,
});
export const machinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/machines",
  // `pair` opens the pairing dialog, for links from the home page.
  validateSearch: (search: Record<string, unknown>): { pair?: boolean } =>
    search.pair === true || search.pair === "true" ? { pair: true } : {},
  component: lazyRouteComponent(() => import("./pages/Machines.tsx"), "MachinesPage"),
});
const sandboxesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sandboxes",
  component: lazyRouteComponent(() => import("./pages/Sandboxes.tsx"), "SandboxesPage"),
});
// Visited now and then, so it loads on first visit (or on hover over its link).
const checksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/checks",
  component: lazyRouteComponent(() => import("./pages/Checks.tsx"), "ChecksPage"),
});
// Deploy targets became site checks; old links and notifications still land.
const deploysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/deploys",
  beforeLoad: () => {
    throw redirect({ to: "/checks", replace: true });
  },
});
export type ApprovalsTab = "all" | "tasks" | "workflows" | "sandboxes" | "rules";
const APPROVALS_TABS: readonly string[] = ["tasks", "workflows", "sandboxes", "rules"];
export const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/approvals",
  // `tab` opens one tab, such as Rules from a chat a rule started.
  validateSearch: (search: Record<string, unknown>): { tab?: ApprovalsTab } =>
    typeof search.tab === "string" && APPROVALS_TABS.includes(search.tab)
      ? { tab: search.tab as ApprovalsTab }
      : {},
  component: ApprovalsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/Settings.tsx"), "SettingsPage"),
});
export interface TasksSearch {
  view?: TaskListView;
  agent?: Harness;
  where?: "machine" | "sandbox";
}
export const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks",
  validateSearch: (search: Record<string, unknown>): TasksSearch => ({
    view: oneOf(TASK_VIEWS, search.view, "all") ? search.view : undefined,
    agent: oneOf(HARNESSES, search.agent) ? search.agent : undefined,
    where: oneOf(["machine", "sandbox"] as const, search.where) ? search.where : undefined,
  }),
  component: TasksPage,
});
export const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks/$id",
  component: TaskPage,
});

export const workflowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows",
  validateSearch: (search: Record<string, unknown>): { tab?: "on" | "off" } => ({
    tab: oneOf(["on", "off"] as const, search.tab) ? search.tab : undefined,
  }),
  component: WorkflowsPage,
});

export type EditorTab = "canvas" | "runs" | "versions";
export interface EditorSearch {
  tab?: EditorTab;
  /** Version shown read-only on the Versions tab. */
  version?: number;
}

// The editor and run view carry React Flow, so they load on first visit.
export const workflowRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows/$id",
  validateSearch: (search: Record<string, unknown>): EditorSearch => {
    const out: EditorSearch = {};
    if (search.tab === "runs" || search.tab === "versions") out.tab = search.tab;
    const v = Number(search.version);
    if (Number.isInteger(v) && v > 0) out.version = v;
    return out;
  },
  component: lazyRouteComponent(() => import("./pages/WorkflowEditor.tsx"), "WorkflowEditorPage"),
});
export const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows/$id/runs/$runId",
  component: lazyRouteComponent(() => import("./pages/WorkflowRun.tsx"), "WorkflowRunPage"),
});
const personalitiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/personalities",
  component: lazyRouteComponent(() => import("./pages/Personalities.tsx"), "PersonalitiesPage"),
});
const memoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/memory",
  component: lazyRouteComponent(() => import("./pages/Memory.tsx"), "MemoryPage"),
});
/** One personality, to edit. New ones are made from the Personalities page. */
export const personalityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/personalities/$id",
  component: lazyRouteComponent(() => import("./pages/Personalities.tsx"), "PersonalityEditorPage"),
});
const connectorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connectors",
  component: lazyRouteComponent(() => import("./pages/Connectors.tsx"), "ConnectorsPage"),
});

export type ExtensionsTab = "installed" | "discover" | "sources";
export const extensionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/extensions",
  validateSearch: (search: Record<string, unknown>): { tab?: "discover" | "sources" } =>
    search.tab === "discover" || search.tab === "sources" ? { tab: search.tab } : {},
  component: lazyRouteComponent(() => import("./pages/Extensions.tsx"), "ExtensionsPage"),
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    homeRoute,
    chatRoute,
    chatsRoute,
    machinesRoute,
    sandboxesRoute,
    checksRoute,
    deploysRoute,
    approvalsRoute,
    settingsRoute,
    tasksRoute,
    taskRoute,
    workflowsRoute,
    workflowRoute,
    runRoute,
    connectorsRoute,
    extensionsRoute,
    personalitiesRoute,
    personalityRoute,
    memoryRoute,
  ]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient: undefined as unknown as QueryClient },
    defaultPreload: "intent",
    // Back returns a page to where it was scrolled. A chat keeps its own place.
    scrollRestoration: ({ location }) => !location.pathname.startsWith("/c/"),
    scrollToTopSelectors: [`[data-scroll-restoration-id="${PAGE_SCROLLER}"]`],
    // A page for another chat, task or run starts fresh, not with the last one's state.
    defaultRemountDeps: ({ params }) => params,
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

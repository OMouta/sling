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
import { AppLayout } from "./components/Shell.tsx";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { ChatsPage } from "./pages/Chats.tsx";
import { ConnectorsPage } from "./pages/Connectors.tsx";
import { ExtensionsPage } from "./pages/Extensions.tsx";
import { HomePage } from "./pages/Home.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { MachinesPage } from "./pages/Machines.tsx";
import { PersonalitiesPage, PersonalityEditorPage } from "./pages/Personalities.tsx";
import { SandboxesPage } from "./pages/Sandboxes.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TaskPage } from "./pages/Task.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { WorkflowsPage } from "./pages/Workflows.tsx";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
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
  // `q` searches names and messages.
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q.trim() ? { q: search.q } : {},
  component: ChatsPage,
});
export const machinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/machines",
  // `pair` opens the pairing dialog, for links from the home page.
  validateSearch: (search: Record<string, unknown>): { pair?: boolean } =>
    search.pair === true || search.pair === "true" ? { pair: true } : {},
  component: MachinesPage,
});
const sandboxesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sandboxes",
  component: SandboxesPage,
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
  component: SettingsPage,
});
const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks",
  component: TasksPage,
});
export const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks/$id",
  component: TaskPage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows",
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
  component: PersonalitiesPage,
});
const memoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/memory",
  component: lazyRouteComponent(() => import("./pages/Memory.tsx"), "MemoryPage"),
});
/** `new` makes one; anything else is the ID of one to edit. */
export const personalityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/personalities/$id",
  component: PersonalityEditorPage,
});
const connectorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connectors",
  component: ConnectorsPage,
});

export type ExtensionsTab = "installed" | "discover" | "sources";
export const extensionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/extensions",
  validateSearch: (search: Record<string, unknown>): { tab?: "discover" | "sources" } =>
    search.tab === "discover" || search.tab === "sources" ? { tab: search.tab } : {},
  component: ExtensionsPage,
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
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

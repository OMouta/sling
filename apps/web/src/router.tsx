import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppLayout } from "./components/Shell.tsx";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { ConnectorsPage } from "./pages/Connectors.tsx";
import { HomePage } from "./pages/Home.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { MachinesPage } from "./pages/Machines.tsx";
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
const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/approvals",
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
const connectorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connectors",
  component: ConnectorsPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    homeRoute,
    chatRoute,
    machinesRoute,
    sandboxesRoute,
    approvalsRoute,
    settingsRoute,
    tasksRoute,
    taskRoute,
    workflowsRoute,
    workflowRoute,
    runRoute,
    connectorsRoute,
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

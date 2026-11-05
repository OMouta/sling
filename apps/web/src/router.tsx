import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
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
import { SettingsPage } from "./pages/Settings.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TaskPage } from "./pages/Task.tsx";

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
const machinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/machines",
  component: MachinesPage,
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
export const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks/$id",
  component: TaskPage,
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
    approvalsRoute,
    settingsRoute,
    taskRoute,
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

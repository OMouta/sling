import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LucideProvider } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api.ts";
import { registerServiceWorker } from "./lib/pwa.ts";
import { applyTheme, storedTheme } from "./lib/theme.ts";
import { router } from "./router.tsx";
import "./styles.css";

applyTheme(storedTheme());
// A tapped notification opens its page in this window, without a reload.
registerServiceWorker((href) => void router.navigate({ href }));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <LucideProvider size={14} strokeWidth={1.5} absoluteStrokeWidth>
          <RouterProvider router={router} context={{ queryClient }} />
        </LucideProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

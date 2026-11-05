import {
  cloneUrlFor,
  type RepoView,
  type SandboxListView,
  type SandboxRepoView,
  type SandboxSettingsView,
  type SandboxView,
} from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { SecretKey } from "./sandbox.ts";
import { qk } from "./workflowApi.ts";

/** What `PUT /api/settings/sandboxes` takes: everything but the secrets. */
export type SandboxSettingsInput = Omit<SandboxSettingsView, "secrets">;

export function useSandboxes() {
  return useQuery({
    queryKey: qk.sandboxes(),
    queryFn: () => api.get<SandboxListView>("/api/sandboxes"),
  });
}

export function useSandboxRepos() {
  return useQuery({
    queryKey: qk.sandboxRepos(),
    queryFn: () => api.get<SandboxRepoView[]>("/api/sandbox-repos"),
  });
}

export function useSandboxSettings() {
  return useQuery({
    queryKey: qk.sandboxSettings(),
    queryFn: () => api.get<SandboxSettingsView>("/api/settings/sandboxes"),
  });
}

/** Remote keys have slashes, so they travel as one encoded path segment. */
function sandboxRepoPath(remoteKey: string): string {
  return `/api/sandbox-repos/${encodeURIComponent(remoteKey)}`;
}

export function isSandboxView(value: unknown): value is SandboxView {
  return typeof value === "object" && value !== null && "id" in value && "state" in value;
}

export function isSandboxSettingsView(value: unknown): value is SandboxSettingsView {
  return typeof value === "object" && value !== null && "secrets" in value;
}

export const sandboxApi = {
  destroy: (id: string) =>
    api.post<SandboxView | { ok: boolean } | null>(`/api/sandboxes/${id}/destroy`),
  /** A sandbox clones the repo over HTTPS from its remote, never from a machine. */
  allowRepo: (repo: Pick<RepoView, "remoteKey" | "defaultBranch" | "network">) => {
    if (!repo.remoteKey) throw new Error("This repo has no remote to clone from.");
    return api.put<SandboxRepoView | null>(sandboxRepoPath(repo.remoteKey), {
      cloneUrl: cloneUrlFor(repo.remoteKey),
      defaultBranch: repo.defaultBranch,
      network: repo.network,
    });
  },
  disallowRepo: (remoteKey: string) => api.del<unknown>(sandboxRepoPath(remoteKey)),
  saveSettings: (body: SandboxSettingsInput) =>
    api.put<SandboxSettingsView | null>("/api/settings/sandboxes", body),
  /** Write-only. `""` clears a secret; a key that's left out is kept. */
  saveSecrets: (body: Partial<Record<SecretKey, string>>) =>
    api.put<{ secrets: SandboxSettingsView["secrets"] }>("/api/settings/sandboxes/secrets", body),
};

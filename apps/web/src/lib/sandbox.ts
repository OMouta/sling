import {
  type ApprovalView,
  type ConnectorView,
  type InstallationView,
  isHarness,
  type SandboxFallbackPayload,
  type SandboxSettingsView,
  type SandboxState,
  type SandboxView,
} from "@sling/core";

/** Built-in connectors that create sandboxes, for servers that don't flag them yet. */
const PROVIDER_CONNECTOR_IDS: ReadonlySet<string> = new Set(["docker", "railway"]);

/**
 * Whether a connector is an execution provider, one that creates sandboxes.
 * A connector's own `isExecutionProvider` flag wins when the server sends it.
 */
export function isProviderConnector(connector: Pick<ConnectorView, "id">): boolean {
  const flag = (connector as { isExecutionProvider?: unknown }).isExecutionProvider;
  if (typeof flag === "boolean") return flag;
  return PROVIDER_CONNECTOR_IDS.has(connector.id);
}

/** Installations of provider connectors. Unknown connectors are judged by ID. */
export function providerInstallations(
  installations: InstallationView[],
  connectors: ConnectorView[],
): InstallationView[] {
  const byId = new Map(connectors.map((c) => [c.id, c]));
  return installations.filter((i) =>
    isProviderConnector(byId.get(i.connectorId) ?? { id: i.connectorId }),
  );
}

/** A sandbox that still exists, or is about to. */
export function isLiveSandbox(state: SandboxState): boolean {
  return state !== "destroyed" && state !== "failed";
}

/** How long a sandbox has existed: from the request to its destruction, or to now. */
export function sandboxRunMs(sandbox: SandboxView, now = Date.now()): number {
  const start = new Date(sandbox.requestedAt).getTime();
  const end = sandbox.destroyedAt ? new Date(sandbox.destroyedAt).getTime() : now;
  return Math.max(0, end - start);
}

/** "12 min", "0.4 min" for the first minute. */
export function minutes(n: number): string {
  if (n > 0 && n < 1) return `${n.toFixed(1)} min`;
  return `${Math.round(n).toLocaleString()} min`;
}

/** Estimated spend. The server sends it in the user's own currency, so no symbol. */
export function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The payload of a `sandbox_fallback` approval, or null when it isn't one or
 * the payload is missing what the card has to show.
 */
export function fallbackPayload(approval: ApprovalView): SandboxFallbackPayload | null {
  if (approval.kind !== "sandbox_fallback" || !approval.payload) return null;
  const p = approval.payload;
  const taskId = str(p.taskId) ?? approval.taskId;
  const taskTitle = str(p.taskTitle);
  const remoteKey = str(p.remoteKey);
  const providerName = str(p.providerName);
  if (!taskId || !taskTitle || !remoteKey || !providerName || !isHarness(p.harness)) return null;
  return {
    taskId,
    taskTitle,
    remoteKey,
    cloneUrl: str(p.cloneUrl) ?? "",
    providerInstallationId: str(p.providerInstallationId) ?? "",
    providerName,
    harness: p.harness,
    reasons: Array.isArray(p.reasons)
      ? p.reasons.filter((r): r is string => typeof r === "string")
      : [],
  };
}

/** The pending fallback approval holding a task back, if there is one. */
export function pendingFallbackFor(
  approvals: ApprovalView[] | undefined,
  taskId: string,
): ApprovalView | undefined {
  return approvals?.find(
    (a) =>
      a.kind === "sandbox_fallback" &&
      a.state === "pending" &&
      (a.taskId === taskId || a.payload?.taskId === taskId),
  );
}

export type SecretKey = keyof SandboxSettingsView["secrets"];

export const SECRET_KEYS: readonly SecretKey[] = ["openaiApiKey", "anthropicApiKey", "gitToken"];

/**
 * The body for `PUT /api/settings/sandboxes/secrets`: only the secrets you typed.
 * Blank fields are left alone; clearing a secret is a separate, explicit `""`.
 */
export function secretsBody(
  typed: Partial<Record<SecretKey, string>>,
): Partial<Record<SecretKey, string>> {
  const body: Partial<Record<SecretKey, string>> = {};
  for (const key of SECRET_KEYS) {
    const value = typed[key]?.trim();
    if (value) body[key] = value;
  }
  return body;
}

/** Cost per hour by installation, from form text. Blank or invalid entries are unset. */
export function costPerHourBody(inputs: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, text] of Object.entries(inputs)) {
    if (text.trim() === "") continue;
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) out[id] = n;
  }
  return out;
}

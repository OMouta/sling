import {
  RailwayAuthError,
  RailwayConnectionError,
  RailwayError,
  RailwayGraphQLError,
  SandboxFailedError,
  SandboxNotFoundError,
  SandboxTimeoutError,
} from "railway";
import type { ExecOutcome } from "./api.ts";
import { EXIT_DOCKER_DOWN, EXIT_NO_DOCKER } from "./launch.ts";

export const BAD_TOKEN =
  "Railway rejected the API token. Create an account or workspace token under Account Settings > Tokens, or a project token on the project's Tokens settings page, and check that the token type matches it.";

export class RailwayProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RailwayProviderError";
  }
}

function graphQLMessages(error: RailwayGraphQLError): string {
  const messages = error.errors.map((e) => e.message).filter(Boolean);
  return messages.length ? messages.join("; ") : error.message;
}

/** Whether Railway said the sandbox or environment doesn't exist. */
export function isNotFound(error: unknown): boolean {
  if (error instanceof SandboxNotFoundError) return true;
  return error instanceof RailwayGraphQLError && /not found/i.test(graphQLMessages(error));
}

/** A message that says what went wrong and what to do about it. */
export function describeRailwayError(error: unknown, environmentId?: string): string {
  if (error instanceof RailwayProviderError) return error.message;
  if (error instanceof RailwayAuthError) {
    return `Railway needs ${error.variable === "environmentId" ? "an environment ID" : "an API token"}.`;
  }
  if (error instanceof RailwayGraphQLError) {
    const detail = graphQLMessages(error);
    if (
      error.status === 401 ||
      error.status === 403 ||
      /not authori[sz]ed|unauthori[sz]ed|invalid token/i.test(detail)
    ) {
      return BAD_TOKEN;
    }
    if (/environment/i.test(detail) && /not found|does not exist|no access/i.test(detail)) {
      const which = environmentId ? ` ${environmentId}` : "";
      return `Railway has no environment${which} that this token can reach. Copy the environment ID from the environment's settings, and use a token for that project.`;
    }
    return `Railway refused the request: ${detail}`;
  }
  if (error instanceof SandboxFailedError) {
    return `The Railway sandbox ${error.id} failed to start (${error.status}).`;
  }
  if (error instanceof SandboxTimeoutError) {
    return `The Railway sandbox ${error.id} still wasn't running after ${Math.round(error.timeoutMs / 60_000)} minutes (last status ${error.lastStatus}).`;
  }
  if (error instanceof RailwayConnectionError) {
    return `Couldn't connect to the sandbox to run a command: ${error.message}. Commands go over a WebSocket to ssh.railway.com on port 2226, so outbound traffic to that port must be allowed.`;
  }
  if (error instanceof RailwayError) return error.message;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return `Couldn't reach Railway's API${cause ? `: ${cause}` : ""}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** Explains a launch or check script that didn't exit cleanly. */
export function describeScriptFailure(what: string, outcome: ExecOutcome): string {
  if (outcome.timedOut) return `${what} timed out inside the sandbox.`;
  if (outcome.exitCode === EXIT_NO_DOCKER) {
    return "Docker isn't installed in this Railway sandbox. Railway documents Docker in every sandbox, so check Railway's status and changelog.";
  }
  if (outcome.exitCode === EXIT_DOCKER_DOWN) {
    return "Docker didn't start in the Railway sandbox within a minute.";
  }
  const output = tail(outcome.stderr) || tail(outcome.stdout);
  const code = outcome.exitCode === null ? "no exit code" : `exit ${outcome.exitCode}`;
  return `${what} failed (${code})${output ? `: ${output}` : "."}`;
}

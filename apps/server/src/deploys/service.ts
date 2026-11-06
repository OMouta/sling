import type { DeployTargetView } from "@sling/core";
import type { RepoActionOutput, RepoActionResult } from "@sling/runner-protocol";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/**
 * Deploy targets, their health checks, and the merge, deploy, and verify
 * steps of a task's delivery.
 */
export class DeployService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** Output from a deploy command running on a machine. */
  async repoActionOutput(_session: RunnerSession, _out: RepoActionOutput): Promise<void> {}

  /** A machine's answer to a merge or deploy. */
  async repoActionResult(_session: RunnerSession, _result: RepoActionResult): Promise<void> {}

  /** Runs a target's checks now, saves what they saw, and returns the target. */
  async check(_workspaceId: string, _targetId: string): Promise<DeployTargetView | null> {
    void this.#ctx;
    return null;
  }
}

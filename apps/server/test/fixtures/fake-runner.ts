/**
 * A Runner in TypeScript, for tests: it pairs with a one-time code, signs the
 * handshake, reports an inventory, and plays tasks and actions back without a
 * coding agent. Machines with labels or Claude Code, and the fake execution
 * provider's sandboxes, use it.
 *
 * A repo with a `path` gets real git: a task appends `- <title>` to
 * SLING_FAKE.md on its branch, push and merge go to the clone's origin, and a
 * deploy runs the repo's deploy command in a detached worktree, with the same
 * refusals as the real Runner.
 */
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  ActionRequest_Kind,
  ActionResult_Outcome,
  authPayload,
  type ChatEventSchema,
  type ChatTurn,
  CiCheckSchema,
  create,
  decodeEnvelope,
  type Envelope,
  EnvelopeSchema,
  encodeEnvelope,
  PermissionMode,
  type RepoAction,
  RepoAction_Kind,
  type RepoActionResult,
  RepoActionResult_Outcome,
  RepoActionResultSchema,
  RepoChange_Op,
  RUNNER_WS_PATH,
  type TaskAssign,
  TaskEventSchema,
  TaskFinished_Outcome,
} from "@sling/runner-protocol";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-c", "user.email=fake@sling.test", "-c", "user.name=Fake Runner", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  return stdout.trim();
}

type EventKind = MessageInitShape<typeof TaskEventSchema>["kind"];

export interface FakeRepo {
  name: string;
  remoteUrl: string;
  defaultBranch?: string;
  network?: boolean;
  /** A clone whose origin is a real remote. Tasks, pushes, merges, and deploys then use git. */
  path?: string;
  /** What a deploy runs, through `sh -c` in a worktree at the commit. */
  deployCommand?: string;
}

export interface FakeRunnerOptions {
  /** Control plane URL, for example http://127.0.0.1:1234. */
  url: string;
  name: string;
  repos: FakeRepo[];
  /** Coding agents to report as ready. */
  harnesses?: string[];
  labels?: string[];
  maxMode?: PermissionMode;
  maxConcurrentTasks?: number;
  os?: string;
  arch?: string;
  /** Models each coding agent reports, by harness name. */
  models?: Record<
    string,
    { id: string; efforts?: string[]; fast?: boolean; isDefault?: boolean }[]
  >;
  /** Git repos the machine "found" and that Sling may allow. */
  foundRepos?: { path: string; name: string; remoteUrl?: string }[];
  /** Whether it accepts repo changes from Sling. Defaults to true. */
  remoteRepos?: boolean;
  /** Whether it takes merges and deploys. Defaults to true. */
  deploys?: boolean;
  /** The URL an open_pr action answers with. */
  prUrl?: (taskId: string) => string;
  /** False leaves every RepoAction unanswered, as a machine that went quiet. */
  answerRepoActions?: boolean;
  /** What `gh pr checks` says about a PR here. Without it, the machine can't read CI. */
  ci?: (prUrl: string) => { checks: { name: string; bucket: string }[] } | { error: string };
}

/** What a task does: finish with a commit, fail, or wait to be cancelled. */
function scenario(objective: string): "succeed" | "fail" | "hang" {
  if (objective.includes("[fake:hang]")) return "hang";
  if (objective.includes("[fake:fail]")) return "fail";
  return "succeed";
}

export class FakeRunner {
  readonly options: FakeRunnerOptions;
  readonly #key: KeyObject;
  readonly publicKey: string;
  runnerId = "";
  /** Tasks the server assigned, in order. */
  readonly assigned: TaskAssign[] = [];
  /** Actions the server asked for, in order. */
  readonly actions: { actionId: string; taskId: string; kind: number }[] = [];
  /** Error codes the server sent, for example REVOKED. */
  readonly errors: number[] = [];
  /** Repo changes the server asked for, in order. */
  readonly repoChanges: { op: number; path: string; name: string; paths: string[] }[] = [];
  /** How many times the server asked for a rescan. */
  scans = 0;
  /** Chat turns the server sent, in order. */
  readonly chatTurns: ChatTurn[] = [];
  /** Merges and deploys the server sent, with performance.now() when each arrived. */
  readonly repoActions: { action: RepoAction; at: number }[] = [];
  /** Request IDs the server acknowledged. */
  readonly acks: string[] = [];
  /** Results not acknowledged yet. They're sent again after each reconnect. */
  readonly unacked = new Map<string, RepoActionResult>();
  /** Keeps the next result to itself, as if the connection dropped before it went out. */
  holdNextResult = false;
  /** Task worktrees, for pushes after the task. */
  readonly #work = new Map<string, { repo: FakeRepo; wt: string; branch: string }>();
  #ws: WebSocket | null = null;
  #seq = new Map<string, number>();
  #heartbeat: NodeJS.Timeout | null = null;
  #closed = false;
  /** Resolves when the connection closes for good. */
  readonly exited: Promise<void>;
  #exit!: () => void;

  constructor(options: FakeRunnerOptions) {
    this.options = options;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.#key = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    this.publicKey = Buffer.from(jwk.x, "base64url").toString("base64");
    this.exited = new Promise((ok) => {
      this.#exit = ok;
    });
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Pairs with a one-time code. Throws with the server's message on failure. */
  async pair(code: string): Promise<string> {
    const res = await fetch(`${this.options.url}/api/runner/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        publicKey: this.publicKey,
        name: this.options.name,
        os: this.options.os ?? "linux",
        arch: this.options.arch ?? "x86_64",
        hostname: this.options.name,
        version: "0.0.0-fake",
      }),
    });
    const body = (await res.json()) as { runnerId?: string; error?: string };
    if (!res.ok || !body.runnerId) throw new Error(`pairing failed: ${res.status} ${body.error}`);
    this.runnerId = body.runnerId;
    return this.runnerId;
  }

  /** Connects and resolves once the server has welcomed it. */
  connect(): Promise<void> {
    this.#closed = false;
    const ws = new WebSocket(`${this.options.url.replace(/^http/, "ws")}${RUNNER_WS_PATH}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    return new Promise((ok, fail) => {
      let welcomed = false;
      ws.addEventListener("message", (msg) => {
        const env = decodeEnvelope(new Uint8Array(msg.data as ArrayBuffer));
        if (env.body.case === "welcome" && !welcomed) {
          welcomed = true;
          ok();
        }
        void this.#handle(env).catch((err) => console.error("fake runner", err));
      });
      ws.addEventListener("close", () => {
        if (!welcomed) fail(new Error(`closed before welcome, errors ${this.errors.join(",")}`));
        // An earlier connection that closes late must leave the current one's heartbeat alone.
        if (this.#ws !== ws) return;
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        if (!this.#closed) {
          this.#closed = true;
          this.#exit();
        }
      });
      ws.addEventListener("error", () => {
        if (!welcomed) fail(new Error("websocket error"));
      });
    });
  }

  close() {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#ws?.close();
    this.#exit();
  }

  #send(env: Envelope) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(encodeEnvelope(env));
  }

  #inventory() {
    const o = this.options;
    return {
      capabilities: [
        { name: "chat", version: "1", ready: true, detail: "", models: [] },
        ...(o.harnesses ?? ["codex"]).map((h) => ({
          name: `coding.${h}`,
          version: "1.0.0",
          ready: true,
          detail: "",
          models: (o.models?.[h] ?? []).map((m) => ({
            id: m.id,
            displayName: m.id.toUpperCase(),
            description: "",
            efforts: m.efforts ?? [],
            defaultEffort: m.efforts?.[0] ?? "",
            fast: m.fast ?? false,
            isDefault: m.isDefault ?? false,
          })),
        })),
      ],
      repos: o.repos.map((r) => ({
        name: r.name,
        defaultBranch: r.defaultBranch ?? "main",
        remoteUrl: r.remoteUrl,
        network: r.network ?? false,
        deployCommand: r.deployCommand ?? "",
      })),
      maxMode: o.maxMode ?? PermissionMode.FULL_ACCESS,
      maxConcurrentTasks: o.maxConcurrentTasks ?? 2,
      labels: o.labels ?? [],
      foundRepos: (o.foundRepos ?? []).map((f) => ({
        path: f.path,
        name: f.name,
        defaultBranch: "main",
        remoteUrl: f.remoteUrl ?? "",
      })),
      remoteRepos: o.remoteRepos ?? true,
      deploys: o.deploys ?? true,
    };
  }

  /** Plays one chat turn: streams a reply, and with [fake:tool] calls Sling's tools first. */
  async #chat(t: ChatTurn) {
    const chat = (kind: MessageInitShape<typeof ChatEventSchema>["kind"]) =>
      this.#send(
        create(EnvelopeSchema, { body: { case: "chatEvent", value: { turnId: t.turnId, kind } } }),
      );
    let text = `Fake reply to: ${t.prompt.split("\n")[0]}`;
    if (t.prompt.includes("[fake:tool]")) {
      chat({ case: "thinking", value: { text: "The user wants " } });
      chat({ case: "thinking", value: { text: "their machines." } });
      // Said before the tool call, so it belongs to the work, not the answer.
      chat({ case: "delta", value: { text: "Checking." } });
      const auth = { authorization: `Bearer ${t.toolsToken}` };
      const list = (await (await fetch(t.toolsUrl, { headers: auth })).json()) as {
        tools: { name: string }[];
      };
      chat({ case: "toolUse", value: { name: "list_machines" } });
      const res = (await (
        await fetch(`${t.toolsUrl}/list_machines`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ arguments: {} }),
        })
      ).json()) as { content: string };
      const machines = (JSON.parse(res.content) as { name: string }[]).map((m) => m.name);
      text = `Tools: ${list.tools.map((x) => x.name).join(", ")}. Machines: ${machines.join(", ")}.`;
    }
    for (const part of text.match(/.{1,12}/gs) ?? [])
      chat({ case: "delta", value: { text: part } });
    chat({
      case: "done",
      value: {
        text,
        sessionId: t.sessionId || `fake-session-${this.chatTurns.length}`,
        error: "",
        inputTokens: 11n,
        outputTokens: 7n,
      },
    });
  }

  #sendInventory() {
    this.#send(create(EnvelopeSchema, { body: { case: "inventory", value: this.#inventory() } }));
  }

  /** Reports the inventory again, after a test changed the options. */
  sendInventory() {
    this.#sendInventory();
  }

  async #handle(env: Envelope) {
    const body = env.body;
    switch (body.case) {
      case "challenge": {
        const ts = BigInt(Date.now());
        const signature = sign(null, authPayload(body.value.nonce, this.runnerId, ts), this.#key);
        this.#send(
          create(EnvelopeSchema, {
            body: {
              case: "hello",
              value: {
                runnerId: this.runnerId,
                timestampMs: ts,
                signature,
                runnerVersion: "0.0.0-fake",
                os: this.options.os ?? "linux",
                arch: this.options.arch ?? "x86_64",
                hostname: this.options.name,
                inventory: this.#inventory(),
                heldTasks: [],
              },
            },
          }),
        );
        return;
      }
      case "welcome":
        this.#heartbeat = setInterval(() => {
          this.#send(create(EnvelopeSchema, { body: { case: "heartbeat", value: {} } }));
        }, 5_000);
        for (const r of this.unacked.values()) {
          this.#send(create(EnvelopeSchema, { body: { case: "repoActionResult", value: r } }));
        }
        return;
      case "repoAction": {
        this.repoActions.push({ action: body.value, at: performance.now() });
        if (this.options.answerRepoActions === false) return;
        void this.#repoAction(body.value).catch((err) => console.error("fake runner", err));
        return;
      }
      case "repoActionAck":
        this.acks.push(body.value.requestId);
        this.unacked.delete(body.value.requestId);
        return;
      case "error":
        this.errors.push(body.value.code);
        return;
      case "taskAssign":
        this.assigned.push(body.value);
        await this.#run(body.value);
        return;
      case "repoChange": {
        const c = body.value;
        this.repoChanges.push({ op: c.op, path: c.path, name: c.name, paths: [...c.paths] });
        const o = this.options;
        let ok = false;
        let message: string;
        if (o.remoteRepos === false) {
          message = "Repo changes from Sling are off on this machine.";
        } else if (c.op === RepoChange_Op.ADD && c.paths.length > 0) {
          const hits = (o.foundRepos ?? []).filter((f) => c.paths.includes(f.path));
          ok = hits.length > 0;
          message = ok
            ? `Added ${hits.length} repos: ${hits.map((f) => f.name).join(", ")}.`
            : "None of those paths are ones this machine found.";
          o.foundRepos = o.foundRepos?.filter((f) => !hits.includes(f));
          for (const f of hits) o.repos.push({ name: f.name, remoteUrl: f.remoteUrl ?? "" });
        } else if (c.op === RepoChange_Op.ADD) {
          const found = o.foundRepos?.find((f) => f.path === c.path);
          if (found) {
            ok = true;
            message = `Allowed ${c.name || found.name}.`;
            o.foundRepos = o.foundRepos?.filter((f) => f !== found);
            o.repos.push({ name: c.name || found.name, remoteUrl: found.remoteUrl ?? "" });
          } else {
            message = "That path isn't one this machine found.";
          }
        } else {
          ok = o.repos.some((r) => r.name === c.name);
          message = ok ? `Removed ${c.name}.` : `No repo named ${c.name}.`;
          o.repos = o.repos.filter((r) => r.name !== c.name);
        }
        this.#send(
          create(EnvelopeSchema, {
            body: { case: "repoChangeResult", value: { requestId: c.requestId, ok, message } },
          }),
        );
        if (ok) this.#sendInventory();
        return;
      }
      case "chatTurn": {
        const t = body.value;
        this.chatTurns.push(t);
        void this.#chat(t);
        return;
      }
      case "repoScan":
        this.scans++;
        this.#sendInventory();
        return;
      case "taskCancel":
        this.#event(body.value.taskId, {
          case: "finished",
          value: { outcome: TaskFinished_Outcome.CANCELLED, error: "Cancelled." },
        });
        return;
      case "actionRequest": {
        const a = body.value;
        this.actions.push({ actionId: a.actionId, taskId: a.taskId, kind: a.kind });
        const work = this.#work.get(a.taskId);
        let failure = "";
        if (work && a.kind === ActionRequest_Kind.PUSH) {
          try {
            await git(work.wt, "push", "-q", "origin", `HEAD:refs/heads/${work.branch}`);
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }
        }
        const url =
          a.kind === ActionRequest_Kind.OPEN_PR && this.options.prUrl
            ? this.options.prUrl(a.taskId)
            : `https://git.example.test/compare/${a.taskId}`;
        this.#event(a.taskId, {
          case: "actionResult",
          value: {
            actionId: a.actionId,
            kind: a.kind,
            outcome: failure ? ActionResult_Outcome.FAILED : ActionResult_Outcome.SUCCEEDED,
            message: failure,
            url: failure ? "" : url,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  #event(taskId: string, kind: EventKind) {
    const seq = (this.#seq.get(taskId) ?? 0) + 1;
    this.#seq.set(taskId, seq);
    const event = create(TaskEventSchema, {
      taskId,
      seq: BigInt(seq),
      atMs: BigInt(Date.now()),
      kind,
    });
    this.#send(create(EnvelopeSchema, { body: { case: "taskEvent", value: event } }));
  }

  async #run(t: TaskAssign) {
    this.#event(t.taskId, { case: "accepted", value: {} });
    this.#event(t.taskId, {
      case: "started",
      value: {
        branch: t.branch,
        baseSha: "0000000000000000000000000000000000000000",
        worktreePath: `/work/${t.taskId}`,
        harness: t.harness,
        harnessVersion: `fake-${t.harness} 1.0`,
      },
    });
    const what = scenario(t.objective);
    if (what === "hang") return;
    await new Promise((r) => setTimeout(r, 20));
    let commitSha = "1111111111111111111111111111111111111111";
    const repo = this.options.repos.find((r) => r.name === t.repo);
    if (what === "succeed" && repo?.path) commitSha = await this.#commit(t, repo, repo.path);
    this.#event(t.taskId, {
      case: "finished",
      value:
        what === "fail"
          ? { outcome: TaskFinished_Outcome.FAILED, error: "The fake task failed." }
          : {
              outcome: TaskFinished_Outcome.SUCCEEDED,
              summary: `Did "${t.title}" with ${t.harness}.`,
              branch: t.branch,
              commitSha,
              diffStats: { filesChanged: 1, insertions: 2, deletions: 0 },
            },
    });
  }

  /** What fake-codex's success scenario does: one line in SLING_FAKE.md, committed on the task's branch. */
  async #commit(t: TaskAssign, repo: FakeRepo, path: string): Promise<string> {
    const wt = join(dirname(path), `wt-${this.options.name}-${t.taskId}`);
    await git(path, "fetch", "-q", "origin");
    await git(
      path,
      "worktree",
      "add",
      "-q",
      "-B",
      t.branch,
      wt,
      `origin/${repo.defaultBranch ?? "main"}`,
    );
    await appendFile(join(wt, "SLING_FAKE.md"), `- ${t.title}\n`);
    await git(wt, "add", "SLING_FAKE.md");
    await git(wt, "commit", "-qm", t.title);
    this.#work.set(t.taskId, { repo, wt, branch: t.branch });
    return git(wt, "rev-parse", "HEAD");
  }

  #result(
    r: Omit<RepoActionResult, "$typeName" | "$unknown" | "ciChecks"> &
      Partial<Pick<RepoActionResult, "ciChecks">>,
  ) {
    const value = create(RepoActionResultSchema, r);
    this.unacked.set(r.requestId, value);
    if (this.holdNextResult) {
      this.holdNextResult = false;
      return;
    }
    this.#send(create(EnvelopeSchema, { body: { case: "repoActionResult", value } }));
  }

  /** A merge or deploy, with the real Runner's refusals. */
  async #repoAction(a: RepoAction) {
    const base = { requestId: a.requestId, kind: a.kind, commitSha: "", url: "" };
    const refuse = (message: string) =>
      this.#result({ ...base, outcome: RepoActionResult_Outcome.REFUSED, message });
    const repo = this.options.repos.find((r) => r.name === a.repo);
    if (!repo) return refuse(`No repo named ${a.repo} on this machine.`);
    if (a.kind === RepoAction_Kind.CI) {
      // Reading CI changes nothing, so deploys off doesn't refuse it.
      const ci = this.options.ci?.(a.prUrl);
      if (!ci) return refuse("Unknown repo action.");
      if ("error" in ci) {
        return this.#result({
          ...base,
          outcome: RepoActionResult_Outcome.FAILED,
          message: ci.error,
        });
      }
      return this.#result({
        ...base,
        outcome: RepoActionResult_Outcome.SUCCEEDED,
        message: "",
        ciChecks: ci.checks.map((c) => create(CiCheckSchema, c)),
      });
    }
    if (this.options.deploys === false) {
      return refuse("Merges and deploys are off on this machine (deploys off).");
    }
    if (this.options.maxMode === PermissionMode.READ_ONLY) {
      return refuse("This machine's max mode is Read-only, so it doesn't merge or deploy.");
    }
    if (a.kind === RepoAction_Kind.MERGE) {
      if (!/^sling\/[A-Za-z0-9._-]+$/.test(a.branch)) {
        return refuse(`${a.branch} isn't a Sling task branch, so this machine won't merge it.`);
      }
      if (!repo.path) {
        return this.#result({
          ...base,
          outcome: RepoActionResult_Outcome.SUCCEEDED,
          message: "Merged.",
          commitSha: "2222222222222222222222222222222222222222",
          url: a.prUrl,
        });
      }
      return this.#merge(a, repo.path, base);
    }
    if (!repo.deployCommand)
      return refuse(`No deploy command is set for ${a.repo} on this machine.`);
    if (!repo.path) {
      return this.#result({
        ...base,
        outcome: RepoActionResult_Outcome.SUCCEEDED,
        message: "Deployed.",
        commitSha: a.commitSha,
      });
    }
    return this.#deploy(a, repo.path, repo.deployCommand, base);
  }

  async #merge(
    a: RepoAction,
    path: string,
    base: { requestId: string; kind: RepoAction_Kind; commitSha: string; url: string },
  ) {
    const trailer = `Sling-Task: ${a.taskId}`;
    await git(path, "fetch", "-q", "origin");
    const earlier = await git(
      path,
      "log",
      `origin/${a.defaultBranch}`,
      "--fixed-strings",
      `--grep=${trailer}`,
      "--format=%H",
      "-n",
      "1",
    );
    if (earlier) {
      return this.#result({
        ...base,
        outcome: RepoActionResult_Outcome.SUCCEEDED,
        message: "It was already merged.",
        commitSha: earlier,
        url: a.prUrl,
      });
    }
    const wt = await mkdtemp(join(tmpdir(), "fake-merge-"));
    try {
      await git(path, "worktree", "add", "-q", "--detach", wt, `origin/${a.defaultBranch}`);
      const squash = a.mergeMethod !== "merge";
      try {
        await git(
          wt,
          "merge",
          ...(squash ? ["--squash"] : ["--no-ff", "--no-commit"]),
          `origin/${a.branch}`,
        );
      } catch {
        const files = await git(wt, "diff", "--name-only", "--diff-filter=U");
        await git(wt, "merge", "--abort").catch(() => {});
        return this.#result({
          ...base,
          outcome: RepoActionResult_Outcome.FAILED,
          message: `The merge conflicts in ${files.split("\n").join(", ")}.`,
        });
      }
      await git(wt, "commit", "-qm", `${a.title}\n\n${a.body}\n\n${trailer}`);
      await git(wt, "push", "-q", "origin", `HEAD:refs/heads/${a.defaultBranch}`);
      const sha = await git(wt, "rev-parse", "HEAD");
      this.#result({
        ...base,
        outcome: RepoActionResult_Outcome.SUCCEEDED,
        message:
          a.mergeMethod === "rebase"
            ? `Squash-merged into ${a.defaultBranch}: rebase needs gh, so it squashed instead.`
            : `Merged into ${a.defaultBranch}.`,
        commitSha: sha,
        url: a.prUrl,
      });
    } finally {
      await git(path, "worktree", "remove", "--force", wt).catch(() => {});
      await rm(wt, { recursive: true, force: true });
    }
  }

  async #deploy(
    a: RepoAction,
    path: string,
    command: string,
    base: { requestId: string; kind: RepoAction_Kind; commitSha: string; url: string },
  ) {
    await git(path, "fetch", "-q", "origin");
    const onDefault = await git(
      path,
      "merge-base",
      "--is-ancestor",
      a.commitSha,
      `origin/${a.defaultBranch}`,
    )
      .then(() => true)
      .catch(() => false);
    if (!onDefault) {
      return this.#result({
        ...base,
        outcome: RepoActionResult_Outcome.REFUSED,
        message: `${a.commitSha.slice(0, 7)} isn't on origin/${a.defaultBranch}, so this machine won't deploy it.`,
      });
    }
    const wt = await mkdtemp(join(tmpdir(), "fake-deploy-"));
    try {
      await git(path, "worktree", "add", "-q", "--detach", wt, a.commitSha);
      const code = await new Promise<number>((ok) => {
        const child = spawn("sh", ["-c", command], {
          cwd: wt,
          env: { ...process.env, SLING_DEPLOY_COMMIT: a.commitSha, SLING_DEPLOY_REPO: a.repo },
        });
        const out = (chunk: Buffer) =>
          this.#send(
            create(EnvelopeSchema, {
              body: {
                case: "repoActionOutput",
                value: { requestId: a.requestId, chunk: chunk.toString("utf8") },
              },
            }),
          );
        child.stdout.on("data", out);
        child.stderr.on("data", out);
        child.on("close", (c) => ok(c ?? 1));
      });
      this.#result({
        ...base,
        outcome: code === 0 ? RepoActionResult_Outcome.SUCCEEDED : RepoActionResult_Outcome.FAILED,
        message: code === 0 ? "Deployed." : "The deploy command failed.",
        commitSha: a.commitSha,
        exitCode: code,
      });
    } finally {
      await git(path, "worktree", "remove", "--force", wt).catch(() => {});
      await rm(wt, { recursive: true, force: true });
    }
  }
}

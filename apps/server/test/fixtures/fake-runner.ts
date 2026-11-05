/**
 * A Runner in TypeScript, for tests: it pairs with a one-time code, signs the
 * handshake, reports an inventory, and plays tasks and actions back without a
 * coding agent. Machines with labels or Claude Code, and the fake execution
 * provider's sandboxes, use it.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  ActionResult_Outcome,
  authPayload,
  type ChatEventSchema,
  type ChatTurn,
  create,
  decodeEnvelope,
  type Envelope,
  EnvelopeSchema,
  encodeEnvelope,
  PermissionMode,
  RepoChange_Op,
  RUNNER_WS_PATH,
  type TaskAssign,
  TaskEventSchema,
  TaskFinished_Outcome,
} from "@sling/runner-protocol";

type EventKind = MessageInitShape<typeof TaskEventSchema>["kind"];

export interface FakeRepo {
  name: string;
  remoteUrl: string;
  defaultBranch?: string;
  network?: boolean;
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
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        if (!welcomed) fail(new Error(`closed before welcome, errors ${this.errors.join(",")}`));
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
        this.#event(a.taskId, {
          case: "actionResult",
          value: {
            actionId: a.actionId,
            kind: a.kind,
            outcome: ActionResult_Outcome.SUCCEEDED,
            message: "",
            url: `https://git.example.test/compare/${a.taskId}`,
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
    this.#event(t.taskId, {
      case: "finished",
      value:
        what === "fail"
          ? { outcome: TaskFinished_Outcome.FAILED, error: "The fake task failed." }
          : {
              outcome: TaskFinished_Outcome.SUCCEEDED,
              summary: `Did "${t.title}" with ${t.harness}.`,
              branch: t.branch,
              commitSha: "1111111111111111111111111111111111111111",
              diffStats: { filesChanged: 1, insertions: 2, deletions: 0 },
            },
    });
  }
}

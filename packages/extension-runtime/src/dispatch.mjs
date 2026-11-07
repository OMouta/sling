/**
 * Answers the server's calls by running the extension's own code: describe,
 * connection tests, node runs, trigger matches, event sources, and sandbox
 * providers. The server checks every result again; these checks only give
 * the extension clearer errors.
 */

/**
 * @typedef {{
 *   request(method: string, params: unknown, signal?: AbortSignal): Promise<any>,
 *   notify(method: string, params: unknown): void,
 * }} DispatchPeer
 * @typedef {{ info(m: string, d?: object): void, warn(m: string, d?: object): void, error(m: string, d?: object): void }} Logger
 * @typedef {(level: "info" | "warn" | "error", message: string, data: unknown, scope: unknown) => void} LogFn
 */

/**
 * A NodeError that crosses the channel by name, so the server rebuilds it
 * with the same code.
 */
class NodeError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = "NodeError";
    this.code = code;
    this.retryable = false;
  }
}

/**
 * @param {any} schema
 * @param {unknown} value
 * @returns {{ success: true, data: any } | { success: false, error: string }}
 */
function parseWith(schema, value) {
  if (!schema || typeof schema.safeParse !== "function") return { success: true, data: value };
  const r = schema.safeParse(value);
  if (r.success) return { success: true, data: r.data };
  const issues = Array.isArray(r.error?.issues) ? r.error.issues : [];
  const detail = issues
    .map(
      (/** @type {any} */ i) =>
        `${(Array.isArray(i.path) ? i.path.map(String).join(".") : "") || "config"}: ${i.message}`,
    )
    .join("; ");
  return { success: false, error: detail || String(r.error?.message ?? "invalid") };
}

/**
 * @param {LogFn} log
 * @param {unknown} scope
 * @returns {Logger}
 */
function scopedLogger(log, scope) {
  return {
    info: (m, d) => log("info", String(m), d, scope),
    warn: (m, d) => log("warn", String(m), d, scope),
    error: (m, d) => log("error", String(m), d, scope),
  };
}

/**
 * @param {any} definition The bundle's default export.
 * @param {string} extensionId
 * @param {DispatchPeer} peer
 * @param {LogFn} log
 */
export function createDispatcher(definition, extensionId, peer, log) {
  /** @type {Map<string, any>} */
  const connectors = new Map();
  /** @type {Map<string, any>} */
  const nodes = new Map();
  for (const c of definition.connectors) {
    connectors.set(c.id, c);
    for (const n of c.nodes ?? []) nodes.set(`${n.type}@${n.version}`, n);
  }
  /** Running event sources by the server's source ID. @type {Map<number, { abort: AbortController, source: any }>} */
  const sources = new Map();

  /** @param {unknown} id */
  function connector(id) {
    const c = connectors.get(String(id));
    if (!c) throw new Error(`This extension has no connector ${String(id)}`);
    return c;
  }

  /** @param {any} p */
  function node(p) {
    const n = nodes.get(`${p.type}@${p.version}`);
    if (!n) throw new Error(`This extension has no node ${p.type} version ${p.version}`);
    return n;
  }

  /**
   * @param {any} p
   * @param {AbortSignal} signal
   */
  function nodeContext(p, signal) {
    const c = p.ctx ?? {};
    const scope = p.scope;
    return {
      runId: c.runId,
      nodeId: c.nodeId,
      nodeRunId: c.nodeRunId,
      workflowId: c.workflowId,
      workspaceId: c.workspaceId,
      ownerId: c.ownerId,
      iteration: c.iteration,
      attempt: c.attempt,
      idempotencyKey: c.idempotencyKey,
      signal,
      log: scopedLogger(log, scope),
      /** @param {string} id */
      installation: (id) => peer.request("installation", { scope, id: String(id) }, signal),
      services: undefined,
    };
  }

  /**
   * @param {any} p
   * @param {AbortSignal} signal
   */
  function providerContext(p, signal) {
    const c = p.ctx ?? {};
    const conn = connector(p.connector);
    const credentials = parseWith(conn.credentialsSchema, c.credentials);
    if (!credentials.success) throw new Error(`Invalid credentials: ${credentials.error}`);
    const config = parseWith(conn.configSchema, c.config);
    if (!config.success) throw new Error(`Invalid config: ${config.error}`);
    if (!conn.executionProvider) throw new Error(`Connector ${conn.id} doesn't provide sandboxes`);
    return {
      provider: conn.executionProvider,
      ctx: {
        installationId: c.installationId,
        workspaceId: c.workspaceId,
        credentials: credentials.data,
        config: config.data,
        log: scopedLogger(log, p.scope),
        signal,
      },
    };
  }

  /**
   * @param {any} p
   * @param {AbortSignal} signal
   * @param {boolean} resume
   */
  async function runNode(p, signal, resume) {
    const spec = node(p);
    const fn = resume ? spec.resume : spec.run;
    if (typeof fn !== "function") {
      throw new Error(`Node ${spec.type} has no ${resume ? "resume" : "run"} function`);
    }
    const config = parseWith(spec.configSchema, p.config);
    if (!config.success) throw new NodeError(`Invalid config: ${config.error}`, "invalid_config");
    const args = resume
      ? { inputs: p.inputs ?? {}, config: config.data, resolution: p.resolution }
      : { inputs: p.inputs ?? {}, config: config.data };
    const result = await fn.call(spec, nodeContext(p, signal), args);
    checkWait(result?.wait);
    return result;
  }

  /**
   * @param {any} p
   * @param {AbortSignal} signal
   */
  async function verifyNode(p, signal) {
    const spec = node(p);
    if (typeof spec.verify !== "function") {
      throw new Error(`Node ${spec.type} has no verify function`);
    }
    const config = parseWith(spec.configSchema, p.config);
    if (!config.success) throw new NodeError(`Invalid config: ${config.error}`, "invalid_config");
    return await spec.verify(nodeContext(p, signal), {
      inputs: p.inputs ?? {},
      config: config.data,
      outputs: p.outputs ?? {},
    });
  }

  /**
   * Extension nodes can wait for a time or for one of their own events.
   * Approvals and tasks belong to Sling.
   * @param {any} wait
   */
  function checkWait(wait) {
    if (wait === undefined) return;
    if (wait?.kind === "timer") return;
    if (wait?.kind === "event") {
      const type = String(wait.eventType ?? "");
      if (type.startsWith(`${extensionId}.`)) return;
      throw new NodeError(
        `A node can only wait for its extension's own events, not ${type}`,
        "invalid_wait",
      );
    }
    throw new NodeError(
      `An extension node can wait for a timer or an event, not ${String(wait?.kind)}`,
      "invalid_wait",
    );
  }

  /**
   * @param {any} p
   * @param {AbortSignal} signal
   */
  async function startSource(p, signal) {
    const conn = connector(p.connector);
    if (!conn.source) throw new Error(`Connector ${conn.id} has no event source`);
    const credentials = parseWith(conn.credentialsSchema, p.credentials);
    if (!credentials.success) throw new Error(`Invalid credentials: ${credentials.error}`);
    const config = parseWith(conn.configSchema, p.config);
    if (!config.success) throw new Error(`Invalid config: ${config.error}`);
    const sid = p.sid;
    const abort = new AbortController();
    // Cancelling the start call stops the source too.
    signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
    const ctx = {
      installationId: p.installationId,
      workspaceId: p.workspaceId,
      credentials: credentials.data,
      config: config.data,
      log: scopedLogger(log, `source:${sid}`),
      signal: abort.signal,
      /** @param {unknown} event */
      emit: (event) => peer.request("source.emit", { sid, event }),
      state: {
        /** @param {string} key */
        get: (key) => peer.request("source.state.get", { sid, key: String(key) }),
        /**
         * @param {string} key
         * @param {string} value
         */
        set: (key, value) =>
          peer.request("source.state.set", { sid, key: String(key), value: String(value) }),
      },
      approvals: {
        /** @param {unknown} decision */
        decide: (decision) => peer.request("source.decide", { sid, decision }),
        /** @param {unknown} decision */
        reportRefused: (decision) => peer.request("source.refused", { sid, decision }),
      },
      /**
       * @param {string} status
       * @param {string} [detail]
       */
      setStatus: (status, detail) => {
        if (abort.signal.aborted) return;
        peer.notify("source.status", {
          sid,
          status: String(status),
          detail: detail === undefined ? null : String(detail),
        });
      },
    };
    const entry = { abort, source: /** @type {any} */ (null) };
    sources.set(sid, entry);
    try {
      entry.source = await conn.source.start(ctx);
    } catch (err) {
      sources.delete(sid);
      abort.abort();
      throw err;
    }
    if (abort.signal.aborted) {
      sources.delete(sid);
      await entry.source?.stop?.();
    }
    return null;
  }

  /** @param {any} p */
  async function stopSource(p) {
    const entry = sources.get(p.sid);
    if (!entry) return null;
    sources.delete(p.sid);
    entry.abort.abort();
    await entry.source?.stop?.();
    return null;
  }

  /**
   * @param {string} method
   * @param {any} p
   * @param {AbortSignal} signal
   * @returns {Promise<unknown>}
   */
  return async function dispatch(method, p, signal) {
    switch (method) {
      case "describe":
        return definition.describe();
      case "test": {
        const conn = connector(p.connector);
        const credentials = parseWith(conn.credentialsSchema, p.credentials);
        if (!credentials.success) {
          return { ok: false, error: `Invalid credentials: ${credentials.error}` };
        }
        const config = parseWith(conn.configSchema, p.config);
        if (!config.success) return { ok: false, error: `Invalid config: ${config.error}` };
        return await conn.test({
          credentials: credentials.data,
          config: config.data,
          log: scopedLogger(log, p.scope),
          signal,
        });
      }
      case "setup": {
        const conn = connector(p.connector);
        if (typeof conn.setup !== "function") return {};
        // What's typed so far, unchecked: setup runs before the form is complete.
        return await conn.setup({
          credentials: p.credentials ?? {},
          config: p.config ?? {},
          log: scopedLogger(log, p.scope),
          signal,
        });
      }
      case "run":
        return await runNode(p, signal, false);
      case "resume":
        return await runNode(p, signal, true);
      case "verify":
        return await verifyNode(p, signal);
      case "match": {
        const spec = node(p);
        if (!spec.trigger) throw new Error(`Node ${spec.type} isn't a trigger`);
        const config = parseWith(spec.configSchema, p.config);
        if (!config.success) return null;
        return (await spec.trigger.match(p.event, config.data)) ?? null;
      }
      case "source.start":
        return await startSource(p, signal);
      case "source.stop":
        return await stopSource(p);
      case "provider.create": {
        const { provider, ctx } = providerContext(p, signal);
        return await provider.create(ctx, p.spec);
      }
      case "provider.destroy": {
        const { provider, ctx } = providerContext(p, signal);
        await provider.destroy(ctx, String(p.externalId));
        return null;
      }
      case "provider.list": {
        const { provider, ctx } = providerContext(p, signal);
        return await provider.list(ctx);
      }
      default:
        throw new Error(`Unknown call ${method}`);
    }
  };
}

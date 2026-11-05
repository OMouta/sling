import type { AnyConnector } from "@sling/connector-sdk";
import {
  type AnyNodeSpec,
  NAMED_TYPES,
  type NodeCatalog,
  type NodeSpecView,
  type SpecLookup,
  specKey,
} from "@sling/workflow";
import { z } from "zod";
import type { AnyServerNodeSpec } from "./types.ts";

/** JSON Schema for a zod schema as the editor fills it in (defaults optional). */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    const out = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" });
    const { $schema: _drop, ...rest } = out as Record<string, unknown>;
    return rest;
  } catch {
    return {};
  }
}

/** Every node type the server can run, plus the connectors that provided some of them. */
export class NodeRegistry implements SpecLookup {
  readonly #specs = new Map<string, AnyServerNodeSpec>();
  readonly #connectors = new Map<string, AnyConnector>();
  #catalog: NodeCatalog | null = null;

  register(spec: AnyNodeSpec | AnyServerNodeSpec): void {
    const key = specKey(spec.type, spec.version);
    if (this.#specs.has(key)) throw new Error(`Node ${key} is registered twice`);
    if (!spec.trigger && !spec.run) throw new Error(`Node ${key} needs run() or a trigger`);
    this.#specs.set(key, spec as AnyServerNodeSpec);
    this.#catalog = null;
  }

  /** Adds a connector's nodes and keeps the definition for the connector runtime. */
  registerConnector(def: AnyConnector): void {
    if (this.#connectors.has(def.id)) throw new Error(`Connector ${def.id} is registered twice`);
    for (const spec of def.nodes) {
      this.register({ ...spec, connector: spec.connector ?? def.id });
    }
    this.#connectors.set(def.id, def);
  }

  get(type: string, version: number): AnyServerNodeSpec | undefined {
    return this.#specs.get(specKey(type, version));
  }

  /** The highest registered version of a type. */
  latest(type: string): AnyServerNodeSpec | undefined {
    let best: AnyServerNodeSpec | undefined;
    for (const s of this.#specs.values()) {
      if (s.type === type && (!best || s.version > best.version)) best = s;
    }
    return best;
  }

  specs(): AnyServerNodeSpec[] {
    return [...this.#specs.values()];
  }

  connector(id: string): AnyConnector | undefined {
    return this.#connectors.get(id);
  }

  connectors(): AnyConnector[] {
    return [...this.#connectors.values()];
  }

  catalog(): NodeCatalog {
    if (this.#catalog) return this.#catalog;
    const nodes: NodeSpecView[] = this.specs()
      .map((s) => ({
        type: s.type,
        version: s.version,
        title: s.title,
        description: s.description,
        category: s.category,
        connector: s.connector ?? null,
        inputs: s.inputs,
        outputs: s.outputs,
        execInput: s.execInput,
        execOutputs: s.execOutputs,
        dynamicExecOutputs: s.dynamicExecOutputs ?? null,
        configSchema: toJsonSchema(s.configSchema),
        expressionFields: s.expressionFields ?? [],
        installationFields: s.installationFields ?? [],
        idempotent: s.idempotent,
        isTrigger: !s.execInput,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version);
    this.#catalog = { nodes, types: Object.values(NAMED_TYPES) };
    return this.#catalog;
  }
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type SpecLookup,
  type TemplateBinding,
  type TemplateView,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "@sling/workflow";
import { z } from "zod";

/** The repo's `workflows/` directory, next to `apps/`. */
export const TEMPLATES_DIR = fileURLToPath(new URL("../../../../workflows/", import.meta.url));

const TemplateFile = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  builtIn: z.boolean().default(false),
  bindings: z
    .array(
      z.object({
        placeholder: z.string().regex(/^\$[a-z][a-z0-9_]*$/),
        connectorId: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .default([]),
});

export interface Template {
  view: TemplateView;
  definition: WorkflowDefinition;
}

/** Reads every `workflows/<key>/{template.json,workflow.json}`. Broken templates are skipped. */
export function loadTemplates(
  dir: string,
  onError: (key: string, err: unknown) => void = () => {},
): Template[] {
  if (!existsSync(dir)) return [];
  const out: Template[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = join(dir, entry.name);
    try {
      const meta = TemplateFile.parse(
        JSON.parse(readFileSync(join(base, "template.json"), "utf8")),
      );
      const definition = WorkflowDefinitionSchema.parse(
        JSON.parse(readFileSync(join(base, "workflow.json"), "utf8")),
      );
      out.push({
        view: {
          key: meta.key,
          name: meta.name,
          description: meta.description,
          bindings: meta.bindings as TemplateBinding[],
          builtIn: meta.builtIn,
        },
        definition,
      });
    } catch (err) {
      onError(entry.name, err);
    }
  }
  return out.sort((a, b) => a.view.name.localeCompare(b.view.name));
}

/** Node types a template uses that the server doesn't have. */
export function missingNodeTypes(registry: SpecLookup, def: WorkflowDefinition): string[] {
  const missing = new Set<string>();
  for (const n of def.nodes) {
    if (!registry.get(n.type, n.version)) missing.add(`${n.type}@${n.version}`);
  }
  return [...missing];
}

function replace(value: unknown, map: Record<string, string>): unknown {
  if (typeof value === "string") return Object.hasOwn(map, value) ? map[value] : value;
  if (Array.isArray(value)) return value.map((v) => replace(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, map)]));
  }
  return value;
}

/** Swaps placeholders such as `"$discord"` for installation IDs wherever they're a whole config value. */
export function applyBindings(
  def: WorkflowDefinition,
  map: Record<string, string>,
): WorkflowDefinition {
  return {
    ...def,
    nodes: def.nodes.map((n) => ({
      ...n,
      config: replace(n.config, map) as Record<string, unknown>,
    })),
  };
}

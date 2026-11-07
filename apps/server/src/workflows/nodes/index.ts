import type { NodeRegistry } from "../registry.ts";
import { agentNodes } from "./agent.ts";
import { aiNodes } from "./ai.ts";
import { appNodes } from "./app.ts";
import { checkNodes } from "./checks.ts";
import { deployNodes } from "./deploys.ts";
import { httpRequestNode } from "./http.ts";
import { approvalNode } from "./human.ts";
import { logicNodes } from "./logic.ts";
import { stateNodes } from "./state.ts";
import { triggerNodes } from "./triggers.ts";

/** Registers every node that ships with the server. */
export function registerCoreNodes(registry: NodeRegistry): void {
  for (const spec of [
    ...triggerNodes,
    ...logicNodes,
    httpRequestNode,
    ...stateNodes,
    ...aiNodes,
    approvalNode,
    ...agentNodes,
    ...appNodes,
    ...deployNodes,
    ...checkNodes,
  ]) {
    registry.register(spec);
  }
}

import type { AssistantChoice } from "@sling/core";
import { useModelCatalog } from "../lib/models.ts";
import { ChatControls } from "./ModelPicker.tsx";

/**
 * The model a personality's chats start on, in the chat's own picker. A
 * chat can still switch. Workspace default leaves it to the workspace.
 */
export function PersonalityModel({
  value,
  onChange,
}: {
  value: AssistantChoice | null;
  onChange: (choice: AssistantChoice | null) => void;
}) {
  const catalog = useModelCatalog();
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Model</h2>
      <div className="inline-flex max-w-full rounded-xl bg-field p-1 shadow-field">
        <ChatControls
          catalog={catalog.data}
          assistant={value}
          onAssistant={onChange}
          onDefault={() => onChange(null)}
        />
      </div>
    </section>
  );
}

export function sameChoice(a: AssistantChoice | null, b: AssistantChoice | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.fast === b.fast
  );
}

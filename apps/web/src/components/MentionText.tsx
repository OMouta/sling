import type { PersonalityView } from "@sling/core";
import { colorVar } from "../lib/personalities.ts";

/** A message's text, with its `@Name` in the mentioned personality's color. */
export function MentionText({
  text,
  personality,
}: {
  text: string;
  personality: PersonalityView | undefined;
}) {
  const token = personality ? `@${personality.name}` : "";
  const at = token ? text.indexOf(token) : -1;
  if (!personality || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="font-medium" style={{ color: colorVar(personality.color) }}>
        {token}
      </span>
      {text.slice(at + token.length)}
    </>
  );
}

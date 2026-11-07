import { Fragment } from "react";
import { Mono } from "./ui.tsx";

/**
 * Text with its `backticked` commands shown as code, each selected whole
 * with one click so it's easy to copy into a terminal.
 */
export function CodeText({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
      <Mono key={i} className="select-all box-decoration-clone">
        {part.slice(1, -1)}
      </Mono>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

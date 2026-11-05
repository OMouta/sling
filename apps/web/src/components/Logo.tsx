import icon from "../../../../assets/icons/sling-icon-currentcolor.svg?raw";
import { cx } from "./ui.tsx";

/** The Sling mark, drawn in the current text color. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cx("inline-block [&>svg]:size-full", className ?? "size-6")}
      // Our own static asset, imported at build time.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, bundled SVG.
      dangerouslySetInnerHTML={{ __html: icon }}
    />
  );
}

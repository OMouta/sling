import type { RunnerView } from "@sling/core";
import { FolderOpen } from "lucide-react";
import { Mono } from "./ui.tsx";
import { CopyLine } from "./WizardBits.tsx";

/** The folders a machine shares with the assistant. Only the machine adds one. */
export function FolderSection({ runner }: { runner: RunnerView }) {
  const folders = runner.folders;
  return (
    <section aria-label={`Folders on ${runner.name}`} className="border-t border-border">
      <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-2">
        <span className="section-label">Folders</span>
        <span className="text-xs text-subtle tabular">
          {folders.length === 0
            ? "None shared"
            : runner.files
              ? `${folders.length} shared`
              : `${folders.length} shared, off`}
        </span>
      </div>
      {folders.length === 0 ? (
        <div className="border-t border-border px-4 py-3">
          <CopyLine text="sling-runner folder add ~/Documents" />
        </div>
      ) : (
        <ul aria-label={`Folder list for ${runner.name}`} className="border-t border-border">
          {folders.map((name) => (
            <li
              key={name}
              className="flex h-11 items-center gap-3 border-t border-border px-4 first:border-t-0"
            >
              <FolderOpen
                aria-hidden="true"
                size={16}
                className={runner.files ? "shrink-0 text-icon" : "shrink-0 text-faint"}
              />
              <span
                className={
                  runner.files ? "truncate text-[13px]" : "truncate text-[13px] text-muted"
                }
              >
                {name}
              </span>
            </li>
          ))}
        </ul>
      )}
      {folders.length > 0 && !runner.files && (
        <p className="border-t border-border px-4 py-2.5 text-xs leading-4 text-subtle">
          To let Sling search and read them, run <Mono>sling-runner config set files on</Mono> on
          the machine.
        </p>
      )}
    </section>
  );
}

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { extensionApi } from "../../lib/extensionApi.ts";
import { EXTENSION_ID, SEMVER, suggestPackageId } from "../../lib/extensions.ts";
import { Button, Dialog, ErrorText, Field, Input } from "../ui.tsx";

/**
 * Downloads a workflow as an unsigned package other Sling servers can
 * install. The server swaps installation IDs for bindings.
 */
export function ExportPackageDialog({
  workflowId,
  workflowName,
  activeVersion,
  onClose,
}: {
  workflowId: string;
  workflowName: string;
  activeVersion: number | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(workflowName);
  // The ID follows the name until it's edited.
  const [ownId, setOwnId] = useState<string | null>(null);
  const id = ownId ?? suggestPackageId(name);
  const [version, setVersion] = useState("1.0.0");
  const idOk = EXTENSION_ID.test(id);
  const versionOk = SEMVER.test(version.trim());
  const ready = idOk && versionOk && name.trim().length > 0;

  const save = useMutation({
    mutationFn: () =>
      extensionApi.exportPackage(workflowId, { id, version: version.trim(), name: name.trim() }),
    onSuccess: onClose,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) save.mutate();
  };

  return (
    <Dialog
      title="Export as package"
      description={
        activeVersion === null
          ? "Built from the draft, since nothing is published yet."
          : `Built from version ${activeVersion}, the active one.`
      }
      onClose={onClose}
      footer={
        <>
          <ErrorText error={save.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="export-package"
            busy={save.isPending}
            disabled={!ready}
          >
            Download
          </Button>
        </>
      }
    >
      <form id="export-package" onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field
            label="ID"
            hint={
              id && !idOk
                ? "3 to 40 lowercase letters, digits, and hyphens, starting with a letter."
                : undefined
            }
          >
            <Input
              value={id}
              maxLength={40}
              spellCheck={false}
              autoCapitalize="off"
              aria-invalid={!idOk || undefined}
              className="font-mono text-[12.5px]"
              onChange={(e) => setOwnId(e.target.value.toLowerCase())}
            />
          </Field>
          <Field label="Version" hint={version && !versionOk ? "Like 1.0.0." : undefined}>
            <Input
              value={version}
              maxLength={40}
              spellCheck={false}
              aria-invalid={!versionOk || undefined}
              className="tabular"
              onChange={(e) => setVersion(e.target.value)}
            />
          </Field>
        </div>
        <p className="text-xs leading-4 text-muted">
          Connector installations become bindings that ask for an installation on install.
          Credentials are never included. The package is unsigned; sign it with{" "}
          <code className="font-mono text-[11.5px] text-soft">sling-ext sign</code> before you share
          it.
        </p>
      </form>
    </Dialog>
  );
}

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { extensionApi } from "../../lib/extensionApi.ts";
import { EXTENSION_ID, SEMVER, suggestPackageId } from "../../lib/extensions.ts";
import { Field, Input } from "../ui.tsx";
import { Wizard, type WizardStep } from "../Wizard.tsx";
import { StepNote } from "../WizardBits.tsx";

/**
 * Downloads a workflow as an unsigned package other Sling servers can
 * install, a step at a time: its name and ID, then its version. The server
 * swaps installation IDs for bindings.
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
  const file = `${id}-${version.trim()}.slx`;

  const save = useMutation({
    mutationFn: () =>
      extensionApi.exportPackage(workflowId, { id, version: version.trim(), name: name.trim() }),
  });

  const steps: WizardStep[] = [
    {
      id: "name",
      title: "What should the package be called?",
      blocked: !name.trim() || !idOk,
      content: (
        <>
          <StepNote>
            From {activeVersion === null ? "the draft" : `version ${activeVersion}`} of{" "}
            {workflowName}
          </StepNote>
          <Field label="Name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="ID"
            hint={
              id && !idOk ? (
                <span className="text-danger">
                  Lowercase letters, digits and hyphens, starting with a letter
                </span>
              ) : undefined
            }
          >
            <Input
              value={id}
              maxLength={40}
              spellCheck={false}
              autoCapitalize="off"
              aria-invalid={(Boolean(id) && !idOk) || undefined}
              className="font-mono text-[12.5px]"
              onChange={(e) => setOwnId(e.target.value.toLowerCase())}
            />
          </Field>
        </>
      ),
    },
    {
      id: "version",
      title: "Which version is it?",
      blocked: !versionOk,
      content: (
        <>
          <Input
            aria-label="Version"
            value={version}
            maxLength={40}
            spellCheck={false}
            aria-invalid={(Boolean(version) && !versionOk) || undefined}
            className="tabular"
            onChange={(e) => setVersion(e.target.value)}
          />
          {version.trim() && !versionOk ? (
            <StepNote tone="error">Like 1.0.0</StepNote>
          ) : (
            <StepNote>Saves {file}</StepNote>
          )}
        </>
      ),
    },
  ];

  return (
    <Wizard
      title="Export as package"
      steps={steps}
      finishLabel="Download"
      finishing={save.isPending}
      error={save.error instanceof Error ? save.error.message : null}
      onFinish={async () => {
        try {
          await save.mutateAsync();
          return true;
        } catch {
          return false;
        }
      }}
      done={
        <>
          <p className="text-sm font-medium">Downloaded {file}</p>
          <p className="mt-1 text-xs leading-4 text-muted">
            Unsigned. Sign it with{" "}
            <code className="font-mono text-[11.5px] whitespace-nowrap text-soft">
              sling-ext sign
            </code>{" "}
            before you share it.
          </p>
        </>
      }
      onClose={onClose}
    />
  );
}

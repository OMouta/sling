import type { PersonalityImportView, PersonalityView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Ellipsis, Upload } from "lucide-react";
import { useRef } from "react";
import { ApiError, api, saveBlob } from "../lib/api.ts";
import { personalitiesKey } from "../lib/personalities.ts";
import { Button, ErrorText, Menu, MenuItem, Spinner } from "./ui.tsx";

/** Largest personality file the server takes. */
const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/** Saves a personality as a file, with its sources. */
export function useExportPersonality() {
  return useMutation({
    mutationFn: async (p: PersonalityView) => {
      const res = await fetch(`/api/personalities/${p.id}/export`, { credentials: "same-origin" });
      if (!res.ok) throw new ApiError(res.status, `Couldn't export ${p.name}.`);
      saveBlob(`${p.name}.sling-personality.json`, await res.blob());
    },
  });
}

/** The editor's menu. */
export function PersonalityMenu({ personality }: { personality: PersonalityView }) {
  const exportFile = useExportPersonality();
  return (
    <>
      <ErrorText error={exportFile.error} />
      <Menu
        label={`${personality.name} actions`}
        align="end"
        trigger={({ open, toggle }) => (
          <Button
            variant="ghost"
            iconOnly
            icon={Ellipsis}
            aria-label={`${personality.name} actions`}
            aria-expanded={open}
            onClick={toggle}
          />
        )}
      >
        <MenuItem icon={Download} onSelect={() => exportFile.mutate(personality)}>
          Export
        </MenuItem>
      </Menu>
    </>
  );
}

/**
 * Adds a personality from a file someone exported, then opens it. Sits
 * with the other places a new personality can start from.
 */
export function FromFileCard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const add = useMutation({
    mutationFn: (file: File) => {
      if (file.size > IMPORT_MAX_BYTES) throw new Error("This file is bigger than 100 MB.");
      return api.post<PersonalityImportView>("/api/personalities/import", file);
    },
    onSuccess: ({ personality: p }) => {
      qc.setQueryData<PersonalityView[]>(personalitiesKey, (l) =>
        l && !l.some((x) => x.id === p.id) ? [...l, p] : l,
      );
      void navigate({ to: "/personalities/$id", params: { id: p.id } });
    },
  });
  return (
    <>
      <button
        type="button"
        disabled={add.isPending}
        onClick={() => input.current?.click()}
        className="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl bg-field p-3 text-left shadow-field transition-shadow duration-150 hover:shadow-field-hover focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-wait"
      >
        <span className="grid size-7 shrink-0 place-items-center text-icon">
          {add.isPending ? <Spinner /> : <Upload aria-hidden="true" size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text">From a file</span>
          {add.error ? (
            <span role="alert" className="mt-0.5 block text-xs leading-4 text-danger">
              {add.error.message}
            </span>
          ) : (
            <span className="mt-0.5 block text-xs leading-4 text-muted">
              A personality exported from Sling.
            </span>
          )}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Personality file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) add.mutate(file);
        }}
      />
    </>
  );
}

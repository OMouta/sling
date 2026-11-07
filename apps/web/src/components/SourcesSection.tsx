import { PERSONALITY_MAX_SOURCES, type PersonalityView, type SourceView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, Upload, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { api } from "../lib/api.ts";
import {
  DOCUMENT_ACCEPT,
  kindIcon,
  kindLabel,
  pickFiles,
  sourceDetail,
  sourcesKey,
  uploadSource,
  useSources,
  viewUrl,
} from "../lib/sources.ts";
import { Button, Card, cx, ErrorText, Input, Skeleton, Spinner } from "./ui.tsx";

/**
 * The files and links a personality answers from. Each one is added at
 * once and read on the server; the list follows it until it's ready.
 */
export function SourcesSection({ personality }: { personality: PersonalityView }) {
  const qc = useQueryClient();
  const sources = useSources(personality.id);
  const list = sources.data ?? [];
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const full = list.length >= PERSONALITY_MAX_SOURCES;

  const added = (s: SourceView) =>
    qc.setQueryData<SourceView[]>(sourcesKey(personality.id), (l) =>
      l && !l.some((x) => x.id === s.id) ? [...l, s] : l,
    );
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // One at a time, so the list fills in the order they were picked.
      const failed: string[] = [];
      for (const f of files) {
        try {
          added(await uploadSource(`/api/personalities/${personality.id}/sources`, f, f.name));
        } catch (err) {
          failed.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failed.length) throw new Error(failed.join(" "));
    },
  });
  const link = useMutation({
    mutationFn: (address: string) =>
      api.post<SourceView>(`/api/personalities/${personality.id}/sources/link`, { url: address }),
    onSuccess: (s) => {
      added(s);
      setUrl("");
      setLinking(false);
    },
  });
  const remove = useMutation({
    mutationFn: (s: SourceView) => api.del(`/api/sources/${s.id}`),
    onMutate: (s) =>
      qc.setQueryData<SourceView[]>(sourcesKey(personality.id), (l) =>
        l?.filter((x) => x.id !== s.id),
      ),
    onError: () => qc.invalidateQueries({ queryKey: sourcesKey(personality.id) }),
  });

  const addFiles = (files: File[]) => {
    if (files.length && !full) upload.mutate(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    addFiles([...e.dataTransfer.files]);
  };
  const submitLink = () => {
    const address = url.trim();
    if (address && !link.isPending) link.mutate(address);
  };
  // The editor is a form: Enter here adds the link, and never saves the personality.
  const onLinkKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setLinking(false);
      setUrl("");
      link.reset();
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Sources</h2>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut for Upload. */}
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={onDrop}
        className={cx(
          "flex min-h-[72px] flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-4 py-4 transition-colors duration-150",
          over ? "border-accent-text bg-accent/5" : "border-line-strong",
        )}
      >
        {linking ? (
          <div className="flex w-full max-w-lg items-center gap-2">
            <Input
              type="url"
              inputMode="url"
              aria-label="Link"
              placeholder="https://"
              value={url}
              autoFocus
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onLinkKey}
            />
            <Button
              variant="primary"
              busy={link.isPending}
              disabled={!url.trim()}
              onClick={submitLink}
            >
              Add
            </Button>
            <Button
              variant="ghost"
              iconOnly
              icon={X}
              aria-label="Cancel"
              onClick={() => {
                setLinking(false);
                setUrl("");
                link.reset();
              }}
            />
          </div>
        ) : (
          <>
            <span className="text-[13px] text-muted max-sm:w-full max-sm:text-center">
              {full ? `${PERSONALITY_MAX_SOURCES} sources, the most it takes` : "Drop files here"}
            </span>
            <Button
              icon={Upload}
              busy={upload.isPending}
              disabled={full}
              onClick={() => pickFiles(DOCUMENT_ACCEPT, addFiles)}
            >
              Upload
            </Button>
            <Button icon={Link2} disabled={full} onClick={() => setLinking(true)}>
              Add link
            </Button>
          </>
        )}
      </div>
      <ErrorText error={upload.error ?? link.error ?? remove.error} />

      {sources.isPending ? (
        <Skeleton className="h-14 w-full rounded-xl" />
      ) : list.length > 0 ? (
        <Card className="divide-y divide-border">
          {list.map((s) => (
            <SourceRow key={s.id} source={s} onRemove={() => remove.mutate(s)} />
          ))}
        </Card>
      ) : null}
    </section>
  );
}

function SourceRow({ source: s, onRemove }: { source: SourceView; onRemove: () => void }) {
  const Icon = kindIcon(s);
  const failed = s.state === "failed";
  const processing = s.state === "processing";
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-lg shadow-raised",
          failed ? "bg-[var(--tag-red-bg)] text-danger" : "bg-surface-2 text-icon",
        )}
      >
        <Icon aria-hidden="true" size={14} />
      </span>
      <div className="min-w-0 flex-1">
        {failed || processing ? (
          <p className="truncate text-[13px] font-medium">{s.name}</p>
        ) : (
          <a
            href={viewUrl(s)}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[13px] font-medium hover:underline"
          >
            {s.name}
          </a>
        )}
        <p
          className={cx(
            "flex items-center gap-1.5 text-xs leading-4",
            failed ? "text-danger" : "text-muted",
          )}
        >
          {processing ? (
            <>
              <Spinner className="size-3" />
              Reading…
            </>
          ) : failed ? (
            <span className="line-clamp-2">{s.error ?? "Couldn't read it."}</span>
          ) : (
            <span className="truncate">
              {kindLabel(s)} · {sourceDetail(s)}
            </span>
          )}
        </p>
      </div>
      {failed ? (
        <Button size="sm" onClick={onRemove}>
          Remove
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={X}
          aria-label={`Remove ${s.name}`}
          title="Remove"
          onClick={onRemove}
        />
      )}
    </div>
  );
}

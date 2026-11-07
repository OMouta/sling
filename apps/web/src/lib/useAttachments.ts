import {
  MESSAGE_MAX_FILES,
  MESSAGE_MAX_IMAGE_BYTES,
  MESSAGE_MAX_IMAGES,
  SOURCE_MAX_BYTES,
  type SourceView,
} from "@sling/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { shrinkImage } from "./shrinkImage.ts";
import { ATTACHMENT_ACCEPT, onSourceEvent, pickFiles, uploadSource } from "./sources.ts";

/** A file in the composer, from picking it until the message goes. */
export interface Attachment {
  key: string;
  name: string;
  image: boolean;
  /** A local URL for an image's thumbnail. */
  preview: string | null;
  state: "uploading" | "processing" | "ready" | "failed";
  error: string | null;
  source: SourceView | null;
}

export interface Attachments {
  items: Attachment[];
  /** Whether there's a file the message can go with. */
  sendable: boolean;
  add(files: File[]): void;
  remove(key: string): void;
  /** Opens the file picker. */
  pick(): void;
  /** The uploaded files' ids, once uploads in flight have finished. */
  ids(): Promise<string[]>;
  /** Empties the composer after a send. The files now belong to the message. */
  clear(): void;
}

const MB = 1024 * 1024;
let counter = 0;

const isImage = (f: File) => /^image\/(jpeg|png|webp|gif)$/.test(f.type);

/**
 * The composer's files. Each uploads as soon as it's added, images shrunk
 * first, and follows the server's processing until it's ready or failed.
 */
export function useAttachments(): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const current = useRef(items);
  current.current = items;
  const uploads = useRef(new Map<string, Promise<unknown>>());
  /** Each chip's uploaded file as last heard, kept apart from renders so a send reads it at once. */
  const uploaded = useRef(new Map<string, SourceView>());

  const patch = useCallback((key: string, p: Partial<Attachment>) => {
    setItems((list) => list.map((a) => (a.key === key ? { ...a, ...p } : a)));
  }, []);

  // Processing finishes on the server.
  useEffect(
    () =>
      onSourceEvent((ev) => {
        for (const [key, s] of uploaded.current) {
          if (ev.type === "source.removed" && s.id === ev.id) uploaded.current.delete(key);
          if (ev.type === "source.updated" && s.id === ev.source.id) {
            uploaded.current.set(key, ev.source);
          }
        }
        setItems((list) => {
          if (ev.type === "source.removed") return list.filter((a) => a.source?.id !== ev.id);
          return list.map((a) =>
            a.source?.id === ev.source.id
              ? { ...a, source: ev.source, state: ev.source.state, error: ev.source.error }
              : a,
          );
        });
      }),
    [],
  );

  // Thumbnails are let go when their chip goes.
  useEffect(
    () => () => {
      for (const a of current.current) if (a.preview) URL.revokeObjectURL(a.preview);
    },
    [],
  );

  const add = useCallback(
    (files: File[]) => {
      const list = current.current;
      let count = list.length;
      let images = list.filter((a) => a.image && a.state !== "failed").length;
      const added: Attachment[] = [];
      for (const file of files) {
        const image = isImage(file);
        const key = `att-${++counter}`;
        let error: string | null = null;
        if (count >= MESSAGE_MAX_FILES)
          error = `A message takes at most ${MESSAGE_MAX_FILES} files.`;
        else if (image && images >= MESSAGE_MAX_IMAGES) {
          error = `A message takes at most ${MESSAGE_MAX_IMAGES} images.`;
        } else if (!image && file.size > SOURCE_MAX_BYTES) {
          error = `Files are at most ${SOURCE_MAX_BYTES / MB} MB.`;
        }
        count++;
        if (image && !error) images++;
        const a: Attachment = {
          key,
          name: file.name || (image ? "image" : "file"),
          image,
          preview: image ? URL.createObjectURL(file) : null,
          state: error ? "failed" : "uploading",
          error,
          source: null,
        };
        added.push(a);
        if (error) continue;
        const job = (async () => {
          try {
            const body = image ? await shrinkImage(file) : file;
            if (image && body.size > MESSAGE_MAX_IMAGE_BYTES) {
              throw new Error(`An image is at most ${MESSAGE_MAX_IMAGE_BYTES / MB} MB.`);
            }
            const source = await uploadSource("/api/attachments", body, body.name || a.name);
            uploaded.current.set(key, source);
            patch(key, { source, state: source.state, error: source.error });
          } catch (err) {
            patch(key, {
              state: "failed",
              error: err instanceof Error ? err.message : "Couldn't upload it.",
            });
          } finally {
            uploads.current.delete(key);
          }
        })();
        uploads.current.set(key, job);
      }
      setItems((l) => [...l, ...added]);
    },
    [patch],
  );

  const remove = useCallback((key: string) => {
    const a = current.current.find((x) => x.key === key);
    if (!a) return;
    if (a.preview) URL.revokeObjectURL(a.preview);
    uploaded.current.delete(key);
    setItems((l) => l.filter((x) => x.key !== key));
    // An upload no message will take is deleted right away.
    if (a.source) void api.del(`/api/sources/${a.source.id}`).catch(() => {});
  }, []);

  const ids = useCallback(async () => {
    await Promise.allSettled([...uploads.current.values()]);
    // In the order the chips show.
    const order = current.current.map((a) => a.key);
    return [...uploaded.current.entries()]
      .filter(([, s]) => s.state !== "failed")
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([, s]) => s.id);
  }, []);

  const clear = useCallback(() => {
    for (const a of current.current) if (a.preview) URL.revokeObjectURL(a.preview);
    uploaded.current.clear();
    setItems([]);
  }, []);

  const pick = useCallback(() => pickFiles(ATTACHMENT_ACCEPT, add), [add]);

  return {
    items,
    sendable: items.some((a) => a.state !== "failed"),
    add,
    remove,
    pick,
    ids,
    clear,
  };
}

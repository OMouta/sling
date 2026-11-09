import type { ConversationSummaryView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Ellipsis, Pencil, Workflow } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";
import {
  conversationsKey,
  dropListedConversation,
  patchListedConversation,
} from "../lib/conversations.ts";
import { usePersonalities } from "../lib/personalities.ts";
import type { ConversationDetail } from "../lib/types.ts";
import { Button, cx, Dialog, ErrorText, Input, Menu, MenuItem, useConfirm } from "./ui.tsx";

/** What Make this a workflow sends, as your message. */
export const MAKE_WORKFLOW = "Turn what we did in this chat into a workflow";

/**
 * Rename and archive for conversations, and making one a workflow. Returns
 * the "…" menu for a row, and the dialogs it opens, which the caller
 * renders once. A failed action says why and offers to try again.
 */
export function useConversationMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [renaming, setRenaming] = useState<ConversationSummaryView | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const personalities = usePersonalities();
  // Only a web chat with something in it, whose personality can change Sling's setup.
  const canWrite = (c: ConversationSummaryView) => {
    const list = personalities.data ?? [];
    const p = c.personalityId
      ? list.find((x) => x.id === c.personalityId)
      : list.find((x) => x.isDefault);
    return (
      c.source === "app" &&
      !c.archived &&
      c.lastMessageAt !== null &&
      Boolean(p?.tools.includes("setup"))
    );
  };

  const failed = async (title: string, error: Error, retry: () => void) => {
    const again = await confirm({ title, body: error.message, action: "Try again" });
    if (again) retry();
  };

  const makeWorkflow = useMutation({
    mutationFn: (c: ConversationSummaryView) =>
      api.post(`/api/conversations/${c.id}/messages`, { text: MAKE_WORKFLOW }),
    onSuccess: (_, c) => {
      if (pathname !== `/c/${c.id}`) void navigate({ to: "/c/$id", params: { id: c.id } });
    },
    onError: (error, c) =>
      failed(`Couldn't start a workflow from "${c.title}"`, error, () => makeWorkflow.mutate(c)),
  });

  // The row stays until the server has it, and moves to the other list after.
  const archive = useMutation({
    mutationFn: ({ c, archived }: { c: ConversationSummaryView; archived: boolean }) =>
      api.post(`/api/conversations/${c.id}/${archived ? "archive" : "restore"}`),
    onSuccess: (_, { c, archived }) => {
      dropListedConversation(qc, c.id);
      void qc.invalidateQueries({ queryKey: conversationsKey });
      qc.setQueryData<ConversationDetail>(["conversation", c.id], (d) =>
        d ? { ...d, conversation: { ...d.conversation, archived } } : d,
      );
    },
    onError: (error, v) =>
      failed(`Couldn't ${v.archived ? "archive" : "restore"} "${v.c.title}"`, error, () =>
        archive.mutate(v),
      ),
  });
  const busy = (c: ConversationSummaryView) =>
    (archive.isPending && archive.variables?.c.id === c.id) ||
    (makeWorkflow.isPending && makeWorkflow.variables?.id === c.id);

  const menu = (c: ConversationSummaryView, className?: string) => (
    <Menu
      label={`Actions for ${c.title}`}
      className={className}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Actions for ${c.title}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }}
          className={cx(
            "grid size-6 cursor-pointer place-items-center rounded-md text-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-icon",
            open && "bg-surface-3 text-icon",
          )}
        >
          <Ellipsis aria-hidden="true" size={14} />
        </button>
      )}
    >
      {canWrite(c) && (
        <MenuItem icon={Workflow} disabled={busy(c)} onSelect={() => makeWorkflow.mutate(c)}>
          Make this a workflow
        </MenuItem>
      )}
      <MenuItem icon={Pencil} onSelect={() => setRenaming(c)}>
        Rename
      </MenuItem>
      {c.archived ? (
        <MenuItem
          icon={ArchiveRestore}
          disabled={busy(c)}
          onSelect={() => archive.mutate({ c, archived: false })}
        >
          Restore
        </MenuItem>
      ) : (
        <MenuItem
          icon={Archive}
          disabled={busy(c)}
          onSelect={() => archive.mutate({ c, archived: true })}
        >
          Archive
        </MenuItem>
      )}
    </Menu>
  );

  const dialog = (
    <>
      {confirmDialog}
      {renaming && <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} />}
    </>
  );
  return { menu, dialog };
}

function RenameDialog({
  conversation,
  onClose,
}: {
  conversation: ConversationSummaryView;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(conversation.title);
  const save = useMutation({
    mutationFn: (t: string) => api.patch(`/api/conversations/${conversation.id}`, { title: t }),
    onSuccess: (_, t) => {
      patchListedConversation(qc, conversation.id, (x) => ({ ...x, title: t }));
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (t) save.mutate(t);
  };
  return (
    <Dialog
      title="Rename chat"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-chat"
            busy={save.isPending}
            disabled={!title.trim()}
          >
            Save
          </Button>
        </>
      }
    >
      <form id="rename-chat" onSubmit={submit} className="space-y-2">
        <Input
          aria-label="Name"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <ErrorText error={save.error} />
      </form>
    </Dialog>
  );
}

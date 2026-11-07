import type { ConversationSummaryView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";
import { conversationsKey } from "../lib/conversations.ts";
import { Button, cx, Dialog, ErrorText, Input, Menu, MenuItem, useConfirm } from "./ui.tsx";

/**
 * Rename and delete for conversations. Returns the "…" menu for a row, and
 * the dialogs it opens, which the caller renders once.
 */
export function useConversationMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [renaming, setRenaming] = useState<ConversationSummaryView | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const remove = useMutation({
    mutationFn: (c: ConversationSummaryView) => api.del(`/api/conversations/${c.id}`),
    onSuccess: (_, c) => {
      qc.setQueriesData<ConversationSummaryView[]>({ queryKey: conversationsKey }, (list) =>
        list?.filter((x) => x.id !== c.id),
      );
      if (pathname === `/c/${c.id}`) void navigate({ to: "/" });
    },
  });

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
      <MenuItem icon={Pencil} onSelect={() => setRenaming(c)}>
        Rename
      </MenuItem>
      <MenuItem
        icon={Trash2}
        danger
        onSelect={async () => {
          const ok = await confirm({
            title: `Delete "${c.title}"?`,
            body: "Tasks it started keep running.",
            action: "Delete",
            danger: true,
          });
          if (ok) remove.mutate(c);
        }}
      >
        Delete
      </MenuItem>
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
      qc.setQueriesData<ConversationSummaryView[]>({ queryKey: conversationsKey }, (list) =>
        list?.map((x) => (x.id === conversation.id ? { ...x, title: t } : x)),
      );
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

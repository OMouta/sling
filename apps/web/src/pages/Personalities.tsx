import {
  GLYPH_SHAPES,
  type GlyphShape,
  PERSONALITY_COLORS,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_NAME_MAX,
  PERSONALITY_TOOL_INFO,
  PERSONALITY_TOOLS,
  type PersonalityColor,
  type PersonalityTemplateView,
  type PersonalityTool,
  type PersonalityView,
} from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Drama,
  Ellipsis,
  LayoutGrid,
  LayoutTemplate,
  Plus,
  Rocket,
  Star,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Glyph } from "../components/Glyph.tsx";
import { Page, Toolbar } from "../components/Page.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Switch,
  Textarea,
  useConfirm,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { GLYPH_LABELS } from "../lib/glyphs.ts";
import {
  COLOR_LABELS,
  colorVar,
  personalitiesKey,
  usePersonalities,
  usePersonalityTemplates,
} from "../lib/personalities.ts";
import { personalityRoute } from "../router.tsx";

type Draft = Pick<
  PersonalityView,
  "name" | "description" | "instructions" | "tools" | "color" | "shape"
>;

const TOOL_ICONS: Record<PersonalityTool, typeof Terminal> = {
  commands: Terminal,
  coding: Wrench,
  apps: LayoutGrid,
  deploys: Rocket,
};

const TOOL_SHORT: Record<PersonalityTool, string> = {
  commands: "Commands",
  coding: "Coding tasks",
  apps: "Apps",
  deploys: "Deploys",
};

function toolsLine(tools: PersonalityTool[]): string {
  if (tools.length === 0) return "No tools";
  return tools.map((t) => TOOL_SHORT[t]).join(" · ");
}

/* ---------------------------------------------------------------- List */

export function PersonalitiesPage() {
  const personalities = usePersonalities();
  const navigate = useNavigate();
  const list = personalities.data ?? [];
  const [gallery, setGallery] = useState(false);
  return (
    <Page
      title="Personalities"
      toolbar={
        <Toolbar
          actions={
            <>
              <Button icon={LayoutTemplate} onClick={() => setGallery(true)}>
                From template
              </Button>
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => void navigate({ to: "/personalities/$id", params: { id: "new" } })}
              >
                New personality
              </Button>
            </>
          }
        >
          <p className="min-w-0 text-xs leading-4 text-muted max-lg:hidden">
            Who answers in a chat: its instructions, what it may use, and how it looks. A chat keeps
            the personality it started with.
          </p>
        </Toolbar>
      }
    >
      {personalities.isPending && (
        <div className="grid gap-3 px-5 pt-1 pb-6 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </div>
      )}
      <div className="px-5">
        <ErrorText error={personalities.error} />
      </div>
      {personalities.isSuccess && list.length === 0 && (
        <Empty fill icon={Drama} title="No personalities">
          Make one to start chatting.
        </Empty>
      )}
      {list.length > 0 && (
        <div className="grid gap-3 px-5 pt-1 pb-6 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p, i) => (
            <PersonalityCard key={p.id} personality={p} list={list} index={i} />
          ))}
        </div>
      )}
      {gallery && <TemplateGallery list={list} onClose={() => setGallery(false)} />}
    </Page>
  );
}

/** Ready-made personalities, grouped, to add with one click. */
function TemplateGallery({ list, onClose }: { list: PersonalityView[]; onClose: () => void }) {
  const qc = useQueryClient();
  const templates = usePersonalityTemplates();
  const added = new Set(list.map((p) => p.templateKey).filter(Boolean));
  const add = useMutation({
    mutationFn: (key: string) => api.post<PersonalityView>(`/api/personalities/templates/${key}`),
    onSuccess: (p) =>
      qc.setQueryData<PersonalityView[]>(personalitiesKey, (l) =>
        l && !l.some((x) => x.id === p.id) ? [...l, p] : l,
      ),
  });
  const groups = new Map<string, PersonalityTemplateView[]>();
  for (const t of templates.data ?? []) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);

  return (
    <Dialog
      wide
      title="Add from templates"
      description="Each one starts with its own instructions, tools, and look. Change any of it after."
      onClose={onClose}
      footer={
        <Button onClick={onClose} data-autofocus>
          Done
        </Button>
      }
    >
      {templates.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
      <ErrorText error={templates.error ?? add.error} />
      <div className="space-y-5">
        {[...groups].map(([group, items]) => (
          <section key={group} className="space-y-2">
            <h3 className="section-label px-0.5">{group}</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {items.map((t) => (
                <TemplateItem
                  key={t.key}
                  template={t}
                  added={added.has(t.key)}
                  busy={add.isPending && add.variables === t.key}
                  onAdd={() => add.mutate(t.key)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function TemplateItem({
  template: t,
  added,
  busy,
  onAdd,
}: {
  template: PersonalityTemplateView;
  added: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <li
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 shadow-raised"
    >
      <span className="grid size-8 shrink-0 place-items-center">
        <Glyph
          shape={t.shape}
          color={t.color}
          size={26}
          seed={t.key}
          lively={hover}
          still={!hover}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{t.name}</span>
        <span className="mt-0.5 block text-xs leading-4 text-muted">{t.description}</span>
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-subtle">
          {t.tools.map((tool) => {
            const Icon = TOOL_ICONS[tool];
            return <Icon key={tool} aria-hidden="true" size={12} className="shrink-0" />;
          })}
          {toolsLine(t.tools)}
        </span>
      </span>
      {added ? (
        <span className="flex h-[26px] shrink-0 items-center gap-1 px-1.5 text-xs text-muted">
          <Check aria-hidden="true" size={13} className="text-ok" />
          Added
        </span>
      ) : (
        <Button size="sm" icon={Plus} busy={busy} onClick={onAdd} aria-label={`Add ${t.name}`}>
          Add
        </Button>
      )}
    </li>
  );
}

function PersonalityCard({
  personality: p,
  list,
  index,
}: {
  personality: PersonalityView;
  list: PersonalityView[];
  index: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [hover, setHover] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: personalitiesKey });

  const makeDefault = useMutation({
    mutationFn: () => api.post(`/api/personalities/${p.id}/default`),
    onSettled: refresh,
  });
  const move = useMutation({
    mutationFn: (by: -1 | 1) => {
      const ids = list.map((x) => x.id);
      const [moved] = ids.splice(index, 1);
      if (moved) ids.splice(index + by, 0, moved);
      return api.put<PersonalityView[]>("/api/personalities/order", { ids });
    },
    onSuccess: (next) => qc.setQueryData(personalitiesKey, next),
  });
  const duplicate = useMutation({
    mutationFn: () =>
      api.post<PersonalityView>("/api/personalities", {
        name: `${p.name} copy`.slice(0, PERSONALITY_NAME_MAX),
        description: p.description,
        instructions: p.instructions,
        tools: p.tools,
        color: p.color,
        shape: p.shape,
      }),
    onSuccess: (copy) => {
      void refresh();
      void navigate({ to: "/personalities/$id", params: { id: copy.id } });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/personalities/${p.id}`),
    onSettled: refresh,
  });
  const error = makeDefault.error ?? move.error ?? duplicate.error ?? remove.error;

  return (
    <Card className="group relative transition-shadow duration-150 hover:shadow-card-hover">
      <Link
        to="/personalities/$id"
        params={{ id: p.id }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className="flex h-full gap-3.5 rounded-xl p-4 pr-12"
      >
        <span className="relative grid size-11 shrink-0 place-items-center">
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full opacity-0 blur-lg transition-opacity duration-200 group-hover:opacity-30"
            style={{ background: colorVar(p.color) }}
          />
          <Glyph
            shape={p.shape}
            color={p.color}
            size={36}
            seed={p.id}
            lively={hover}
            className="relative"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{p.name}</span>
            {p.isDefault && <Badge>Default</Badge>}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted">
            {p.description || "No description"}
          </span>
          <span className="mt-2.5 flex items-center gap-1.5 text-xs text-subtle">
            {p.tools.map((t) => {
              const Icon = TOOL_ICONS[t];
              return <Icon key={t} aria-hidden="true" size={12} className="shrink-0" />;
            })}
            <span className="truncate">{toolsLine(p.tools)}</span>
          </span>
          <ErrorText error={error} />
        </span>
      </Link>
      <div className="absolute top-3 right-3">
        <Menu
          label={`${p.name} actions`}
          trigger={({ open, toggle }) => (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={Ellipsis}
              aria-label={`${p.name} actions`}
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        >
          {!p.isDefault && (
            <MenuItem icon={Star} onSelect={() => makeDefault.mutate()}>
              Make default
            </MenuItem>
          )}
          <MenuItem icon={Copy} onSelect={() => duplicate.mutate()}>
            Duplicate
          </MenuItem>
          {index > 0 && (
            <MenuItem icon={ArrowUp} onSelect={() => move.mutate(-1)}>
              Move up
            </MenuItem>
          )}
          {index < list.length - 1 && (
            <MenuItem icon={ArrowDown} onSelect={() => move.mutate(1)}>
              Move down
            </MenuItem>
          )}
          {!p.isDefault && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                danger
                onSelect={async () => {
                  const ok = await confirm({
                    title: `Delete ${p.name}?`,
                    body: "New chats can't pick it anymore. Chats that already use it keep it.",
                    action: "Delete",
                    danger: true,
                  });
                  if (ok) remove.mutate();
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {dialog}
    </Card>
  );
}

/* -------------------------------------------------------------- Editor */

function blankDraft(list: PersonalityView[]): Draft {
  const usedColors = new Set(list.map((p) => p.color));
  const usedShapes = new Set(list.map((p) => p.shape));
  return {
    name: "",
    description: "",
    instructions: "",
    tools: [],
    color: PERSONALITY_COLORS.find((c) => !usedColors.has(c)) ?? "violet",
    shape: GLYPH_SHAPES.find((s) => !usedShapes.has(s)) ?? "bloom",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.instructions === b.instructions &&
    a.tools.join() === b.tools.join() &&
    a.color === b.color &&
    a.shape === b.shape
  );
}

const pickDraft = (p: PersonalityView): Draft => ({
  name: p.name,
  description: p.description,
  instructions: p.instructions,
  tools: p.tools,
  color: p.color,
  shape: p.shape,
});

export function PersonalityEditorPage() {
  const { id } = personalityRoute.useParams();
  const isNew = id === "new";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const personalities = usePersonalities();
  const list = personalities.data ?? [];
  const existing = isNew ? undefined : list.find((p) => p.id === id);
  // A new draft reads the list once; an existing one follows the stored personality.
  const savedKey = existing
    ? `${existing.id}:${existing.updatedAt}`
    : isNew && personalities.isSuccess
      ? "new"
      : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey stands for existing and list.
  const saved = useMemo(
    () => (existing ? pickDraft(existing) : savedKey === "new" ? blankDraft(list) : null),
    [savedKey],
  );
  // The draft and what it started from. An untouched draft follows changes made elsewhere.
  const [state, setState] = useState<{ id: string; base: Draft; draft: Draft } | null>(null);
  if (saved && (state?.id !== id || (state.base !== saved && sameDraft(state.draft, state.base)))) {
    setState({ id, base: saved, draft: saved });
  }
  const draft = state?.id === id ? state.draft : null;
  const setDraft = (d: Draft) => setState((s) => (s ? { ...s, draft: d } : s));

  const save = useMutation({
    mutationFn: (d: Draft) =>
      isNew
        ? api.post<PersonalityView>("/api/personalities", d)
        : api.patch<PersonalityView>(`/api/personalities/${id}`, d),
    onSuccess: (p) => {
      qc.setQueryData<PersonalityView[]>(personalitiesKey, (l) =>
        l ? (l.some((x) => x.id === p.id) ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p]) : l,
      );
      if (isNew) void navigate({ to: "/personalities" });
      else setState({ id: p.id, base: pickDraft(p), draft: pickDraft(p) });
    },
  });

  if (personalities.isSuccess && !isNew && !existing) {
    return (
      <Page title="Personality" crumb={{ label: "Personalities", to: "/personalities" }}>
        <Empty fill icon={Drama} title="This personality doesn't exist anymore">
          <Link to="/personalities" className="text-accent-text hover:underline">
            Back to personalities
          </Link>
        </Empty>
      </Page>
    );
  }
  if (!draft) {
    return (
      <Page
        title={<Skeleton className="h-4 w-40" />}
        crumb={{ label: "Personalities", to: "/personalities" }}
      >
        <div className="space-y-4 px-5 py-6">
          <Skeleton className="h-8 w-full max-w-xl" />
          <Skeleton className="h-40 w-full max-w-xl" />
        </div>
      </Page>
    );
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const dirty = isNew || !state || !sameDraft(draft, state.base);
  const valid = draft.name.trim() !== "" && draft.instructions.trim() !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && dirty && !save.isPending) save.mutate(draft);
  };

  return (
    <Page
      title={isNew ? "New personality" : existing?.name || "Personality"}
      crumb={{ label: "Personalities", to: "/personalities" }}
      badge={existing?.isDefault ? <Badge>Default</Badge> : undefined}
      controls={
        <div className="flex items-center gap-2">
          <ErrorText error={save.error} />
          {!isNew && dirty && (
            <Button onClick={() => state && setDraft(state.base)} disabled={save.isPending}>
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            form="personality-form"
            busy={save.isPending}
            disabled={!valid || !dirty}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      }
    >
      <form
        id="personality-form"
        onSubmit={submit}
        className="mx-auto grid w-full max-w-5xl gap-8 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="min-w-0 space-y-8">
          <section className="space-y-4">
            <Field label="Name">
              <Input
                value={draft.name}
                maxLength={PERSONALITY_NAME_MAX}
                placeholder="Travel"
                onChange={(e) => set("name", e.target.value)}
                autoFocus={isNew}
              />
            </Field>
            <Field label="Description" hint="One line, shown under the name when you pick it.">
              <Input
                value={draft.description}
                maxLength={PERSONALITY_DESCRIPTION_MAX}
                placeholder="Trips, bookings, and what to pack."
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <SectionHead title="Look" />
            <ColorPicker value={draft.color} onChange={(c) => set("color", c)} />
            <ShapePicker
              value={draft.shape}
              color={draft.color}
              onChange={(s) => set("shape", s)}
            />
          </section>

          <section className="space-y-3">
            <SectionHead
              title="What it can use"
              description="Sling's tools, on your machines and in your apps. The permission mode still limits what they do."
            />
            <Card className="divide-y divide-border">
              {PERSONALITY_TOOLS.map((t) => {
                const Icon = TOOL_ICONS[t];
                const on = draft.tools.includes(t);
                return (
                  <div key={t} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
                      <Icon aria-hidden="true" size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{PERSONALITY_TOOL_INFO[t].label}</p>
                      <p className="text-xs leading-4 text-muted">
                        {PERSONALITY_TOOL_INFO[t].description}
                      </p>
                    </div>
                    <Switch
                      checked={on}
                      label={PERSONALITY_TOOL_INFO[t].label}
                      onChange={(v) =>
                        set(
                          "tools",
                          PERSONALITY_TOOLS.filter((g) => (g === t ? v : draft.tools.includes(g))),
                        )
                      }
                    />
                  </div>
                );
              })}
            </Card>
          </section>

          <section className="space-y-3">
            <SectionHead
              title="Instructions"
              description="Who it is and how it answers. Sling adds the rules for its tools, the permission mode, and today's date."
            />
            <Textarea
              aria-label="Instructions"
              value={draft.instructions}
              maxLength={PERSONALITY_INSTRUCTIONS_MAX}
              rows={14}
              placeholder={
                "You are Travel, the user's trip planner.\n\nAsk for dates and budget before suggesting anything."
              }
              onChange={(e) => set("instructions", e.target.value)}
              className="min-h-64 resize-y font-mono text-[12.5px] leading-5"
            />
            <p className="tabular text-right text-xs text-subtle">
              {draft.instructions.length.toLocaleString()} /{" "}
              {PERSONALITY_INSTRUCTIONS_MAX.toLocaleString()}
            </p>
          </section>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Preview draft={draft} />
        </aside>
      </form>
    </Page>
  );
}

function SectionHead({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="text-sm font-medium">{title}</h2>
      {description && <p className="mt-0.5 text-xs leading-4 text-muted">{description}</p>}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: PersonalityColor;
  onChange: (c: PersonalityColor) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-soft">Color</p>
      <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
        {PERSONALITY_COLORS.map((c) => {
          const on = c === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={COLOR_LABELS[c]}
              title={COLOR_LABELS[c]}
              onClick={() => onChange(c)}
              className="pressable grid size-8 cursor-pointer place-items-center rounded-full"
            >
              <span
                className={cx(
                  "block size-6 rounded-full transition-[box-shadow,transform] duration-150",
                  on && "scale-90",
                )}
                style={{
                  background: colorVar(c),
                  boxShadow: on
                    ? `0 0 0 2px var(--bg), 0 0 0 4px ${colorVar(c)}`
                    : "inset 0 0 0 1px rgb(0 0 0 / 0.15)",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ShapePicker({
  value,
  color,
  onChange,
}: {
  value: GlyphShape;
  color: PersonalityColor;
  onChange: (s: GlyphShape) => void;
}) {
  const [hover, setHover] = useState<GlyphShape | null>(null);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-soft">Shape</p>
      <div role="radiogroup" aria-label="Shape" className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {GLYPH_SHAPES.map((s) => {
          const on = s === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(s)}
              onPointerEnter={() => setHover(s)}
              onPointerLeave={() => setHover((h) => (h === s ? null : h))}
              className={cx(
                "pressable flex cursor-pointer flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11px] transition-[background-color,box-shadow,color] duration-150",
                on
                  ? "bg-surface font-medium text-text shadow-card"
                  : "text-muted hover:bg-hover hover:text-text",
              )}
            >
              <Glyph
                shape={s}
                color={on ? color : "silver"}
                size={28}
                seed={s}
                lively={on || hover === s}
                still={!on && hover !== s}
              />
              {GLYPH_LABELS[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How the personality looks on the new chat screen and while it works. */
function Preview({ draft }: { draft: Draft }) {
  const name = draft.name.trim() || "Untitled";
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-center px-5 pt-8 pb-6 text-center">
        <div className="relative mb-3 grid size-20 place-items-center">
          <span
            aria-hidden="true"
            className="absolute inset-2 rounded-full opacity-30 blur-2xl transition-[background-color] duration-300"
            style={{ background: colorVar(draft.color) }}
          />
          <Glyph
            shape={draft.shape}
            color={draft.color}
            size={56}
            seed="preview"
            lively
            className="relative"
          />
        </div>
        <p className="text-lg font-medium tracking-tight">{name}</p>
        {draft.description.trim() && (
          <p className="mt-1 text-xs leading-4 text-pretty text-muted">{draft.description}</p>
        )}
      </div>
      <div className="space-y-2.5 border-t border-border px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Glyph shape={draft.shape} color={draft.color} size={20} seed="preview-work" active />
          <span className="text-xs text-muted">While it works</span>
        </div>
        <div className="flex items-center gap-2.5 text-xs text-muted">
          {draft.tools.length === 0 ? (
            <span>Talks only. It can't see your machines.</span>
          ) : (
            <span>{toolsLine(draft.tools)}</span>
          )}
        </div>
      </div>
    </Card>
  );
}

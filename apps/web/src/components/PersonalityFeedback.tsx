import type { FeedbackSummaryView, InstructionsSuggestionView, PersonalityView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { personalitiesKey } from "../lib/personalities.ts";
import { Button, Card, Dialog, ErrorText } from "./ui.tsx";

export const feedbackKey = (id: string) => ["personality-feedback", id] as const;

/**
 * How replies went for this personality: the thumbs on its current
 * instructions, its latest downvotes with the chats they're from, and new
 * instructions its model suggests from them.
 */
export function PersonalityFeedback({ personality }: { personality: PersonalityView }) {
  const qc = useQueryClient();
  const id = personality.id;
  const summary = useQuery({
    // The revision is in the key: new instructions start their counts over.
    queryKey: [...feedbackKey(id), personality.revision],
    queryFn: () => api.get<FeedbackSummaryView>(`/api/personalities/${id}/feedback`),
  });
  const [suggestion, setSuggestion] = useState<InstructionsSuggestionView | null>(null);
  const suggest = useMutation({
    mutationFn: () => api.post<InstructionsSuggestionView>(`/api/personalities/${id}/suggest`),
    onSuccess: setSuggestion,
  });
  const apply = useMutation({
    mutationFn: (instructions: string) =>
      api.patch<PersonalityView>(`/api/personalities/${id}`, { instructions }),
    onSuccess: (p) => {
      qc.setQueryData<PersonalityView[]>(personalitiesKey, (l) =>
        l?.map((x) => (x.id === p.id ? p : x)),
      );
      void qc.invalidateQueries({ queryKey: feedbackKey(id) });
      setSuggestion(null);
    },
  });

  const data = summary.data;
  // Nothing to show until a reply has been rated. The section is last, so
  // appearing later moves nothing above it.
  if (!data || (data.up === 0 && data.down === 0 && data.recent.length === 0)) {
    return summary.error ? <ErrorText error={summary.error} /> : null;
  }
  return (
    <section className="space-y-3">
      <div className="flex min-h-[30px] items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Feedback</h2>
        {/* Suggestions come from downvotes on the current instructions. */}
        {data.down > 0 && (
          <Button
            size="sm"
            icon={Sparkles}
            busy={suggest.isPending}
            onClick={() => suggest.mutate()}
          >
            Suggest changes
          </Button>
        )}
      </div>
      <ErrorText error={suggest.error ?? summary.error} />
      <Card className="divide-y divide-border">
        <div className="flex items-center gap-4 px-4 py-3 text-[13px]">
          <span className="tabular flex items-center gap-1.5" title="Good replies">
            <ThumbsUp aria-hidden="true" className="size-3.5 text-subtle" />
            {data.up}
            <span className="sr-only">up</span>
          </span>
          <span className="tabular flex items-center gap-1.5" title="Bad replies">
            <ThumbsDown aria-hidden="true" className="size-3.5 text-subtle" />
            {data.down}
            <span className="sr-only">down</span>
          </span>
          <span className="ml-auto text-xs text-subtle">Revision {data.revision}</span>
        </div>
        {data.recent.map((f) => (
          <Link
            key={f.messageId}
            to="/c/$id"
            params={{ id: f.conversationId }}
            className="block px-4 py-3 hover:bg-hover"
          >
            <div className="flex items-baseline gap-3">
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {f.reason || <span className="font-normal text-subtle">No reason</span>}
              </p>
              <span className="shrink-0 text-xs text-subtle">
                {f.revision !== data.revision && `Revision ${f.revision} · `}
                {ago(f.createdAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs leading-5 text-muted">{f.excerpt}</p>
            <p className="truncate text-xs leading-5 text-subtle">{f.conversationTitle}</p>
          </Link>
        ))}
      </Card>
      {suggestion && (
        <Dialog
          wide
          title="Suggested instructions"
          description={suggestion.summary}
          onClose={() => setSuggestion(null)}
          footer={
            <>
              <ErrorText error={apply.error} />
              <Button onClick={() => setSuggestion(null)} disabled={apply.isPending}>
                Discard
              </Button>
              <Button
                variant="primary"
                busy={apply.isPending}
                onClick={() => apply.mutate(suggestion.instructions)}
              >
                Apply
              </Button>
            </>
          }
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Instructions label="Now" text={personality.instructions} />
            <Instructions label="Suggested" text={suggestion.instructions} />
          </div>
        </Dialog>
      )}
    </section>
  );
}

function Instructions({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-soft">{label}</p>
      <pre className="max-h-[55vh] overflow-y-auto rounded-lg bg-field px-3 py-2.5 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap text-text shadow-field">
        {text}
      </pre>
    </div>
  );
}

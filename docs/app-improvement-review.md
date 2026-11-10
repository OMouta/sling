# Sling improvement review

Review date: 2026-11-09. Source revision: `e2f75f8`.

The original review was read-only. A first implementation pass made the changes that needed no UI work, without changing layout, controls, or copy. A second pass took on the rest, UI included, after the user decided four questions: Delete becomes Archive with Restore; an approval cut off by a restart expires with a visible reason rather than resuming; unsent drafts live in the tab's session storage; and the decision-point explanations in S04 aren't added. Each item's status line says what's done and what wasn't verified. A third pass on 2026-11-10 looked at the running app and is recorded at the end. The review covered the web app, API, database access, workflow execution, realtime delivery, runner event storage, and selected operating documentation. It used repeated passes through the source to check initial findings against the implementation.

This is a broad engineering review, not a claim that every execution path has been audited. No live service, customer data, external integration, or browser session was exercised. Performance effects below are hypotheses unless they follow directly from an unbounded operation or repeated query. There are no measured production latency or bundle-size results.

## What to tackle first

Sling already has useful foundations: workspace checks on the inspected routes, typed workflow definitions, durable background jobs, task state compare-and-set updates, runner event replay, signed extension packages, source-fetch address checks, and substantial automated coverage. Keep these. A rewrite or a move to microservices would add risk before solving the problems identified here.

The highest-value work is to prevent accepted work from getting stranded, preserve user edits, make history retrieval bounded, and make approval screens reliable under load. Product trust also needs attention: an action called Delete currently retains the conversation and its files.

Priority meanings:

- P1: address before relying on this behavior for important unattended work, large histories, or a wider deployment.
- P2: schedule in the next improvement cycle.
- P3: worthwhile follow-up once the relevant usage or measurement justifies it.

Evidence labels:

- Confirmed: the implementation has the stated behavior. This does not mean a production incident was reproduced.
- Risk: source supports a failure scenario that still needs an integration or fault-injection test.
- Proposal: a product or engineering improvement, not an existing defect.

Effort is relative scope, not a delivery estimate. Small means a local change; medium crosses a few components; large changes storage, protocols, or lifecycle semantics.

## Reliability and system design

### R01. Persist message acceptance and workflow delivery together

Status: Done. The message, its attachments, its dispatch record, and a client message ID commit together, so a resend after a lost response returns the saved message instead of a second one. A retry worker separates matched, deduplicated, and unhandled dispatch, and a chat whose reply fails to start three times gets one note saying Sling keeps trying; the model never sees it. End-to-end tests cover a restart before delivery and a trigger that fails four times: one run, one note, no no-workflow message.

P1 · Risk · Large

Evidence: [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts), the message POST handler, first calls `addUserMessage` and then `events.emit`. [`workflows/events.ts`](../apps/server/src/workflows/events.ts), `EventBus.emit`, logs individual trigger-start failures and continues. The caller treats an empty result as no chat workflow and inserts `NO_CHAT_WORKFLOW`.

A crash after saving the message but before starting a run can leave a visible message without a response. A trigger failure can also produce the misleading explanation that no workflow handles chat, even when one is enabled. The existing dedupe key protects run creation when supplied, but does not make the preceding message write and event delivery atomic.

Proposal:

- Write a durable event/outbox record in the same transaction as the user message.
- Have a worker deliver it with bounded retries and existing workflow deduplication.
- Distinguish no matching trigger, already-delivered, temporarily failed, and permanently failed delivery.
- Show a recoverable dispatch failure in chat instead of the no-workflow setup message.

Acceptance: terminate the process between message insertion and dispatch, restart, and verify one message and one intended workflow run. Inject a trigger failure and verify retry plus an accurate user-facing status.

### R02. Make task settlement side effects independently retryable

Status: Done. Each settlement consumer has a durable receipt and its own retries, and system notes use stable IDs. A reconcile in the per-minute sweep queues settlements that a crash cut off between a task's state change and its enqueue. It looks only at tasks that ended in the last day and have been unchanged for two minutes, and only at settle points, so a step still on its way is never announced. Completed deliveries are pruned after 30 days. Unit and end-to-end tests cover it; a real process kill between the two writes hasn't been injected.

P1 · Risk · Medium

Evidence: [`server.ts`](../apps/server/src/server.ts), `ctx.tasks.onSettled`, awaits sandbox handling, then agent handling, then workflow event emission. [`tasks/service.ts`](../apps/server/src/tasks/service.ts), `settle`, catches and logs failure of the combined hook.

A failure in an earlier handler prevents later handlers from running in that invocation. The inspected hook does not persist which side effects completed. A terminal task may therefore need reconciliation even when its state is already correct.

Proposal: enqueue idempotent settlement deliveries per consumer, with durable completion markers. Preserve sandbox cleanup priority, but do not let failure in one consumer suppress unrelated delivery. Start by fault-testing existing sweep recovery before adding any duplicate recovery mechanism.

Acceptance: fail each handler in turn. Sandbox cleanup, chat notification, and workflow continuation must eventually complete without repeating external actions.

### R03. Define and enforce the supported server topology

Status: Done. One active control plane is enforced by a dedicated Postgres advisory-lock connection. Installation documentation explains the topology. Integration coverage checks rejection of a second owner.

P1 before multiple replicas · Confirmed architecture constraint · Large for replication, small for documentation

Evidence: [`realtime/hub.ts`](../apps/server/src/realtime/hub.ts) stores sockets in a process-local map; [`runners/gateway.ts`](../apps/server/src/runners/gateway.ts) stores runner sessions locally; [`agent/agent.ts`](../apps/server/src/agent/agent.ts) stores live replies and status locally; [`agent/commands.ts`](../apps/server/src/agent/commands.ts) stores approvals locally. Jobs use Postgres through [`jobs.ts`](../apps/server/src/jobs.ts).

A shared database and shared job queue do not make these services interchangeable replicas. A worker on one process may not own the runner socket or browser connection needed by its work. Load-balancer stickiness alone does not solve background-job ownership.

Proposal: explicitly support one active control-plane process now. Before horizontal scaling, introduce runner ownership leases, routing of commands to the owning process, cross-process event delivery, and durable approval state. Postgres can remain the coordination store; adding another infrastructure service should follow a demonstrated need.

Acceptance: two-process tests must cover a browser on A, runner on B, job execution on either, and owner termination. Until those pass, installation docs should say that multiple active replicas are unsupported.

### R04. Give temporary chat approvals an explicit restart contract

Status: Done, by expiring with a reason. Each chat approval is stored with how it ended, never with what was typed into its card. On start, Sling ends the ones a restart cut off. A late answer says whether it was already answered, timed out, its reply was stopped, or Sling restarted, and the card shows that in place of its buttons. Notification answers read the same record. An end-to-end test answers once, replays the answer, lets one time out, and restarts the server while one waits. Resuming an approval after a restart was declined.

P1 · Confirmed · Medium to large

Evidence: [`agent/commands.ts`](../apps/server/src/agent/commands.ts) explicitly states that nothing is stored and an approval lives as long as the turn that asked. The default wait is five minutes. The decision route in [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts) returns 409 when it is gone.

Restarting loses a pending command, send, or setup-change approval. This fails closed, which is appropriate, but a user needs to know whether the request expired, the server restarted, or another device already answered it.

Proposal: persist approval metadata and lifecycle outcome, or deliberately expire it on restart with a visible reason. Resuming execution requires a durable continuation and an idempotency strategy; persisting a card alone is insufficient. Continue to keep secret form values out of persisted approval records.

Acceptance: restart while each approval kind is pending. The old card must become clearly expired or safely resumable, and replaying its answer must never execute the action twice.

### R05. Fix browser connection recovery for half-open sockets

Status: Done. Stale-connection deadline, reconnect jitter, refetch on resume, sign-out close codes, and the browser's offline and online events, which drop and restore the socket at once. Dedicated transport tests cover each, and a real-browser journey drops the network and comes back live.

P2 · Confirmed gap · Medium

Evidence: [`lib/realtime.ts`](../apps/web/src/lib/realtime.ts), `connectRealtime`, sends a ping every 25 seconds, ignores pong frames, reconnects on close with deterministic exponential backoff, and invalidates queries after reconnection. [`main.tsx`](../apps/web/src/main.tsx) disables query refetch on window focus.

The code already repairs cached data after a detected reconnect. It has no pong deadline to detect a connection that remains apparently open while delivery has stopped. All clients also share the same retry timing after an outage.

Proposal: track the last received frame, close stale sockets, add bounded retry jitter, and reconcile visible data on resume. Treat authentication closure separately so an expired session leads to sign-in rather than perpetual reconnect attempts.

Acceptance: simulate a network blackhole without a close event, background and resume a phone tab, and expire the session. The UI must recover or explain the required action within a documented timeout.

### R06. Bound browser event fan-out

Status: Done. Bounded socket buffers, isolated send failures, throttled listener diagnostics, and empty-workspace cleanup. Hub regression tests pass.

P2 · Confirmed gap · Medium

Evidence: [`realtime/hub.ts`](../apps/server/src/realtime/hub.ts), `Hub.publish`, calls `socket.send(data)` without a `bufferedAmount` threshold or send callback. Listener exceptions are silently swallowed. Empty workspace sets remain in the map after their last socket closes.

A slow browser can accumulate outgoing data. A failed listener can disappear operationally without any diagnostic. Empty-set retention is minor compared with buffering, but easy to fix.

Proposal: cap outstanding bytes per connection, coalesce replaceable progress messages, disconnect clients beyond the cap and let them fetch authoritative state, log listener failures with rate limiting, and remove empty sets. Keep committed task state as the source of truth.

Acceptance: throttle one client while others stay fast. Memory must remain bounded and healthy clients must continue receiving events. Reconnection must reconstruct the slow client's state.

### R07. Drain shutdown in a defined order

Status: Implemented. A failed startup closes the pool, releases the control-plane lock, stops jobs and timers, and exits non-zero. One deadline (`SLING_SHUTDOWN_TIMEOUT_SECONDS`, default 60 s, inside a configurable 75 s Compose grace period) bounds the whole stop, and repeated signals don't rerun cleanup. Unit and end-to-end tests cover a failed migration, a failed initialization, an aborted startup, and a stuck drain. A stop during a live task, source extraction, or workflow wait hasn't been exercised end to end. Losing the control-plane lock to a Postgres restart shuts Sling down with exit code 0.

P2 · Risk · Medium

Evidence: [`server.ts`](../apps/server/src/server.ts), `close`, waits sequentially for several services, stops jobs late, and closes HTTP after those waits. [`main.ts`](../apps/server/src/main.ts) invokes shutdown independently for each signal. [`docker-compose.yml`](../deploy/docker-compose.yml) has no explicit application stop grace period.

New requests can arrive during part of the shutdown sequence. Sequential waits can take much longer than operators expect, and repeated signals can enter cleanup again.

Proposal: make shutdown idempotent; mark readiness false; stop accepting new work; pause job intake; drain in-flight operations within one overall deadline; close connections last. Configure the container grace period to match. Startup should also clean up resources if migration or initialization fails before the current try block.

Acceptance: stop during a task, source extraction, and workflow wait; send two signals; verify no duplicate cleanup, no newly accepted work after draining starts, and recoverable state after forced termination.

## Performance and data access

### P01. Page conversation messages and task events

Status: Done. A chat opens on its latest 60 messages, cut short at about 512 KB, and older pages load as the reader scrolls up while the view stays on the same message. Each task belongs to one page by when it started, and a note about an older task brings that task along. A task page opens on its latest 500 events, cut at about 1 MB, with Show earlier events. A refresh asks for everything from the oldest loaded item, so new messages never leave a gap. End-to-end tests page a 150-message chat in four pages and 1,200 events in three, with no gaps or repeats; a browser check scrolled a 200-message chat back to its start. The paged UI hasn't been profiled, and virtualization wasn't added.

P1 for long-running use · Confirmed · Large

Evidence: [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts), GET by ID, loads all messages and tasks and recomputes aggregate usage. [`tasks/routes.ts`](../apps/server/src/tasks/routes.ts), GET by ID, loads all task events. [`Timeline.tsx`](../apps/web/src/components/Timeline.tsx) scans and renders the supplied event collection; [`Chat.tsx`](../apps/web/src/pages/Chat.tsx) builds its timeline from the full message array.

Response size, decoding, memory use, and rendering work grow with history. Collapsing command output visually does not avoid downloading that output.

Proposal: fetch a recent window plus stable cursors, with separate older-history and event-tail endpoints. Use `(taskId, seq)` for events and an ordering consistent with message IDs for chat. Return summaries separately from large output payloads. Preserve scroll anchors when older items arrive; add virtualization only after profiling the paged UI.

Acceptance: use a synthetic conversation with 10,000 messages and a task with 100,000 events. The first response must have a configured item and byte bound. Older pages must have no gaps or duplicates, and streaming must not force full-history downloads.

### P02. Replace silent list caps with pagination and server-side filters

Status: Done. Chats, tasks, and approvals come a page at a time with stable cursors, the filters apply before the limit, and the first page carries counts and totals for everything that matches. Pending approvals list soonest to expire first, with Newest first as the other order, and a task card asks only for its own task's approvals. End-to-end tests reach every item past the old limits, including an old chat with a task and approvals that expire in a different order than they were made.

P1 for approvals · Confirmed · Medium

Evidence: [`tasks/routes.ts`](../apps/server/src/tasks/routes.ts) limits tasks and approvals to 100; [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts) limits chats to 200. These responses have no next cursor. [`lib/conversations.ts`](../apps/web/src/lib/conversations.ts) applies working/waiting/task filters to the fetched list.

Older records can be unreachable through the list. A waiting filter can omit an older pending conversation, and more than 100 pending approvals cannot all appear at once.

Proposal: return `{items, nextCursor, hasMore}` and apply filters before the limit. Use stable tie-breakers. Give approvals explicit oldest-first or expiry-first sorting, while retaining a choice for recent activity. Provide separate counts instead of inferring totals from a page.

Acceptance: create more records than each old limit, including an old pending approval. Every item must be reachable and counts must agree with the full filtered dataset.

### P03. Batch approval view construction

Status: Done. Approval rows, task views, and rule streaks are fetched in batches. The rules integration suite exercises approval construction.

P2 · Confirmed · Medium

Evidence: [`tasks/routes.ts`](../apps/server/src/tasks/routes.ts), approvals GET, first fetches IDs and then calls `Promise.all(rows.map(approvalView))`. [`views.ts`](../apps/server/src/views.ts), `approvalView`, performs its own join and may call `taskViews` and rule-offer logic. The main database pool defaults to ten connections in [`packages/db/src/index.ts`](../packages/db/src/index.ts).

This is an N+1 query pattern. Launching every promise at once creates pool contention rather than eliminating database work. `taskViews` already supports batches and offers a useful starting point.

Proposal: fetch approval rows and associated records in batches; call `taskViews` once for distinct tasks; batch applicable rule data; serialize from maps. Do not increase the pool as the first fix.

Acceptance: record query counts for 1, 20, and 100 approvals. Related-record queries should remain approximately constant rather than proportional to approval count. Compare latency while other API requests are active.

### P04. Measure and improve conversation activity and search queries

Status: Done. Chats keep a `last_message_at` column, written in the transaction that writes or removes messages and backfilled, with a workspace/activity/ID index, and search uses pg_trgm indexes on titles and message text when the database allows the extension. On 20,000 chats and 1M messages (376 MB): the old list query took 3.8–4.9 s and the first page now takes 1.0 ms (10 ms at row 15,000). The tab counts went from 90 ms to 9 ms. Searching a rare term went from 386 ms to 17 ms, and `#19999.4` from 469 ms to 24 ms. A common phrase that matches one message in seven still takes 230–325 ms (from 445–495 ms). Search stays a case-insensitive substring match, so non-English words and punctuation match as typed. Renaming doesn't move a chat; an end-to-end test checks it.

P2 · Confirmed query shape, unmeasured cost · Medium

Evidence: [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts) orders by a correlated `max(created_at)` over messages and searches message JSON text with a leading-wildcard `ILIKE`. [`schema/sling.ts`](../packages/db/src/schema/sling.ts) indexes messages by conversation and ID, and conversations by workspace and updated time.

Those indexes help some lookups, but do not directly provide an indexed activity sort or substring text search. The current conversation timestamp also intentionally differs from latest message activity.

Proposal: inspect `EXPLAIN (ANALYZE, BUFFERS)` on representative fixtures. Consider a transactionally maintained `lastMessageAt` and a matching workspace/activity/ID index. Choose full-text search or trigram substring search based on intended search behavior. Backfill and verify consistency before switching reads.

Acceptance: benchmark empty, common, and rare queries across growing history sizes. Verify rename does not reorder activity and that non-English terms and punctuation behave as documented.

### P05. Make retention deletion incremental

Status: Implemented and measured. 300,000 expired events were pruned in 1.0 s, and 3,000,000 in 30.2 s over four bounded runs, with task-detail p95 at 24 ms during the prune (16.5 ms idle). An interrupted prune rolled back only the batch in flight and resumed cleanly. A multi-million backlog takes several daily runs, and node-run payload pruning is still one statement.

P2 · Confirmed · Medium

Evidence: [`tasks/service.ts`](../apps/server/src/tasks/service.ts), `pruneEvents`, deletes every expired event in one statement and returns one task ID per deleted row solely to count them. [`jobs.ts`](../apps/server/src/jobs.ts) schedules pruning daily.

Large retention batches can create avoidable response allocation and long transactions. The timestamp index already exists; the proposal is about batch size and operation, not adding a duplicate index.

Proposal: delete in bounded batches with a time budget, count without returning every identifier, and publish deletion duration and backlog. Review whether active tasks should retain their early events until terminal state. Introduce partitioning only if measured table size warrants it.

Acceptance: prune a large synthetic backlog while recording API latency and database load. An interrupted prune must safely resume.

### P06. Stream and bound runner replay memory

Status: Implemented; Linux and Windows disk timings unmeasured. Acknowledged prefixes are compacted once they're at least 1 MiB and half the file, and a finished task keeps one record; crash tests cover every step. Each spool holds at most 32 MiB unacknowledged and then skips droppable events with notes in the task log, never terminal, usage, or push and PR events. Records are capped at 1 MiB to fit the server's 4 MiB frame. Before this, records over 4 MiB were lost, finishes included.

P2 · Confirmed operation, impact depends on event volume · Medium to large

Evidence: [`apps/runner/src/spool.rs`](../apps/runner/src/spool.rs), `read_events`, reads the whole event file into a byte vector, decodes all records, then `open` filters acknowledged events. `unsent` clones all unsent records. [`tasks.rs`](../apps/runner/src/tasks.rs) collects unsent records across spools into another vector.

The durable spool is worth keeping. Its recovery and replay paths can multiply memory use with long histories or an extended disconnection.

Proposal: decode incrementally, skip acknowledged records without retaining them, transmit bounded batches, and compact acknowledged prefixes safely. Define a disk budget and an explicit policy for excess output that preserves terminal and approval events. First measure the existing producer-side output limits.

Acceptance: replay a spool substantially larger than the intended memory budget. Memory should remain bounded, partial-tail recovery must still work, and every retained sequence must be acknowledged exactly as before.

### P07. State the spool's power-loss durability guarantee

Status: Implemented; real power-loss testing remains open. A simulated disk stops at every write and cuts power six ways, under Unix and NTFS rename models. Recovery rejects zeroed and stale tails and never reuses a sequence number when metadata outlives event data; both were real bugs. Acknowledgements are no longer synced (8.2 ms to 0.15 ms), since losing one only causes resends. docs/runner.md states the guarantee per platform.

P2 · Risk · Medium

Evidence: [`spool.rs`](../apps/runner/src/spool.rs), `append`, uses `write_all` and `flush`; metadata uses write-then-rename. These paths do not call `sync_data` or `sync_all`.

Process-restart recovery and survival of sudden power loss are different guarantees. The file format handles a partial last record, but the reviewed writes do not explicitly request stable storage before considering an append complete.

Proposal: document the current guarantee, then choose an fsync policy based on acceptable loss and throughput. Batched synchronization may be appropriate. Include metadata and directory durability in that design, with platform-specific tests.

Acceptance: test truncated and reordered durable state through a fault-injection filesystem or equivalent harness. Verify acknowledged records cannot be discarded based on metadata that survives without the corresponding event data.

### P08. Expand route-level lazy loading where measurements justify it

Status: Measured and budgeted. The first load fell from 315,012 to 283,358 bytes gzip (265,914 to 245,251 brotli), and CI fails above 292,000 / 253,000 bytes. Sling serves the files uncompressed unless a proxy compresses them. Cold navigation and parse time haven't been measured.

P2 · Proposal grounded in imports · Small to medium

Evidence: [`router.tsx`](../apps/web/src/router.tsx) already lazy-loads checks, memory, and workflow detail pages. It eagerly imports settings, machines, personalities, connectors, extensions, and other pages. Several of those page modules are large.

Proposal: inspect a production bundle report, then split less-used administrative routes. Keep likely landing and chat dependencies available promptly, and preserve intent preloading. Track compressed entry bytes and parse time rather than treating line count as bundle size.

Acceptance: record before/after entry size, cold navigation, and first visit to each split route. Add a regression budget based on that baseline. This review did not build or measure a production bundle.

### P09. Add upload storage budgets before changing storage systems

Status: Done. The quota is checked under a workspace row lock: eight uploads at once for three slots stored three and refused five, and removing a file freed its space; an end-to-end test covers both. Settings → Storage shows the total against the limit, a meter, and the split between files in chats, personalities' sources, and files not sent yet. A refusal says how much is used of how much and to remove sources from a personality. Files in archived chats still count, and only personalities' sources can be removed.

P2 · Confirmed per-file checks; aggregate limits need design · Medium

Evidence: [`sources/service.ts`](../apps/server/src/sources/service.ts), `addFile`, validates file size and stores file bytes in `sourceFiles` within Postgres. Orphan pruning already exists. [`docs/sources.md`](sources.md) explains that attached data is part of the database backup.

Per-file limits do not bound total retained data. Many valid uploads can increase backup size and restore time even when individual requests are safe.

Proposal: add workspace byte accounting, configurable quotas, upload concurrency limits, and a storage usage screen. Keep Postgres storage for modest installations. Consider object storage only after measuring database growth and backup performance, with a design for coordinated backup, deletion, and missing-object recovery.

Acceptance: concurrent uploads must not bypass the quota; deletion must update accounting; quota failures must explain how to free space.

## User experience and accessibility

### U01. Make Delete match its actual retention behavior

Status: Done, as archive and restore. Delete is now Archive, the Chats page has an Archived tab with Restore, an archived chat opens from a link with an Archived badge and Restore, and writing in it brings it back. Archived chats still keep their files, as the threat model says. Permanent deletion wasn't added. Server, web, and real-browser tests cover archive and restore.

P1 · Confirmed · Small for wording, large for permanent deletion

Evidence: [`ConversationMenu.tsx`](../apps/web/src/components/ConversationMenu.tsx) labels the action and confirmation Delete. [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts) implements DELETE by setting `archivedAt`; detail access remains possible. [`docs/threat-model.md`](threat-model.md) explicitly says archived chats retain their files.

Proposal: rename the existing action Archive and offer an archive view with restore. If permanent deletion is added, distinguish it clearly and explain what happens to attachments, task records, audit references, learned memories, and backups. Retain necessary task records without implying that they were erased.

Acceptance: archive and restore a chat, open it from a deep link, and verify copy matches behavior. Permanent deletion needs tests for attached files and shared references before it is offered.

### U02. Complete the shared dialog's keyboard behavior

Status: Done. Dialogs keep Tab inside, focus the panel when there's nothing to type, make the page behind inert and unscrollable, return focus to what opened them, and close only the topmost on Escape; Escape in a menu inside a dialog closes just the menu, and menus return focus to their trigger. DOM tests and a real-browser keyboard journey cover it. Not checked with a screen reader.

P1 · Confirmed · Medium

Evidence: [`components/ui.tsx`](../apps/web/src/components/ui.tsx), `Dialog`, supplies a dialog role and modal flag, focuses a limited selection of inputs, and closes on Escape. It does not contain Tab focus, restore the triggering element, or make the background inert. A dialog with no matching input has no explicit initial-focus fallback.

Proposal: use a tested accessible dialog primitive or implement the complete behavior centrally. Include focus trapping, trigger restoration, fallback focus, background inertness, scroll locking, and topmost-only Escape handling for stacked dialogs. Preserve mobile sheet presentation.

Acceptance: keyboard-only checks for empty confirmation, form, and stacked dialogs. Focus must remain inside the active modal and return to the right trigger after closure. Verify with a screen reader in a later browser audit.

### U03. Protect workflow drafts across tabs and failed navigation saves

Status: Done. Drafts carry a persisted revision; saves and publishes only land on the revision they were based on and answer 409 with the current draft otherwise, and chat and API writes move the revision on. The editor offers load theirs, download mine, or overwrite; holds in-app navigation with retry, stay, or discard; and keeps a final save that failed after close for the next open. End-to-end, web, and browser checks cover it; two real tabs weren't driven at once by hand.

P1 · Confirmed concurrency gap; navigation loss is a risk · Large

Evidence: [`useAutosave.ts`](../apps/web/src/lib/workflow/useAutosave.ts) serializes saves inside one hook, warns on browser unload when dirty, and attempts a final save during cleanup while swallowing failure. [`workflows/service.ts`](../apps/server/src/workflows/service.ts), `saveDraft`, updates by workflow ID without an expected persisted revision.

The existing queue handles edits made during one tab's save. It does not prevent another tab from overwriting those edits. Internal navigation also leaves a failed cleanup save with no visible retry interface after the editor is gone.

Proposal: add a persisted draft revision and compare-and-set saves. Return conflict details and offer reload, copy/export, or deliberate overwrite. Block internal navigation while a save is unresolved or offer discard. Keep a local recovery draft if the product accepts its privacy implications.

Acceptance: edit the same workflow in two tabs, delay responses, and disconnect during navigation. No edit should disappear silently. Publishing must use the revision the user actually reviewed.

### U04. Preserve unsent chat drafts deliberately

Status: Done. Each chat's unsent text is kept in this tab's session storage: it survives switching chats and reloading, and goes when it's sent, when the tab closes, and on sign-out. Files added but not sent aren't kept. Unit tests and a real-browser journey cover it, and the threat model says where drafts live.

P2 · Confirmed local state · Medium

Evidence: [`Chat.tsx`](../apps/web/src/pages/Chat.tsx) and [`Home.tsx`](../apps/web/src/pages/Home.tsx) keep text in component state. Sending clears it on success, which already preserves it on ordinary request failure.

Proposal: retain drafts per conversation across navigation, and decide explicitly whether they also survive reload. Session-scoped storage is a reasonable default for a shared-machine product; persistent storage should have a clear policy. Preserve attachment references only while uploads remain valid and explain expired attachments on recovery.

Acceptance: navigate away and back, reload if supported, fail a send, and sign out. Verify draft retention and cleanup match the documented policy.

### U05. Make ambiguous message sends safe to retry

Status: Done. Each send carries a client ID unique within its chat. Sending the same message again after a failure keeps the ID, so the server returns the saved message, and a deliberate second message gets a new one. A new chat's failed first try reuses the chat it made. An end-to-end test and a real-browser journey that drops the response after the server commits both see one message and one dispatch.

P1 · Risk · Medium

Evidence: the message request schema in [`conversations/routes.ts`](../apps/server/src/conversations/routes.ts) accepts no client message identifier. [`Chat.tsx`](../apps/web/src/pages/Chat.tsx) posts text and attachments. Workflow deduplication uses the newly inserted server message ID.

If the server commits a message but its HTTP response is lost, a manual retry can create another message and another run. Disabling the send button while pending does not cover this failure mode.

Proposal: generate a stable client message ID per submission, enforce uniqueness scoped to the conversation, and return the original result on retry. Show sending, accepted, and failed states, with Retry reusing the same ID.

Acceptance: drop the response after commit, retry, and verify one message and one workflow dispatch. A deliberate second message with identical text must remain allowed.

### U06. Surface failures from conversation menu actions

Status: Done. A failed archive, restore, or Make this a workflow says why and offers Try again; the row stays until the server confirms, and the menu items are disabled while one runs. Web tests return a server error and retry.

P2 · Confirmed · Small

Evidence: [`ConversationMenu.tsx`](../apps/web/src/components/ConversationMenu.tsx) renders `save.error` for renaming, but its remove and make-workflow mutations have no corresponding displayed error in the returned menu/dialog content.

Proposal: show an actionable error near the affected row or in a shared notification, disable repeated activation while pending, and retain enough context to retry. For deletion/archive, keep the item visible until success or restore it on failure.

Acceptance: return 403, 409, and 500 for both mutations. The user must see what failed and have an available next action.

### U07. Complete tabs and review touch interaction

Status: Done for keyboard and announcements; touch measured only in emulation. Tabs have one tab stop, move and select with the arrow keys, Home, and End, show a focus ring, and name the page's panel after the selected tab. On touch screens, small buttons, switches, and row menus take taps from about 7 px around them without making desktop rows taller, and the chat row menu and model favorite star show without hover. Errors are announced as they appear and spinners say Loading. Checked in Chromium with a coarse pointer at 390 px wide, not on a real phone; contrast hasn't been measured.

P2 · Confirmed component behavior, usability needs browser validation · Medium

Evidence: [`ui.tsx`](../apps/web/src/components/ui.tsx), `Tabs`, uses tab roles and selected state without roving tab stops or arrow-key handling. Shared buttons have 26px or 30px default dimensions, and switches are smaller still.

Proposal: implement keyboard tab navigation and panel associations centrally. Review compact controls on actual phones; enlarge touch hit areas without forcing every desktop row to grow. Review `ErrorText` and loading status announcements as part of the same accessibility pass.

Acceptance: arrow keys move between tabs predictably, focus is visible, panels have matching accessible labels, and common phone actions are comfortable at normal zoom. Do not claim visual contrast or touch compliance until a browser audit measures it.

## Security boundaries and operational controls

### O01. Make outbound network permissions explicit per use case

Status: Done. Integration tests on real sockets cover redirects, IPv4 and IPv6 forms, DNS answers that change, cloud metadata, and a deliberately allowed internal service. They found and fixed an uncaught error on redirects that could stop the server, metadata services reachable through allowed origins or IPv4 forms embedded in IPv6, and retried refusals.

P1 when workflow inputs are untrusted · Confirmed documented gap · Large

Evidence: [`workflows/nodes/http.ts`](../apps/server/src/workflows/nodes/http.ts) allows expressions in URLs and headers, follows redirects, and uses ordinary fetch. [`sources/fetch-link.ts`](../apps/server/src/sources/fetch-link.ts) already implements address classification, checked DNS resolution, and pinned connections for source links. [`threat-model.md`](threat-model.md) documents private-network reachability for workflow HTTP requests.

Proposal: extract shared network-policy machinery while retaining distinct policies. Public-source fetching should remain public-only. Workflows that intentionally call internal services should require an explicit administrator-approved destination policy. Check every redirect and resolved destination; block metadata endpoints independently of normal private-network permission.

Acceptance: test redirects to loopback, IPv4 and IPv6 forms, DNS answer changes, metadata destinations, and a deliberately allowed internal service. Preserve existing legitimate internal automations through an explicit migration path.

### O02. Add webhook authentication options, deduplication, and admission limits

Status: Done. Webhook auth (URL only, or signed with the trigger's own encrypted secret), the event-ID header, and a runs-at-once budget live on the trigger and are edited in its panel. Signing secrets rotate separately with a one-hour overlap. The budget is counted in Postgres in the transaction that admits the run, and excess gets 429 before any run exists. `SLING_WEBHOOK_SECRET` stays the fallback. Per-minute rate limits still reset on restart, and GitHub- or Stripe-style signatures can't use this format.

P1 for publicly reachable automation · Confirmed gap in inspected route · Medium to large

Evidence: [`workflows/routes.ts`](../apps/server/src/workflows/routes.ts), `webhookRoutes`, accepts a bearer token in the URL and starts a run without a request dedupe key. No per-hook admission limit is present in that handler. The threat model documents token rotation by changing the trigger node ID.

Proposal: support separately rotatable webhook secrets, optional signed requests with timestamps, provider event IDs for deduplication, and per-hook/workspace rate and concurrency budgets. Preserve raw request bytes where signature verification requires them. Reject excess work before allocating expensive workflow execution.

Acceptance: replay a signed event, send an expired signature, rotate a token, and burst requests. Verify controlled responses and at most one run per deduplicated event. Ordinary unsigned hooks may remain an explicit option.

### O03. Audit logs for URL-borne secrets

Status: Application request-log fix done. Request serialization removes webhook tokens and all query values. Redaction tests pass. External proxy logs are outside this checkout and remain an operator verification task.

P1 to verify · Risk · Small to medium

Evidence: [`http/app.ts`](../apps/server/src/http/app.ts) configures redaction of cookies, authorization, and set-cookie headers. Webhook credentials are in `/hooks/:token`; header redaction does not itself cover URL path credentials.

Proposal: capture representative request logs in a test and inspect server, reverse-proxy, and error-reporting output. Redact bearer path segments and sensitive OAuth query parameters in serializers before persistence. Keep route names and request IDs useful for diagnosis.

Acceptance: send uniquely recognizable test credentials through webhook and OAuth paths; assert that none appear in captured logs. This review did not inspect production logs or establish that a real secret has leaked.

### O04. Separate readiness from liveness and expose useful health signals

Status: Implemented. `/metrics` is off by default (404) and token-protected. It reports request duration by route pattern, job queue depth, lag, and age, pending and failing deliveries, runner connectivity (never part of readiness), event-loop delay, and memory. Alerts are documented, not deployed, and runner replay backlog isn't reported. A real Postgres outage and a real Prometheus server haven't been exercised.

P2 · Confirmed · Medium

Evidence: [`http/app.ts`](../apps/server/src/http/app.ts) returns `{ok: true}` from `/healthz` without checking database or worker state. [`deploy/Dockerfile`](../deploy/Dockerfile) uses that endpoint for its health check.

Proposal: keep a cheap process-liveness endpoint and add bounded readiness checks for database availability, completed initialization, and shutdown state. Report worker lag and runner connectivity separately, since an offline runner should not make the entire API unready. Add request duration, queue age, failed settlement, replay backlog, and event-loop delay metrics.

Acceptance: disconnect Postgres, stall a worker, and initiate shutdown. Each condition should produce the intended readiness response or operational alert without causing a restart loop for a temporary dependency outage.

### O05. Provide a tested backup and restore procedure

Status: Implemented and drilled. Backups are encrypted and kept on a retention schedule, and a restore checks the key and starts with automation paused until the operator resumes it. On 2026-11-09 a fresh project restored and was ready in 8.6 s (16.3 s for a 257 MB database). Login, credential decryption, sources byte for byte, workflow versions, and the pause were verified. Passkeys at a new hostname, runner reconnection, cross-version restores, and the scripts on Linux weren't drilled.

P1 for valuable installations · Proposal based on documentation gap · Medium

Evidence: [`docker-compose.yml`](../deploy/docker-compose.yml) persists Postgres in a volume. Source documentation explains that files live in database backups. The reviewed install/development documentation does not provide a complete restore drill covering encrypted credentials and signing material.

Proposal: document and automate a consistent database backup, required secret/configuration backup, retention, encryption, and restore to an isolated environment. Inventory which keys are necessary to decrypt stored credentials. Keep restored connectors disabled until the operator deliberately enables them, to avoid duplicate sends or automation.

Acceptance: restore a representative installation on a fresh host; verify login, decryption, source retrieval, workflow versions, and controlled runner reconnection. Record actual recovery time and tolerated data loss rather than promising an untested recovery objective.

### O06. Make proxy trust explicit

Status: Done. Proxy trust defaults to off and accepts configured IP/CIDR allowlists. Direct-access and proxy configuration are documented.

P2 · Confirmed configuration, deployment-dependent risk · Small

Evidence: [`http/app.ts`](../apps/server/src/http/app.ts) sets `trustProxy: true`. The installation supports both direct local-network access and tunnel access.

Proposal: configure trusted proxy addresses or hops according to the selected deployment mode. Verify which features use forwarded IP and protocol before changing defaults. Rate limiting and security logs must not rely on client-controlled forwarded headers when the server is directly reachable.

Acceptance: test direct, single-proxy, and tunnel access with spoofed forwarding headers. Legitimate scheme/address handling must remain correct.

## Code structure and engineering workflow

### S01. Split large modules around lifecycle responsibilities

Status: Partial. Chat paging, list cursors, the settlement reconcile, startup and shutdown, metrics, and webhook auth went into their own modules as they changed. The task service and workflow engine are still large; split them when their behavior next changes.

P2 · Proposal · Medium, delivered incrementally

Evidence: at this revision, task service is 1,413 lines and workflow engine is 1,651. Machines, personalities, settings, and workflow editor pages are each roughly 900 to 1,000 lines. [`server.ts`](../apps/server/src/server.ts) constructs a shared context using many `undefined as unknown as ...` placeholders before wiring services.

Proposal: extract task transition/approval/delivery collaborators and workflow claim/wait/recovery/persistence collaborators where the behavior already has a boundary. Extract page-specific forms and data hooks from the largest pages. Give services narrower dependency interfaces so construction order and tests require fewer placeholder values.

Do this alongside a real behavior change, with small reviewable steps. Line count alone is not a reason to split a cohesive function, and generic service abstractions would make this harder to follow.

Acceptance: preserved public behavior, existing tests passing, and new unit tests able to construct the extracted component without bootstrapping unrelated services.

### S02. Carry cancellation through the API client

Status: Done. Every API read passes its query's cancellation signal, so a search replaced by a newer one, or a slow page left before it answered, stops; cancellation never shows as an error. Regression tests cover both.

P2 · Confirmed gap · Small to medium

Evidence: [`lib/api.ts`](../apps/web/src/lib/api.ts) wraps fetch but accepts no AbortSignal or timeout option. Query functions such as [`lib/conversations.ts`](../apps/web/src/lib/conversations.ts) do not pass query cancellation into fetch.

Proposal: accept request options, propagate query signals, and set operation-appropriate timeouts. Treat cancellation as intentional rather than an error toast. Combine mutation retries with explicit idempotency, not a blanket automatic retry policy.

Acceptance: change search text rapidly and navigate away from slow pages. Obsolete reads must abort, and a later response must not disturb the active page.

### S03. Add browser, recovery, and performance checks to the existing CI

Status: Done for the narrow suite. End-to-end tests now cover restarts, settlement reconciliation, approval outcomes, list and history paging, the upload quota race, dispatch retries, webhook signatures and budgets, network policy, startup failures, and metrics. A new CI job runs seven real-browser journeys on a fresh Postgres, and CI holds the first load to a bundle budget. Browser performance budgets beyond bundle size remain open.

P2 · Proposal · Medium to large

Evidence: [CI](../.github/workflows/ci.yml) already runs lint, TypeScript checks/tests, Rust formatting/clippy/tests across platforms, server end-to-end tests, protocol checks, Docker builds, and a runner binary-size budget. Web tests use DOM simulation; the reviewed pipeline has no dedicated real-browser journey or web performance budget.

Proposal: add a small real-browser suite for sign-in, first chat, failed-send retry, machine pairing UI, approval decisions, workflow autosave conflict, reconnect, and modal keyboard behavior. Add crash injection around R01/R02 and deterministic large-history fixtures for P01/P03. Keep each layer focused instead of duplicating every test in the browser.

Acceptance: failures should identify the broken journey or budget and attach useful diagnostics. Maintain a narrow reliable smoke suite before expanding browser coverage.

### S04. Turn documented trust gaps into visible product choices

Status: Declined. Adding explanations at decision points goes against how the app is written, so the user chose to leave these screens as they are.

P2 · Proposal · Medium

Evidence: [`threat-model.md`](threat-model.md) already explains mode limits, read access, external content, extension trust, lock-screen approvals, and single-account scope in detail. These are unusually useful documents, but users make the relevant choices inside the app.

Proposal: show concise explanations at the decision point: what a permission mode allows, why an approval is required, which machine enforces the cap, and what an extension can reach. Link to the exact documentation for detail. Offer a notification privacy setting that hides names or approval actions on sensitive devices. Treat multi-user roles as a separate product decision, since the current documented product is single-account.

Acceptance: a first-time user can explain the consequence of selecting Full access or trusting an extension before confirming. Existing users should not have to dismiss repeated generic warnings.

## Suggested implementation sequence

### First cycle: preserve work and remove misleading behavior

1. Add message submission idempotency, U05, and define the durable dispatch design, R01.
2. Fix archive wording and action error reporting, U01 and U06.
3. Repair the shared dialog, U02, so every approval and setup dialog benefits.
4. Add draft revision conflicts and navigation protection, U03.
5. Add pagination to pending approvals and batch their views, P02 and P03.
6. Verify URL-secret logging, O03, and document the single-process topology, R03.

### Second cycle: recover predictably and bound growth

1. Implement durable dispatch and independent settlement delivery, R01/R02.
2. Page message and event history, P01, then profile rendering.
3. Add socket deadlines and fan-out limits, R05/R06.
4. Add incremental retention and runner replay bounds, P05/P06.
5. Deliver readiness, shutdown behavior, and a restore drill, O04/R07/O05.

### Third cycle: optimize measured bottlenecks and broaden product polish

1. Measure search plans and initial route bundles, P04/P08.
2. Add aggregate storage budgets, P09.
3. Introduce explicit network policy and stronger webhook options, O01/O02.
4. Improve drafts, tabs, touch hit areas, and decision-point explanations, U04/U07/S04.
5. Extract large-module responsibilities as those areas change, S01.

Dependencies matter: pagination should precede large-scale timeline virtualization; idempotency should precede automatic mutation retry; durable execution ownership should precede multiple replicas; metrics should precede database pool tuning.

## Measurement and verification plan

Create synthetic fixtures rather than copying real messages or credentials. Include an ordinary installation and stress cases: many conversations, long chats, large task event histories, over 100 pending approvals, disconnected runners, and a slow browser.

Capture:

- Request p50/p95, response bytes, and SQL query count for chat detail, task detail, chat search, and approvals.
- Database pool wait, query plans, retention duration, and table growth.
- Initial JavaScript size, route load time, interaction delay, and mounted timeline rows.
- Process memory during event fan-out and runner recovery.
- Accepted-message-to-run delay, failed delivery retries, and recovery after restart.
- Successful restore time and actual recoverable backup age.

Choose absolute budgets after recording the baseline and intended hardware. Some acceptance criteria are already absolute: no duplicate accepted message on retry, no silent stale draft overwrite, bounded page size, and no secret in request logs.

## Review checks and limits

The following checks completed during the review. Test output was written outside the repository under `/tmp/sling-audit-*.log`.

- `pnpm typecheck`: passed across the workspace.
- `pnpm --filter @sling/web test`: passed, 37 test files and 394 tests.
- `pnpm --filter @sling/server test`: passed, 44 test files and 496 tests.

Not run: Rust tests, Docker/server end-to-end tests, live-provider checks, production bundle analysis, database query plans, load tests, or a real-browser accessibility audit. Existing CI covers several of these categories, but its current remote status was not checked. No dependencies were installed or upgraded.

The report intentionally does not claim missing encryption, missing tenant checks, missing runner replay, or absent workflow durability. Those mechanisms exist. The proposals focus on specific gaps between them and on behavior that needs a defined operating contract.

## Implementation validation, 2026-11-09

- Workspace type checking and repository lint passed.
- Web suite passed: 37 files, 394 tests.
- Server unit suite passed: 47 files, 502 tests.
- Workflow and rules integration suites passed against disposable Postgres: 47 tests, including durable chat recovery and rejection of a second control-plane owner.
- Runner unit suite passed: 162 tests, one ignored. Its six sandbox integration tests also passed.
- Initial parallel test runs hit timing-sensitive failures. Sequential reruns passed without relaxing budgets. The HTTP integration fixture now explicitly allows its local test origin.
- `git diff --check` passed. No UI component markup or styling was changed. Administrative route loading and client transport behavior did change.

This implementation pass is not complete for every non-UI proposal. In particular, search-plan optimization, backup/restore automation, full lifecycle/fault coverage, metrics, and the remaining items marked Partial or Open still need work. Those entries are deliberately not marked Done.

## Second implementation pass, 2026-11-09

- Lint and every package's type check pass.
- Web suite: 41 files, 421 tests. Server unit suite: 52 files, 564 tests.
- Server end-to-end suite, run file by file against disposable Postgres: 369 of 370 passed. The one failure, the Site down alert in `deploys.e2e`, came from an earlier test's settlement push landing during it. The test now counts only the alert's own pushes, and the file passes in full.
- Runner: `cargo fmt --check` and clippy with warnings denied are clean, with 178 unit tests (one ignored) and 6 integration tests passing on macOS. Compaction and the crash tests haven't run on Linux or Windows yet.
- Real-browser journeys: 7 of 7 pass against a server serving the production build on a fresh database, both before and after merging the parallel branches. CI now runs them on every push.
- The first page load is 292,138 bytes gzip (254,756 brotli), under the raised budget of 301,000 / 263,000.
- Migrations apply in order on a database that already had the earlier ones, and Drizzle reports no drift between the schema and them.
- Every UI change was checked in Chromium in light and dark, and at phone width where layout differs. Nothing was checked on a real phone or with a screen reader.

Measured during this pass: the P04 query numbers on 20,000 chats and 1M messages, the P05 prune timings, the P08 bundle sizes, and the O05 restore drill, each in its item above. Not run: a real power cut, cross-platform runner timings, a two-process deployment, or a live Prometheus scrape.

## Third pass, 2026-11-10

Source revision before the pass: `3d37a68`. This pass started from the running app, which the first review never opened. Every page was walked in Chromium in dark and light at 1440px and at 390px, on an empty workspace and on one with a paired machine, and real chats and one coding task ran through Claude Code. Four code reviews ran alongside, one each for the server's chat and task paths, automation, the web app, and the runner and install path, with the items above as the list of things not to repeat. The findings were then fixed in 90 commits.

The user decided four questions first. A newly paired machine's cap is Auto, and machines paired before keep theirs. A Full access deploy waits for the PR's CI before it merges. In a Telegram group, Sling answers only people whose own ID is allowed. On touch screens Enter adds a line and the button sends.

What changed:

- Chat turns. A message sent while a reply is being written gets its own reply. A turn that runs out of steps answers on its last one. A turn loads the latest 80 messages without their traces. Retry, Edit and start-rule turns are queued with the message change. The note the assistant gets when a task settles says Sling committed the work, and a repo with no remote gets no push or PR step.
- Tasks, approvals and machines. An approval and its step move in one transaction. Machines are marked offline at startup. A cancel made while a machine was away holds when it returns, and a task the server already ended is stopped on the machine. Sign-in rate limiting uses the address the server resolves.
- Security. The runner checks every task ID the server sends. An email allow rule matches only recipients the mail sender reads the same way. A bad extension package no longer hangs the reader. Extension code can't signal other processes. Sandboxed commands can't reach Unix sockets on Linux. Repo remotes are sent without embedded credentials, and command output is masked like task output. Mail logins require STARTTLS when TLS isn't direct.
- Automation. A paused copy leaves sandboxes, merges and deploys alone. A minute sweep picks up stuck workflow runs. Reply checks, slow checks, cron validation, recurring calendar events with a zone name, and the email catch-up window were each fixed. Connector and ntfy cursors stay on a message until its run starts.
- Runner. Work an agent committed itself is delivered. Git steps get five minutes and task pushes skip pre-push hooks. SIGTERM interrupts running tasks and reports them. Read-only tasks make no branch, and cleanup deletes task branches with nothing left to deliver. A sandbox's runner stays up while its commit waits for approval.
- Install and release. The release fails when its tag differs from the Cargo version, images wait for the release, and CI builds every release target. Re-running the installer on a paired machine restarts the runner on the new binary. No release has been cut, so the README's install command still needs a first tag.
- Web. Chat, task and run pages start fresh when their ID changes. Typing and streaming no longer re-parse every loaded message. A new build loads on the next navigation after a deploy. Failed loads, unknown URLs and route errors show inside the app. Sign-in returns to the page it was sent from, and Back keeps list tabs, filters and scroll. Each count and control shows once per page, empty states share one layout, states and times read the same everywhere, and Settings, Tasks and Workflows fit a phone.

Still open, each a decision or a larger change:

- Previewing an extension package from a key that isn't trusted yet still runs its `describe` code, because the Permissions section is built from what it returns.
- A Read-only Codex task in a sandbox runs with Codex's own sandbox off. The threat model now says so. Refusing those tasks would be a product change.
- The macOS command sandbox profile allows by default with a deny list.
- A Full access deploy waits for every check on the PR, not only required ones, and a repo with no CI merges after the CI check's three-minute "none started" window instead of at once.
- The workflow run cursor is rewritten in full twice per node. A 1,000-item loop with 2 KB items took 100 seconds. The fix stores loop items outside the cursor and needs a migration.
- The chat lists messages in saved order, so a message sent mid-turn shows above the reply to the one before it.
- A reply that lands after its chat was archived restores the chat.
- A result that arrives after its task was marked interrupted is dropped.

Checks on the merged result:

- Lint, every package's type check, `cargo fmt --check` and clippy with warnings denied pass.
- Runner: 194 unit tests (one ignored) and 6 sandbox integration tests pass on macOS. The Linux command sandbox test ran in a container. The Windows code type-checks for `x86_64-pc-windows-msvc` and has not run on Windows.
- Server: 87 test files. Run together, 16 end-to-end files failed on timing budgets and timeouts with the load average above 40. Each of the 16 passes when run alone. One older test expected a turn to be cut off silently at its step limit and was rewritten for the new behavior.
- The Docker sandbox test passes against a `sling-sandbox:dev` image rebuilt from this revision: 2.7 seconds from request to a connected runner, and 0.3 seconds from delivery to a destroyed container.
- Web: 44 files, 454 tests. The other packages' suites pass.
- Browser journeys: 7 of 7 against the production build on a fresh database. The archive journey now waits for the reply before archiving.
- First load is 294,671 bytes gzip (257,215 brotli), under the budget of 301,000 / 263,000.
- In Chromium against the merged build with a paired runner: a message sent mid-turn was answered, a task on a repo with no remote asked for no approval and was reported as committed on its branch, the composer no longer carries state between chats, Escape and the mode menu close the model picker, unknown URLs show inside the app, and no page scrolls sideways at 390px apart from the Chats tab strip and the Machines footer bar. This used five short assistant turns and one coding task on Claude Haiku at low effort.

Not run: anything on Windows or a real phone, systemd on a Linux desktop, an install behind a real proxy or a private CA, the GitHub workflows on Actions, a real protected GitHub repo, real mail servers with STARTTLS stripped, and a restore drill with the paused sweep.

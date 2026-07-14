# Sidebar v2 (beta): flat adaptive-density list with settled threads

Status: planned
Mocks: https://hsyscdqldmk5.postplan.dev/ (concept 4 base + concept 1 card layout + concept 3 needs-you pinning)

## Summary

A new thread sidebar behind a client-settings beta toggle. Core changes vs. the
current sidebar:

- **Flat recency list.** Project group headers are gone; project identity moves
  onto the row as the existing `ProjectFavicon` (environmentId + cwd). This
  matches the session lists users know from Claude Code, Codex, and Cursor.
- **Adaptive density via a "settled" lifecycle state.** Active threads render
  as two-line cards: favicon + title + time, then a structured meta line
  (status word · branch · harness glyph + model · machine). Settled threads
  collapse to slim one-liners, roughly today's row height. No generated or
  free-text summaries anywhere — every field on a card is data the shell
  already carries.
- **Settled is an explicit state**, not a derived one: users settle threads
  manually, or threads auto-settle (PR merged/closed, inactivity). Any real
  activity auto-unsettles. Settled is a lifecycle stage between active and
  archived — it stays in the list, just quiet.
- **Four visual states, three colors.** Needs approval (amber, pinned above
  the recency flow with "waiting Xm"), Working (sky, pulsing, elapsed timer),
  **Ready** (uncolored and unlabeled — the normal resting state: the agent
  stopped and is waiting on you, whether it finished, asked a question, or
  proposed a plan; bold title until visited is the only signal), Failed (red,
  `session.lastError` — a dead session shows nothing today). Today's Awaiting
  Input / Plan Ready / Completed-unseen pills all collapse into Ready: they
  differ in detail, not in what the user should do (look at the thread).
  Color is reserved for "act now" (amber), "in motion" (sky), "broken" (red).
- **Harness / model / machine as quiet metadata.** A tinted glyph before the
  model name distinguishes Claude Code / Codex / other; a machine label
  renders only when the thread lives on a different computer than the one
  you're looking at. Display-only lookups from shell data, no new plumbing.
- **Settled feeds cleanup.** Settling a thread offers/permits worktree cleanup;
  long-settled threads are candidates for future auto-archive.

The v2 component is a sibling of the current sidebar, swapped at a single mount
point. The current sidebar is untouched except for the swap seam.

## Rationale

Full design discussion lives in the session that produced the mocks; the short
version:

- We aren't in a position to teach users a new interaction model. Every v2
  mechanic maps to an existing habit: flat recency list (Claude Code / Codex /
  Cursor), settle (Gmail archive / GitHub notifications "Done"), unread-bold
  (email). Zero new gestures.
- "Settled" makes the adaptive-density row-height rule *stable*: height changes
  only at real lifecycle transitions, never from ambient re-rendering. This
  kills concept 4's "jumpy list" risk.
- Viewing a thread does **not** settle it. Visiting clears unseen (existing
  `lastVisitedAt` mechanics); settling asserts "this work is concluded." If
  viewing settled, auto-unsettle would fight the user and the state would stop
  meaning anything.
- Settling is optional by design. The auto rules are the hedge against
  inbox-zero fatigue: a user who never touches the affordance still gets a
  naturally tidy list. Beta telemetry question: what fraction of settles are
  manual vs. auto?

## The settled model

```
Active ──(user settles | PR merged/closed | inactivity ≥ threshold)──▶ Settled
Settled ──(new user message | session starts | approval requested |
           PR reopened | user un-settles)──▶ Active
Settled ──(existing archive flow, or future auto-archive)──▶ Archived
```

Settled is a **computed property with one stored override**:

```
effectiveSettled(thread) =
  override === "settled"                                → true   (manual settle)
  override === "active"                                 → false  (manual keep-active)
  pr.state ∈ {merged, closed}                           → true   (auto)
  lastActivityAt < now − inactivityThreshold            → true   (auto)
  otherwise                                             → false
```

- The stored field is a tri-state: `settledOverride: "settled" | "active" | null`
  plus `settledAt: IsoDateTime | null` (set when override becomes "settled",
  used for display and future auto-archive aging).
- The auto cases need no background job and no events — they fall out of data
  the sidebar already streams (`vcs.status` change request state,
  `latestUserMessageAt` / turn timestamps). Auto-unsettle for the time-based
  case is free: activity moves the timestamp, the predicate flips.
- **Activity clears the override.** Any thread activity event (new user
  message, session start, approval request) resets `settledOverride` to null
  server-side, so a manually settled thread that wakes up becomes active again
  and later auto-rules apply fresh. Likewise, manually un-settling a merged-PR
  thread sets `settledOverride: "active"`, which beats the PR auto-rule.
- Inactivity threshold: default 3 days, client setting, `null` = never
  auto-settle by time.

Server-side storage (next to `archivedAt` on the thread) rather than
client-local: settled must sync across desktop/remote environments, and the
worktree-cleanup hook needs the server to know. This mirrors the
`archivedAt` / `thread.archived` / `thread.unarchived` pattern exactly.

Consequences of being settled:

- Row collapses to the slim one-liner.
- Excluded from status rollups (any badge counts, aggregate status dots).
- Eligible for worktree cleanup prompting (see below).
- Future: settled ≥ 30 days → auto-archive candidate (not in this phase).

## Swap strategy: component swap at the mount point

Decision: **swap the whole sidebar component**, not internals.

The current `Sidebar.tsx` (~3750 lines) takes no props — it reads everything
from hooks/atoms/stores — and `AppSidebarLayout.tsx:93` is its single mount
point. The truly shared behavior (thread-jump keybindings, selection store,
uiStateStore, `useThreadActions`, context-menu via `readLocalApi()`) already
lives *outside* the component in hooks and stores, so a sibling component
inherits all of it by calling the same hooks. What lives inside Sidebar.tsx
(project grouping, drag-and-drop, show-more, per-project collapse) is exactly
the stuff v2 deletes — threading a variant flag through it would mean touching
hundreds of conditional branches for no benefit.

```tsx
// AppSidebarLayout.tsx — the entire seam
const sidebarV2 = useClientSettings((s) => s.sidebarV2Enabled);
...
{sidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}
```

Rules for the seam:

- `SidebarV2.tsx` imports freely from `Sidebar.logic.ts`,
  `ThreadStatusIndicators.tsx`, `useThreadActions`, `threadSelectionStore`,
  `uiStateStore` — shared logic stays shared.
- `SidebarV2.tsx` must not import from `Sidebar.tsx`, and vice versa. Anything
  both need moves into `Sidebar.logic.ts` (or a new shared module) first.
- The settled *data model* (contracts, server, reducer) is flag-independent —
  it ships dark and is simply unused by the v1 component. Only the *UI* is
  gated. This keeps the toggle a pure view swap: flipping it never migrates
  data, so switching back and forth is always safe.
- v1 remains the default. Deleting v1 is a separate future decision once beta
  feedback lands.

## Implementation phases

### Phase 1 — Settled data model (ships dark, no UI)

Mirror the archived pattern end-to-end:

1. `packages/contracts/src/settings.ts`: add to `ClientSettingsSchema`:
   - `sidebarV2Enabled: boolean` (default false)
   - `sidebarAutoSettleAfterDays: number | null` (default 3)
2. `packages/contracts/src/orchestration.ts`:
   - Thread shell: `settledOverride: "settled" | "active" | null`,
     `settledAt: IsoDateTime | null` (both with decoding defaults of null —
     old persisted threads decode unchanged).
   - Events: `thread.settled` (threadId, settledAt, updatedAt),
     `thread.unsettled` (threadId, updatedAt). Payload schemas alongside
     `ThreadArchivedPayload` / `ThreadUnarchivedPayload`.
   - Commands: `thread.settle`, `thread.unsettle`.
3. `apps/server/src/orchestration/decider.ts`: handle both commands, mirroring
   archive/unarchive. Invariants in `commandInvariants.ts`
   (`requireThreadNotArchived` applies; settle of an already-settled thread is
   a no-op rather than an error — idempotent for bulk operations).
   In the decider paths that record thread activity (user message appended,
   session started, approval requested): if `settledOverride !== null`, also
   emit `thread.unsettled` to clear it.
4. `packages/client-runtime/src/state/threadReducer.ts`: reduce both events
   (`threadReducer.ts:87-101` is the archive template). Tests alongside the
   archive reducer tests.
5. `packages/client-runtime` (new `threadSettled.ts` or in `threadSort.ts`):
   pure `effectiveSettled(shell, { now, autoSettleAfterDays })` implementing
   the predicate above, plus `lastActivityAt(shell)` (max of
   latestUserMessageAt, latest turn completion, session start). Unit-test the
   truth table: each override state × PR state × inactivity.

Verification: `bun run typecheck`, reducer + predicate unit tests. No visible
change anywhere.

### Phase 2 — SidebarV2 component + beta toggle

1. Settings UI: "Beta features" section (new panel in
   `apps/web/src/components/settings/SettingsPanels.tsx` + route, matching the
   existing settings-page pattern) with the v2 toggle and, indented under it,
   the auto-settle threshold control.
2. Swap seam in `AppSidebarLayout.tsx` as above.
3. `apps/web/src/components/SidebarV2.tsx`, reusing shared modules. Structure:
   - **One flat virtualized list** of all non-archived threads across
     projects. Sort key: (needs-approval first, by wait time) → then recency
     (`latestUserMessageAt`, reusing `threadSort.ts`). No show-more, no
     project collapse, no dnd.
   - **Row variants** (single `SidebarV2Row` with a `variant` prop, both
     variants rendered from the same shell data):
     - `card` (~52px, threads where `effectiveSettled` is false): line 1
       `ProjectFavicon` + title (+ diff stats when present) + time ("waiting
       Xm" in amber when approval-blocked, live elapsed for working); line 2
       structured meta — status word (only for the colored states) · branch ·
       harness glyph + model · machine (only when the thread's environment is
       not the current machine). Left rail color only for approval (amber),
       working (sky, pulsing), failed (red) — Ready rows carry no color or
       label, just a bold title while unread. No free-text/generated content.
     - `slim` (~28px, settled): `ProjectFavicon` · title · PR badge when
       notable · time. Visually close to today's v1 row.
   - **Status derivation** consolidates `Sidebar.logic.ts`'s pill logic into
     four visual states: Needs Approval, Working (incl. connecting), Ready
     (today's Awaiting Input + Plan Ready + Completed-unseen — same user
     action, different payload), and new Failed (`session.lastError` on a
     non-running session). Keep it in `Sidebar.logic.ts` so v1 can adopt
     Failed later too.
   - **Unread**: bold title until visited, from existing
     `uiStateStore.threadLastVisitedAtById` — same mechanics as today's
     Completed-unseen pill.
   - **Row height changes only on lifecycle transitions** (settle/unsettle),
     animated with the existing auto-animate pattern. Streaming/status
     updates within a variant never change height.
   - Preserved v1 behaviors, via the shared hooks: click-to-open, multi-select
     (threadSelectionStore), context menu (add Settle/Un-settle entries),
     inline rename, thread-jump shortcut labels, archive affordance, PR icon
     link, port/terminal/remote indicators (moved into line 3 / slim row
     trailing icons).
4. Settle affordances:
   - Hover action on the row (next to today's archive hover button) +
     context-menu entry + bulk via multi-select.
   - `useThreadActions`: add `settleThread` / `unsettleThread` mirroring
     `archiveThread` (`useThreadActions.ts:91-134`), minus the navigation
     dance — settling never navigates away.
   - No keyboard shortcut in the first cut; add via keybindings once the
     affordance proves out.

Verification: typecheck/lint; toggle on → v2 renders, toggle off → v1
identical to before; settle/unsettle round-trips including across a
desktop+remote pair; kill a session mid-run → Failed card appears.

### Phase 3 — Worktree cleanup hook

Settling is the natural moment to reclaim disk:

1. On **manual settle** of a thread whose worktree is orphaned
   (`getOrphanedWorktreePathForThread`, `worktreeCleanup.ts:11-33`): show a
   non-blocking inline prompt/toast — "Worktree kept · Remove?" — that calls
   `vcsEnvironment.removeWorktree`. Never remove without an explicit click;
   never block the settle on the answer. Skip the prompt entirely when the
   worktree has uncommitted changes or unpushed commits (check via the
   existing vcs status the sidebar already has).
2. **Auto-settle does not touch worktrees** in this phase. A settings-page
   "Storage" affordance listing orphaned worktrees of settled threads (with
   sizes, bulk-remove) is the follow-up; tracked but not in scope.

### Phase 4 — Beta telemetry & exit criteria

Instrument (whatever the existing analytics path is — if none, a lightweight
local counter surfaced in diagnostics is enough for the beta):

- settle events by source: manual / auto-PR / auto-inactivity / bulk
- un-settle events: manual vs. activity-driven (activity-driven un-settles of
  *manual* settles = the model fighting users)
- toggle-off rate after trying v2

Decision inputs for exiting beta: if manual settling is ~0%, shrink the
affordance and lean on auto rules; if activity-unsettle-of-manual-settle is
high, the inactivity threshold or unsettle triggers need retuning.

## Explicitly out of scope

- Inline approve/reject in the sidebar (concept 3) — needs a safety story.
- Message snippets in rows (concept 2) — streaming churn unsolved.
- Ops-grid density mode (concept 5).
- Auto-archive of long-settled threads.
- Removing v1 / making v2 the default.
- Project grouping inside v2 (v1 remains available for users who want groups).

## Open questions

- Where thread "activity" is centrally observable server-side for the
  unsettle-on-activity rule — if the decider paths are too scattered, an
  acceptable fallback is client-side: compute `effectiveSettled` with the
  activity timestamps and only use the override for manual state (activity
  newer than `settledAt` wins). Decide during Phase 1 once in the decider.
- Whether `settledAt` belongs in the thread *shell* stream (sidebar reads
  shells only) — it must, or v2 can't sort/collapse without detail loads.
  Verify shell projection includes it.
- Diff stats on cards require checkpoint data in the shell; if absent, defer
  diff stats rather than loading details for every row.

# Three-way Hermes comparison: Parker, Ben, and Maria

Audited July 26, 2026 from primary source:

- Parker/eimexdev: [`eimexdev/t3agent` at `dcfb3af20`](https://github.com/eimexdev/t3agent/tree/dcfb3af20)
- Ben Davis: [`pingdotgg/t3code` branch `experiment/hermes-provider` at `c696e04e8`](https://github.com/pingdotgg/t3code/tree/c696e04e8)
- Maria/maria-rcks: [PR #4604, `hermes/h0-conformance` at `ed683990c`](https://github.com/pingdotgg/t3code/pull/4604), stacked on the orchestration-v2 migration

This is a source and test audit, not a fresh three-way usability run. “Implemented” means code and focused tests exist; UX judgments are inferred from those sources. The branches are also not based on the same T3 revision. Parker changes roughly 143 files / 18.8K additions, Ben 98 files / 15.0K additions, and Maria 210 files / 31.7K additions relative to their relevant bases.

## Executive conclusion

There are now three distinct strengths:

- **Parker/eimexdev has the most mature Hermes-native conversation product.** Its best work is session identity and lifecycle, a focused agent shell, commands, titles, model/reasoning, voice, images, and durable asynchronous delivery.
- **Ben Davis has the best self-hosted provider connection and administration design.** Its best work is outbound enrollment, credentials, multi-instance management, WebSocket liveness, connection replacement, and recovery.
- **Maria/maria-rcks has the broadest upstream-shaped unification design.** It integrates “T3 Work” and “T3 Code” in web and mobile, uses orchestration v2, talks to official `hermes serve`, imports existing sessions, supports rich files and cron/proactive infrastructure, and explores Hermes-to-T3 coding delegation.

If Parker is evolving his fork rather than replacing it, he should not pull one branch wholesale. The recommended target is:

```text
Maria's unified T3 Work/T3 Code product and orchestration-v2 seams
  + Ben's enrollment, outbound topology, instance lifecycle, and liveness
  + Parker's session semantics, focused UX, voice, title authority, and durable outbox
```

Maria is the most relevant architectural reference for where the product should end up. Ben remains the best source for how a separately running Hermes should securely connect to a remote T3 installation. Parker remains the best source for how Hermes should feel after the connection exists.

## Feature and architecture matrix

| Area                     | Parker/eimexdev `t3agent`                                                               | Ben Davis provider                                                                             | Maria/maria-rcks T3 Work                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product shape            | Separate Hermes-first launcher/product mode                                             | Hermes inside ordinary T3 Code as a provider                                                   | Explicit T3 Code / T3 Work workspace switch in one product, web and mobile                                                                                                |
| Hermes interface         | Custom Python platform adapter and T3 bridge                                            | Custom Python platform plugin                                                                  | Official `hermes serve` WebSocket gateway plus provider adapters                                                                                                          |
| Transport                | Authenticated HTTP in both directions; loopback ingress by default                      | One outbound WebSocket from Hermes to T3                                                       | T3 connects to a local `hermes serve`; remote is fail-closed unless stronger trust is available                                                                           |
| Setup                    | Manual plugin/env coordination                                                          | Guided one-time enrollment, persistent per-instance credential, restart/status commands        | Managed local startup or attach to configured gateway; operational configuration is broader but less polished than Ben's pairing wizard                                   |
| Multi-instance           | Protocol has instance identity; product is still centered on built-in `hermes`          | First-class named instances, revoke/remove/status/version                                      | Provider-instance scoped bindings and profile keys; broader orchestration-v2 integration                                                                                  |
| Conversation UX          | Most specialized and polished Hermes shell                                              | Mostly standard T3 thread UX plus steer/stop and offline state                                 | Broad T3 Work product shell and projectless conversations; less proven by hands-on browser testing                                                                        |
| Session discovery/import | Searchable browser; import as child copy; reopen/import another; fork and lineage       | None; only T3-created deterministic sessions and reconnect recovery                            | Recent/all/selected session discovery and lazy historic import from Hermes sources; explicit limitations where gateway lacks lineage or safe arbitrary historic branching |
| Titles                   | Hermes-authoritative rename and reconnect reconciliation                                | Standard T3 title behavior                                                                     | Hermes title/branch lineage persistence exists; broader than Ben, but Parker's authority policy is clearer and more battle-tested                                         |
| Models/reasoning         | Authenticated model inventory and per-session controls                                  | Default model shown read-only                                                                  | Model and reasoning selection integrated into orchestration-v2                                                                                                            |
| Commands/tools           | Commands, aliases, skills/plugin commands, argument hints; lifecycle interception       | Tools, approvals, clarify, steer/interrupt; no command picker                                  | Hermes commands and native activities; provider-v2 projection and richer orchestration integration                                                                        |
| Files/media              | Images both directions                                                                  | Attachments intentionally unsupported                                                          | Images, video, PDF, generic files, imported media; server asset-access work                                                                                               |
| Voice                    | Full recorder, draft recovery, waveform, playback, Hermes STT, correlated transcription | None                                                                                           | No equivalent complete recording/transcription product was found; Parker remains strongest                                                                                |
| Cron/proactive           | T3 home destination, durable thread routing, ingress idempotency and completion outbox  | Explicitly session-only; suppresses `/sethome` and does not route cron/cross-platform delivery | Cron settings, scheduler contracts, proactive-event repository, migrations and tests                                                                                      |
| Web/mobile               | Rich web fork; no equivalent breadth of native-mobile changes                           | Web provider settings/runtime adaptation                                                       | Web and native mobile workspace switching, projectless draft/start/sidebar behavior                                                                                       |
| Hermes delegates coding  | Not a central implemented product capability                                            | No                                                                                             | Hermes ACP plus restricted per-session MCP lease design for delegating into T3 orchestration; capability-gated                                                            |
| Reliability emphasis     | Durable admission/delivery across restarts                                              | Live socket correctness and provider lifecycle                                                 | Reconciliation, persisted bindings/imports/proactive events, guarded ambiguous writes, conformance evidence                                                               |

## Parker/eimexdev: strongest product semantics

Parker’s core architectural decision is still excellent: Hermes owns the agent runtime, session context, model validation, titles, transcription, and cron; T3 owns the visible conversation projection. That is documented in the [architecture](https://github.com/eimexdev/t3agent/blob/dcfb3af20/docs/architecture/t3-agent.md) and encoded in the [conversation lifecycle service](https://github.com/eimexdev/t3agent/blob/dcfb3af20/apps/server/src/provider/hermes/HermesConversationLifecycle.ts).

Its unique strengths remain:

- A coherent lifecycle for reopening T3-owned sessions, importing foreign sessions as child copies, forking at completed-run boundaries, and displaying lineage.
- Hermes-authoritative titles rather than two systems independently naming one conversation.
- The richest day-to-day input experience: command discovery, aliases, skills, argument hints, model and reasoning controls.
- The only complete voice-note product: recording, pause/resume, recovery, waveform, playback, Hermes-owned STT, and attachment-correlated transcription.
- Durable HTTP admission and completion delivery. The [Python adapter](https://github.com/eimexdev/t3agent/blob/dcfb3af20/integrations/hermes/t3agent/adapter.py) claims requests before dispatch and persists a completion outbox, which matters for cron/background results and process restarts.

Its weaknesses are operational and structural:

- Setup still requires manually coordinating URLs, identities, and two secrets.
- The two-way HTTP topology is convenient when the launcher and Hermes are co-located, but remote use needs tunneling/forwarding and has weaker instantaneous connection truth.
- The product assumes a built-in Hermes instance more often than a general provider implementation should.
- The 3,037-line Python adapter and 1,225-line TypeScript adapter each combine too many policies. Tests are extensive, but upgrade and review cost is high.
- Some Effect APIs predate current T3 standards: unnamed `Effect.gen` callables, broad orchestration shells, and a module-global bridge registry should become named `Effect.fn` operations and scoped services.
- Rich raw tool arguments/results need an explicit disclosure/redaction policy for remote use.

## Ben Davis: strongest connection substrate

Ben’s [gateway README](https://github.com/pingdotgg/t3code/blob/c696e04e8/integrations/hermes-t3-gateway/README.md) defines a deliberately narrower product but a superior operational connection:

- Hermes dials T3 over one outbound WebSocket; no public Hermes listener is needed.
- A ten-minute enrollment token is exchanged directly for a long-lived instance credential that is never printed.
- Instances are named, independently revocable/removable, versioned, and observable.
- Durable instance configuration, secret data, and volatile connection/liveness state are separated.
- Connection generations force session re-ensure when a socket is replaced, even if UI state never visibly transitions through offline.
- Heartbeat, request correlation, stale-socket teardown, bounded reconnect, active-turn recovery, shutdown behavior, and handshake races have focused tests and several follow-up hardening commits.

Ben’s UI contribution is meaningful but concentrated in setup and administration:

- Add-Hermes wizard, generated install/enrollment/restart commands, clipboard fallbacks, expiring-token regeneration, and automatic connected-state transition.
- Instance cards for connected/offline/revoked/upgrade-required state, versions, last connection, active sessions, enrollment regeneration, revoke and remove.
- Named picker entries, truthful read-only default-model label, unavailable-thread messaging, and no silent rebinding.
- Separate steer and stop controls during an active turn.

It does **not** have session discovery/import, fork/lineage, model changes, reasoning, command catalog, files, voice, title authority, or unsolicited cron/proactive delivery. “Resume” in this branch means recovering a T3-created live session after transport replacement, not importing a Hermes conversation.

Code quality is strongest around explicit services and failure cases, but not uniformly deep. [`HermesGatewayBroker.ts`](https://github.com/pingdotgg/t3code/blob/c696e04e8/apps/server/src/provider/Layers/HermesGatewayBroker.ts) is about 1,240 lines and still combines enrollment, persistence, credentials, routing and lifecycle; the adapter is about 911 lines. There is Effect migration debt (`Effect.gen` APIs rather than named `Effect.fn`). The [compatibility inventory](https://github.com/pingdotgg/t3code/blob/c696e04e8/integrations/hermes-t3-gateway/COMPATIBILITY.md) also documents brittle exact-string/FIFO couplings to Hermes 0.19.0. Its candor is a strength, but the coupling remains.

## Maria/maria-rcks: broadest upstream convergence

Maria’s PR is not merely another provider. It establishes T3 Work beside T3 Code and carries Hermes through contracts, persistence, orchestration v2, web, mobile, assets, provider drivers, ACP/MCP integration, session import, and cron.

The strongest architectural choices are:

- **Official gateway boundary.** It connects to `hermes serve` rather than installing a second custom Hermes platform adapter. A dedicated [gateway client](https://github.com/maria-rcks/t3code/blob/ed683990c/apps/server/src/hermes/HermesGatewayClient.ts) owns request/event behavior.
- **Evidence-first compatibility.** The [conformance harness](https://github.com/maria-rcks/t3code/blob/ed683990c/docs/integrations/hermes-conformance.md) pins an exact Hermes revision, sanitizes captured evidence, gates mutations, treats ambiguous writes as indeterminate, and records unsupported capabilities rather than inventing them.
- **Correct import honesty.** [`hermesSessions.ts`](https://github.com/maria-rcks/t3code/blob/ed683990c/packages/contracts/src/hermesSessions.ts) exposes discovery and lazy-history capabilities while explicitly reporting that the pinned gateway cannot recover parent lineage or safely copy at an arbitrary historic boundary.
- **Durable integration.** Separate repositories/migrations exist for session bindings, imports, title/branch lineage, proactive events, and reset behavior.
- **Cross-platform product.** T3 Work is represented in mobile preferences, navigation, new-task flow and sidebars as well as web.
- **Future agent composition.** Hermes ACP support and restricted per-session MCP leases point toward Hermes delegating coding work to T3 providers without a permanent global credential.

Maria’s feature breadth is the highest: projectless Work conversations, session discovery/import from Discord/Telegram/other Hermes sources, lazy history hydration, model/reasoning controls, native activities, images/video/PDF/files, cron settings and proactive event persistence, and Code/Work switching.

However, Maria is not simply “Ben plus Parker, finished”:

- Remote Hermes is currently intentionally unsupported by the security assessment even when configured, because the available transport cannot prove scoped pairing and TLS fingerprint verification. [`HermesConnectionSecurity.ts`](https://github.com/maria-rcks/t3code/blob/ed683990c/apps/server/src/hermes/HermesConnectionSecurity.ts) fails closed. Ben is much further ahead for securely connecting a remote/NATed Hermes.
- Her imports bind discovered durable sessions and lazily hydrate history; they do not reproduce Parker’s child-copy isolation or arbitrary completed-run fork semantics, because the official pinned gateway cannot prove those operations safely.
- No Parker-equivalent voice recorder/transcription experience is present.
- The implementation is one 31.7K-line commit stacked on a large orchestration-v2 migration. Merge, review and bisect risk are far higher than either focused branch.
- Concentration is severe: `HermesServeAdapterV2.ts` is about 3,411 lines, `HermesGatewayClient.ts` 1,513, and `HermesSessionBindingRepository.ts` 1,363. The contracts/repositories are well separated, but the main adapter is not a deep module.
- It touches 210 files and foundational orchestration code. Even with roughly two dozen Hermes-specific test files, browser, simulator and real multi-surface exploratory validation are especially important.
- ACP/MCP delegation is capability-gated and partly prospective. The conformance document explicitly says the pinned protocol lacks per-session MCP registration/replacement/revocation and therefore keeps `supportsMcpTools` false until contracts and conformance exist.

Against current T3 TypeScript/Effect standards, Maria is strongest on schema-first contracts, tagged errors, package ownership, explicit unsupported states, and persistence seams. The oversized adapter and broad one-commit change are the largest maintainability failures. Ben is strongest on scoped connection lifecycle but also has large service implementations and Effect naming debt. Parker is strongest on extracted conversation-domain policy but weakest on Python modularity and provider-instance generality.

## What Parker should pull from Ben

These remain high-confidence ports even after Maria’s branch appeared:

1. **Outbound connection and enrollment UX.** Use one-time enrollment, direct persistent credential issuance, rotation/revocation, version negotiation, and generated restart/status commands.
2. **Provider-instance lifecycle.** Adopt named instances, durable binding, separate secret/volatile state, removal without rebinding, and clear version/active-session diagnostics.
3. **Connection-generation recovery.** Re-ensure sessions on socket replacement, not only on an offline/online edge.
4. **Heartbeat and race tests.** Port the handshake-ping, delayed-pong, stale-generation, shutdown, reconnect, and in-flight-request cases.
5. **Conservative tool disclosure.** Prefer an allowlist/redaction policy over sending arbitrary tool arguments/results.

Do not port Ben’s session-only scope, exact-string suppression, read-only model ceiling, or lack of durable asynchronous delivery.

## What Parker should pull from Maria

Maria now offers the more important long-term product and upstream architecture:

1. **One product with explicit Code and Work workspaces.** Replace fork-wide product mode with a durable workspace/presentation policy shared by web and mobile. Keep the launcher as a thin “open T3 Work” entry point if desired.
2. **Orchestration-v2 provider seams.** Port onto the upstream migration rather than expanding the older provider/orchestration bridge. Reuse Maria’s provider driver, session manager, event ingestor and projection seams where they survive review.
3. **Official `hermes serve` client and conformance discipline.** Prefer a public gateway API over deep Hermes-private imports. Adopt pinned evidence, sanitized fixtures, fail-closed capabilities, and “indeterminate after ambiguous write” behavior.
4. **Durable repository layout.** Separate session bindings, imported-session records, proactive events, and lineage/title persistence rather than adding more responsibilities to Parker’s adapter.
5. **Cross-platform client-runtime model.** Move Work/Hermes state shared by web and mobile into contracts/client-runtime; avoid web-only forks of conversation state.
6. **General attachment pipeline.** Parker’s images are good, but Maria’s image/video/PDF/generic-file contract and asset authorization are the broader base.
7. **Cron administration.** Pull the cron contracts, settings surface, validation and proactive-event repository, then combine them with Parker’s completion outbox and destination semantics.
8. **Restricted per-session delegation design.** Preserve the idea that Hermes may invoke T3 coding orchestration only through scoped, revocable leases. Do not enable it until the gateway exposes and passes conformance for register/replace/revoke.
9. **Projectless Work conversations.** Keep internal backing-project mechanics out of the user’s Work mental model.

Do not cherry-pick Maria’s 3,411-line adapter or merge the 31.7K-line commit as an indivisible feature. Do not weaken her fail-closed remote checks. Do not claim historic child-copy/lineage semantics that the official gateway cannot prove. Do not adopt prospective MCP support as if it were production-ready.

## What Parker should keep from his own implementation

Maria’s breadth and Ben’s transport do not obsolete Parker’s strongest work:

1. **Conversation identity policy.** Keep explicit ownership, child-copy isolation where supported, completed-run fork boundaries, reopen/import-another behavior, and visible lineage.
2. **Hermes-authoritative title policy.** Reuse Maria’s durable tables, but retain Parker’s clear rule that T3 projects Hermes titles and reconciles rather than competing with them.
3. **Voice.** Parker is materially ahead; port the entire vertical slice, including stable attachment IDs, draft recovery, playback, Hermes STT and transcription states.
4. **Command/skill UX.** Keep searchable discovery, aliases, plugin skills, keyboard navigation, ghost hints and lifecycle-command interception.
5. **Durable idempotency and completion outbox.** A live WebSocket or persisted proactive-event table is not by itself an exactly-once delivery strategy. Preserve admission claims, stable delivery IDs, retry state and receipts.
6. **Focused conversation presentation.** Maria validates the Code/Work split, but Parker’s detailed conversation UX remains a valuable reference for what Work should feel like.

## Recommended implementation plan for Parker

1. **Rebase the target architecture on orchestration v2 and introduce Code/Work as a product concept.** Treat Maria’s PR as a design source, not a merge blob.
2. **Define one capability-negotiated Hermes domain contract** for instance identity, durable stored session identity versus ephemeral live session identity, titles, imports, lineage, models/reasoning, attachments, voice, cron, proactive delivery, and MCP delegation.
3. **Choose transport by deployment mode.** Use the official local `hermes serve` client where T3 owns/co-locates the runtime. Add Ben-style outbound enrollment for remote/self-hosted Hermes rather than relaxing Maria’s remote security gates.
4. **Split the integration before adding more features:** gateway transport; connection/enrollment; session repository; lifecycle/import; inventory/commands/models; media/voice; proactive delivery. Keep Effect I/O shells small and pure state transitions independently tested.
5. **Land session identity and persistence first.** Reconcile Maria’s honest lazy import with Parker’s child-copy/fork rules; expose capability limitations rather than simulating safety.
6. **Land basic Work UX on web and mobile**, then titles, commands, model/reasoning, and general files.
7. **Add cron/proactive delivery using both durable repository state and Parker’s outbox/idempotency.**
8. **Port Parker’s voice vertical slice.**
9. **Add scoped Hermes-to-T3 coding delegation only after real gateway conformance.**
10. **Break the work into reviewable PRs with focused gates.** Maria’s branch proves the integrated vision, but its single-commit scale should not be copied.

The short version is: **use Maria as the destination architecture, Ben as the remote connection specialist, and Parker as the source of truth for Hermes conversation semantics and UX.** If forced to select one existing branch as a merge base today, Maria’s branch is structurally closest to the desired unified product, but it carries the highest review and integration risk. A staged port onto orchestration v2 is safer than choosing any branch wholesale.

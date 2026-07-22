# T3 Code as a Hermes gateway channel

Research snapshot: T3 Code commit [`9a0a07167f0623c3a7db0ffeff2e3939760309df`](https://github.com/pingdotgg/t3code/tree/9a0a07167f0623c3a7db0ffeff2e3939760309df) and Hermes Agent commit [`e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f`](https://github.com/NousResearch/hermes-agent/tree/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f), inspected 2026-07-22.

## Corrected conclusion

Yes. T3 Code can be a real Hermes gateway surface in the same sense that Discord is, without replacing the Hermes CLI and without making T3 own the agent loop.

The right integration is **not** “T3 launches `hermes acp` as another coding provider.” It is:

```text
T3 web / desktop / mobile
          |
      T3 server
          |
 authenticated local bridge
          |
 Hermes `t3` platform adapter
          |
   Hermes GatewayRunner
          |
 AIAgent + sessions + tools + cron
```

Hermes remains the source of truth for agent execution, conversation memory, gateway session state, background work, and schedules. T3 becomes another bidirectional channel: it submits normalized inbound messages and renders outbound messages, edits, tool activity, approvals, clarifications, asynchronous completions, and cron deliveries.

This is a materially different architecture from the ACP-provider approach:

| Concern | ACP provider integration | Gateway/channel integration |
|---|---|---|
| Agent owner | T3 starts an ACP subprocess per provider lifecycle | The long-running Hermes gateway owns the agent |
| Hermes CLI/gateway continuity | Separate surface/session path | Same Hermes state, tools, cron, memory, and gateway behavior |
| Proactive delivery | Not inherent | Native platform-adapter responsibility |
| Cron | Must be recreated or separately imported | Existing Hermes scheduler delivers to `t3` |
| Correct fit for this goal | No | Yes |

## Why this fits Hermes' existing architecture

Hermes' gateway is explicitly a long-running multiplexer around platform adapters. Inbound platform events are normalized to `MessageEvent`, keyed into a gateway session, authorized, sent through `AIAgent`, and returned through the same adapter. The runner already handles busy-session queueing, interruption, slash commands, sessions, background tasks, and outbound routing. [Hermes gateway internals](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/gateway-internals.md#L9-L88)

Hermes also explicitly supports third-party platform plugins without core changes. A plugin extends `BasePlatformAdapter`, implements connection and send operations, and feeds inbound events to `self.handle_message(event)`. Registration automatically participates in gateway creation, configuration, authorization, cron targeting, the `send_message` engine, channel discovery, and platform-specific system-prompt hints. [Adding a platform adapter](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/adding-platform-adapters.md#L7-L39), [automatic integration points](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/adding-platform-adapters.md#L174-L199)

Discord is itself implemented at this seam: its `DiscordAdapter` subclasses `BasePlatformAdapter`, owns the Discord connection and send implementation, normalizes inbound Discord events, and sends them through the common gateway path. T3 would replace the Discord SDK transport with the local T3 bridge while keeping that ownership model. [Discord adapter class and connection](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/plugins/platforms/discord/adapter.py#L821-L1065), [Discord send implementation](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/plugins/platforms/discord/adapter.py#L2818-L2905), [Discord inbound normalization](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/plugins/platforms/discord/adapter.py#L7061-L7150)

The normalized source model is already thread-aware. `build_session_key()` deterministically keys DMs, groups, channels, and threads, with threaded conversations shared between participants by default. A T3 mapping can therefore use `chat_id = projectId` and `thread_id = t3ThreadId`, yielding one durable Hermes gateway session per T3 thread. [Hermes session-key implementation](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/session.py#L918-L1006)

## Smallest same-machine architecture

Run two long-lived processes under one service supervisor:

1. The T3 fork's normal Node server, still serving its web/mobile protocol and owning T3's projection database.
2. `hermes gateway run`, using the user's normal `HERMES_HOME`, model/auth configuration, session database, memory, skills, tools, and cron jobs.

Install a Hermes user plugin at `$HERMES_HOME/plugins/t3/` containing `plugin.yaml` and a `T3PlatformAdapter`. The adapter should make an outbound persistent connection to a private T3 bridge endpoint. On Unix, a filesystem-permissioned Unix-domain socket is the cleanest same-machine transport; authenticated loopback WebSocket is the portable alternative.

The processes should not share database tables. They should exchange an explicit, versioned envelope protocol and each retain its own responsibilities:

- Hermes `state.db` and `HERMES_HOME`: canonical agent transcript, gateway session routing, delivery obligations, and Hermes-owned memory artifacts.
- Hermes cron store: canonical schedules and run status.
- T3 SQLite: canonical UI thread/message/activity projection.
- A small bridge binding table: `(Hermes profile, gateway session key) <-> (T3 project id, T3 thread id)` plus acknowledged transport sequence numbers.

### Hermes-side adapter

The adapter's minimum useful surface is:

- `connect` / `disconnect`: maintain the local bridge and replay unacknowledged frames after reconnect.
- inbound `message`: construct `MessageEvent`/`SessionSource`, then call `handle_message()`.
- `send` / `edit_message` / `delete_message`: create and update T3 assistant messages. Hermes' streaming consumer already streams by sending an initial platform message and progressively editing it. [Gateway stream consumer](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/stream_consumer.py#L1-L13), [stream consumer send/edit contract](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/stream_consumer.py#L83-L96)
- `send_typing` and processing lifecycle hooks: drive T3's running/settled/attention state.
- `send_exec_approval` and `send_clarify`: publish structured requests into T3 and resolve the gateway's existing blocking primitives when T3 sends the answer. The base adapter already defines text fallbacks, while richer adapters can override them. [Base clarify contract](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/platforms/base.py#L3262-L3317), [platform interactive UX contract](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/platforms/ADDING_A_PLATFORM.md#L113-L125)
- `create_handoff_thread`: ask the T3 server to allocate a thread and return its ID, enabling Hermes handoffs and thread-preferred continuable cron behavior.
- `cron_deliver_env_var="T3_HOME_CHANNEL"`: make `deliver=t3` a normal Hermes delivery target.
- `standalone_sender_fn`: allow a separately invoked `hermes cron run` or `hermes send` process to deliver even when it cannot reach the live adapter object. Hermes documents this exact plugin hook. [Cron delivery plugin hooks](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/adding-platform-adapters.md#L283-L326)

The adapter is not an alternate agent implementation. Its `send()` is analogous to Discord's API send; its inbound listener is analogous to Discord's event listener.

### T3-side bridge

T3 already has most of the UI vocabulary needed: thread creation/turn commands, assistant streaming deltas, activities, approval responses, structured user-input responses, and live projection streams. [T3 orchestration commands](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/orchestration.ts#L536-L716), [T3 internal assistant/activity commands](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/orchestration.ts#L764-L819)

However, its public HTTP/WebSocket orchestration ingress accepts **client commands**, not arbitrary provider/runtime events. A proactive Hermes delivery has no client-originated `thread.turn.start`, so the fork needs a trusted server-side `HermesGatewayBridge` that can:

- create or locate a T3 project/thread for an inbound Hermes destination;
- append assistant message deltas/completions and activities directly through the orchestration engine;
- create and resolve approval/user-input records;
- expose thread messages, interrupts, and responses to the Hermes adapter;
- do this idempotently using Hermes delivery/frame IDs.

T3's existing authenticated orchestration HTTP endpoint is useful precedent, but calling its current `thread.turn.start` endpoint from Hermes would be wrong: that asks T3's provider reactor to start an agent turn. [T3 orchestration HTTP handler](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/orchestration/http.ts#L14-L93), [HTTP contract](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/environmentHttp.ts#L470-L491)

It is still useful to represent the bridge as a special T3 provider driver internally, because T3's existing provider adapter interface already has `sendTurn`, `interruptTurn`, approval and user-input responses, session lifecycle, and a canonical runtime event stream. The important distinction is that this driver is a **channel bridge to the existing GatewayRunner**, not an ACP launcher and not the owner of the Hermes session. [T3 provider-adapter interface](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Services/ProviderAdapter.ts#L1-L100)

## End-to-end flows

### User starts or continues a T3 thread

1. T3 persists the user's message and hands the turn to the Hermes gateway bridge driver.
2. The driver sends an idempotent inbound envelope containing project/thread/message IDs, author, attachments, and the validated workspace path.
3. `T3PlatformAdapter` constructs a `MessageEvent` with `platform=t3`, `chat_id=projectId`, `chat_type=thread`, and `thread_id=t3ThreadId`, then calls `handle_message()`.
4. Hermes resolves or creates its normal gateway session and runs the normal `AIAgent` path.
5. Hermes calls the adapter's send/edit/approval methods; the bridge converts those calls into T3 orchestration events, so every connected web/mobile client observes them normally.

This preserves Hermes slash commands, busy-message behavior, interruption, memory, model routing, skills, terminal/background completion behavior, and session resume because the turn really went through `GatewayRunner`, not around it.

### Cron delivery

Hermes cron already runs inside gateway mode on a background scheduler, creates its own fresh agent session, executes the job, and routes the result to any configured platform. The built-in scheduler ticks every 60 seconds by default; trigger selection is pluggable, but execution and delivery remain in `run_job()` and `_deliver_result()`. [Hermes cron runtime](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/cron-internals.md#L79-L130)

For the T3 adapter:

- `deliver=t3` resolves to `T3_HOME_CHANNEL`, which should mean a configured T3 project/inbox.
- `deliver=t3:<projectId>:<threadId>` targets an existing T3 thread.
- `deliver=origin` on a job created from a T3 thread returns to that same thread.
- A non-continuable job can create a fresh T3 result thread or append to a stable Cron Inbox; this is presentation policy in the adapter/T3 bridge.
- With `attach_to_session`/`cron.mirror_delivery` enabled, Hermes' existing continuable-cron path mirrors the clean result into the destination gateway session. Its thread-preferred implementation can ask an adapter to create a dedicated thread and seed that thread's Hermes session, so a later reply continues with the cron result in context. [Continuable cron behavior](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/user-guide/features/cron.md#L315-L346), [thread creation and session seeding](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L759-L870)

Hermes deliberately does not mirror ordinary cron deliveries into a target conversation by default, so the T3 UI should label fire-and-forget cron threads as cron output rather than imply that Hermes will remember them. [Cron delivery/mirroring policy](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L1445-L1521)

### Proactive and background output

`BasePlatformAdapter.supports_async_delivery` defaults to true specifically for persistent adapters such as Discord and Slack. Hermes uses that capability for terminal completion notifications and detached subagent results after the original turn has ended. A T3 adapter with a persistent local bridge therefore fits the existing asynchronous-delivery contract. [Hermes async-delivery capability](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/platforms/base.py#L2366-L2380)

Hermes also routes the `send_message` engine, cross-platform sends, startup notices, and home-channel delivery through adapters. Those can all become T3 thread activity once `t3` is registered. [Hermes delivery paths](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/website/docs/developer-guide/gateway-internals.md#L190-L199)

### Approvals and clarification

The T3 UI's existing `thread.approval.respond` and `thread.user-input.respond` commands can be reused. [T3 response commands](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/orchestration.ts#L684-L704)

The gateway bridge driver translates those responses into the pending Hermes gateway primitive:

- execution approval -> `resolve_gateway_approval(session_key, decision)`;
- structured clarification -> `resolve_gateway_clarify(clarify_id, answer)`;
- interrupt -> adapter/gateway interruption for the mapped session.

This is more complete than ACP for this use case because it uses the gateway's own approval and clarify flow. The pinned gateway adapter surface does not expose equivalent structured callbacks for sudo-password or secret capture, so those should remain unsupported/denied in the first version rather than being sent as ordinary chat text.

## Delivery guarantees and restart behavior

Hermes already maintains a durable delivery-obligation ledger for final gateway responses. It records before sending, marks confirmed deliveries, and on restart redelivers abandoned `pending`/`attempting`/`failed` rows with explicit at-least-once semantics. [Hermes delivery ledger](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/delivery_ledger.py#L1-L37), [recovery claim logic](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/delivery_ledger.py#L203-L273)

Hermes also marks interrupted gateway sessions `resume_pending` while preserving their session ID and transcript. [Hermes resume-pending state](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/session.py#L2248-L2295)

The T3 bridge still needs a small replay protocol because a local socket can fail between the two durable systems:

- every inbound and outbound frame has a stable ID and monotonic sequence;
- receiver persists before ACK;
- reconnect advertises the last contiguous ACK and replays the tail;
- T3 message IDs and Hermes obligation IDs are idempotency keys;
- streaming previews may be reconstructed from T3's latest persisted projection; only final content needs Hermes' durable delivery ledger semantics.

Discord has to scan platform history because Discord does not replay messages sent while the bot was offline. A purpose-built T3 bridge can be simpler and stronger: T3 already persists commands/events, so it can replay the exact unacknowledged sequence rather than heuristically scanning recent messages. Discord's backfill implementation is useful evidence for the failure mode, not the protocol to copy. [Discord missed-message recovery](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/plugins/platforms/discord/adapter.py#L1989-L2117)

## Important gaps to build deliberately

### 1. Per-thread project working directory

This is the largest functional gap.

T3 threads are project/worktree scoped, but Hermes gateway sessions currently derive their runtime working directory from global gateway configuration. `SessionSource` and `SessionContext` carry platform/chat/thread identity but no cwd, and `GatewayRunner._set_session_env()` does not pass a cwd even though the lower-level task-local session context supports one. [Session source/context](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/session.py#L178-L331), [gateway context binding](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/run.py#L16723-L16754), [task-local cwd support](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/session_context.py#L157-L214)

The integration needs a small Hermes patch or upstream extension: add a trusted, non-user-editable workspace/cwd field resolved by the T3 adapter, validate it against configured allowed workspace roots, persist the binding, then pass it as `cwd=` to `set_session_vars()`. Setting process-global `TERMINAL_CWD` from the plugin is not safe because gateway sessions run concurrently.

### 2. Proactive T3 ingress

T3 presently assumes thread activity follows client commands and provider sessions. The fork needs a server-only ingestion boundary for Hermes to create/update a thread without fabricating a user turn. This is essential for cron, detached completions, startup notices, and agent-initiated `send_message` deliveries.

### 3. Project choice for global deliveries

Every T3 thread belongs to a project. A bare `deliver=t3` has no natural repository. The smallest policy is a configured synthetic “Hermes Inbox” project rooted at an allowlisted directory; users can instead choose a real default project. Do not silently attach global cron results to whichever repository was opened most recently.

### 4. Rich tool cards

Hermes now defines structured presentation events such as `MessageChunk`, `ToolCallChunk`, and `ToolCallFinished`, but the generic dispatcher renders tool starts into platform text and intentionally drops tool-finished chrome; tool output is not part of the presentation event. [Hermes structured stream events](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/stream_events.py#L1-L121), [dispatcher behavior](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/stream_dispatch.py#L83-L127)

The first gateway version can render Discord-quality text/edit progress. Native T3 tool cards with completion state and result previews require widening the optional platform-adapter presentation seam so `T3PlatformAdapter` receives structured events before they are flattened.

### 5. Mobile background notification

A live mobile connection will see proactive threads through normal T3 projection streaming. When iOS suspends the app, receiving a cron alert requires T3's existing relay/APNs activity-publishing stack or a replacement push service; a same-machine direct socket alone cannot wake the app. This is a distribution/notification concern, not a Hermes gateway limitation. [T3 relay contract and notification scope](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/relay.ts#L200-L265), [T3 APNs client](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/infra/relay/src/agentActivity/ApnsClient.ts)

### 6. The existing experimental Hermes relay is not the best first seam

Hermes has an experimental generic connector WebSocket contract with inbound replay and outbound actions. It is architecturally similar to the proposed bridge, but the pinned relay adapter is designed for remotely fronted messaging platforms and its contract is explicitly experimental. Its current adapter implements normal send/follow-up but not the full edit, structured approval/clarify, and thread-creation behavior this T3 surface needs. [Hermes relay contract status and shape](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/docs/relay-connector-contract.md#L1-L41), [relay adapter send surface](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/relay/adapter.py#L491-L563)

A standalone `t3` plugin plus a small local protocol is therefore the lower-risk first implementation. The protocol can later converge with Hermes relay primitives if that contract becomes stable and gains the missing operations.

## Suggested delivery plan

### Spike: prove gateway semantics, not ACP semantics (3–5 days)

- Build a minimal Hermes `t3` platform plugin and local bridge.
- Map one T3 project/thread to one Hermes gateway session.
- Verify a real user turn, streaming edit, tool progress, interrupt, approval, clarify, asynchronous terminal completion, process restart, and one cron delivery.
- Prove that a cron-created T3 thread can be replied to with the intended Hermes context.
- Prototype the task-local cwd extension and validate it with two simultaneous threads in different repositories.

### Local product MVP (approximately 3–5 weeks)

- Durable frame ACK/replay and binding table.
- T3 proactive orchestration ingress and Hermes gateway bridge driver.
- Full adapter operations, attachments, thread creation, and cron target configuration.
- Project/worktree cwd patch with allowlist validation.
- Existing T3 approvals/clarification UI wired to Hermes resolvers.
- Web/desktop first; mobile foreground connectivity follows the shared T3 state model.

### Product-quality follow-up

- Native structured tool cards and richer Hermes status events.
- Push notification infrastructure for mobile cron/background deliveries.
- Multi-profile routing, reconnect telemetry, dead-letter UI, and operator controls for cron destinations.
- Package the Hermes plugin separately where possible so the T3 fork carries the UI/server bridge while Hermes core changes stay limited to cwd and optional structured-presentation hooks.

## Bottom line

The idea is not only possible; Hermes already exposes the correct category of extension. The fork should treat T3 as a **first-class Hermes messaging platform with a richer thread UI**, while leaving `hermes chat`, `hermes gateway`, Hermes sessions, cron, tools, memory, and background execution intact.

The unavoidable work is mostly at the boundary: a Hermes platform plugin, a durable local bridge, T3's proactive event ingress, project/thread/session mapping, and a safe per-thread cwd binding. ACP is useful for an editor-provider integration, but it is not the architecture for this gateway product.

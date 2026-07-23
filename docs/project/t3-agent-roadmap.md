# T3 Agent roadmap

This roadmap translates the current product design into delivery phases. It intentionally prioritizes a coherent web/desktop Hermes surface before adapting the separate native mobile UI.

## Foundation: local Hermes gateway

Implemented on the T3 Agent feature branch:

- [x] Attach to an independently running Hermes gateway on the same machine.
- [x] Add the authenticated Hermes platform plugin and T3 provider bridge.
- [x] Create and continue Hermes conversations through T3 threads.
- [x] Stream replies and expose turn completion.
- [x] Interrupt active work.
- [x] Resolve approvals, clarifications, and slash confirmations.
- [x] Discover Hermes commands, aliases, skills, and plugin commands.
- [x] Deliver images in both directions.
- [x] Accept proactive/background delivery.
- [x] Recover bridge state across reconnects and process restarts.
- [x] Add the initial web T3 Agent product shell and hide most project/coding controls.

## Phase 1: complete the web/desktop agent surface

### Hermes-native controls

- [x] Replace the Pi placeholder with a real Hermes glyph.
- [x] Show the effective Hermes model.
- [x] Add a prominent per-thread reasoning selector, using T3 Code's polished compact interaction, with inherited `Default` and every Hermes-supported effort level.
- [x] Add provider-aware per-thread model switching that shows every model reported by Hermes, grouped by authenticated provider.
- [x] Retain T3 Code's fuzzy search, provider navigation, favorites, virtualization, and keyboard-selection behavior in the model picker.
- [x] Initialize every new thread from Hermes's configured model and reasoning defaults rather than sticky values from another thread.
- [ ] Later, add an explicit user preference for overriding new-thread defaults.
- [ ] Render quiet timeline metadata when a thread's model or reasoning effort changes.
- [x] Keep expensive-model confirmations and provider-specific validation Hermes-owned.

### Commands and conversation lifecycle

- [x] Render command argument hints as non-message gray ghost text.
- [x] Add the completed-run fork icon beside copy/timestamp controls.
- [x] Add a bridge primitive that forks Hermes history through a completed run without rebinding the source thread.
- [x] Make `/fork` use that primitive at the latest completed run.
- [x] Give `/new`, `/sessions`, and `/resume` T3-native navigation semantics.
- [x] Make `/sessions` and `/resume` open the same subtly grouped browser of T3 Agent and other Hermes sessions.
- [x] Navigate directly to an existing thread when a T3 Agent session is selected.
- [x] Immediately import and open a selected cross-gateway session as a child session and new T3 Agent thread, without a preview or confirmation and without changing the source.
- [x] Reopen the existing T3 Agent copy when its external source is selected again, with a secondary “Import another copy” action.
- [x] Add a subtle timeline lineage marker at the boundary between inherited history and new messages.
- [x] Label imports “Imported from [provider]” and forks “Continued from [source thread].”
- [x] Link fork lineage markers back to the original T3 Agent thread.
- [ ] Link imported-session markers to their external source when a stable address is available.
- [x] Preserve lineage as non-clickable history when its source is deleted or inaccessible.

### Voice notes

- [ ] Add a voice-attachment contract and non-base64 upload path sized to Hermes's real 25 MiB STT ceiling.
- [ ] Add the web recording bar with elapsed time, waveform, pause/resume, cancel, stop, and send.
- [ ] Make Stop enter a replayable voice-draft state with discard and send controls.
- [ ] Make Send finalize and submit an active recording immediately without requiring preview.
- [ ] Preserve the browser-selected WebM/Opus or MP4/AAC MIME type.
- [ ] Mark recordings as voice notes and deliver them to Hermes's existing STT flow.
- [ ] Keep STT providers, transcription, and agent-input enrichment entirely Hermes-owned.
- [ ] Add semantic Hermes integration metadata that tags the existing transcript echo and its source voice message.
- [ ] Render the playable voice bubble immediately without inventing a local transcription-progress state.
- [ ] Expand short transcripts by default and collapse long transcripts.
- [ ] Leave transcript echoes as ordinary Hermes messages when semantic transcript metadata is unavailable.
- [ ] Do not add a retry control unless Hermes exposes a real retry operation.
- [ ] Avoid an arbitrary duration cap; enforce Hermes's actual 25 MiB file limit.
- [ ] Keep outbound Hermes TTS as a separate follow-up.

### Interaction polish

- [ ] Present Hermes approvals and clarifications inline at their pause point.
- [ ] Keep unresolved requests represented by a compact composer-level indicator that returns to the inline card.
- [ ] Preserve ordinary T3 rich rendering rather than copying Discord formatting.
- [ ] Fix gateway-parity gaps as real workflows expose them; do not block higher-value product work on a speculative exhaustive parity suite.

## Phase 2: native mobile T3 Agent

By code inspection, the current mobile client should be able to connect to the same T3 server and reuse its thread, provider, command, image, approval, clarification, and projection infrastructure. That compatibility has not yet been verified on a device in this fork, and it is not yet a T3 Agent product: its UI still assumes repositories and coding tasks.

### Product identity and navigation

- [ ] Rename the existing mobile app in this fork to T3 Agent.
- [ ] Replace its name, Hermes assets, bundle/application identifiers, URL scheme, permission copy, widgets, shortcuts, and notification branding.
- [ ] Remove the need for a parallel T3 Code product mode; upstream T3 Code remains a separate checkout.
- [ ] Replace project-grouped navigation with a flat Hermes conversation list.
- [ ] Filter the surface to Hermes-backed threads.
- [ ] Make New Conversation silently use the compatibility project and Hermes provider.
- [ ] Remove project selection from the user-facing flow.

### Thread surface

- [ ] Replace coding-task and repo-agent language with Hermes conversation language.
- [ ] Hide branch, worktree, diff, pull-request, terminal, file-browser, project-script, runtime-access, and repository controls.
- [ ] Add the effective model and per-thread reasoning selector.
- [ ] Add command ghost hints and lifecycle-command navigation.
- [ ] Add the completed-run fork action.
- [ ] Adapt inline approval, denial, clarification, and slash-confirmation cards.
- [ ] Preserve inline image attachments and Hermes rich message rendering.

### Mobile voice notes

- [ ] Add the Expo SDK-matched `expo-audio` dependency and native config plugin.
- [ ] Add microphone permission onboarding and denial recovery.
- [ ] Enable required iOS background recording.
- [ ] Enable the Android foreground microphone service and persistent recording notification.
- [ ] Implement tap-to-record, elapsed time, live metering waveform, pause/resume, cancel, stop, and immediate send.
- [ ] Add the replayable stopped-recording draft state with discard and send controls.
- [ ] Record M4A/AAC and upload it through the shared voice contract.
- [ ] Preserve an interrupted/background recording as a recoverable draft where the platform permits.
- [ ] Add native voice playback and expandable linked transcripts.
- [ ] Verify behavior on a physical device because simulator microphone behavior is not representative.

### Mobile completion delivery

- [ ] Adapt Live Activity/widget copy and state to T3 Agent.
- [ ] Register the T3 Agent app with the operator-owned relay/APNs configuration.
- [ ] Deliver ordinary-turn, background-agent, and cron completion notifications into the correct conversation.
- [ ] Suppress notifications only while the app reliably reports active foreground use.
- [ ] Prefer notifying when foreground or connection state is uncertain.
- [ ] Deep-link notification taps to the target T3 Agent thread.

## Phase 3: owned remote access and notifications

- [ ] Deploy an operator-owned T3 Connect stack.
- [ ] Point web and mobile builds at the owned relay, Clerk, DNS, observability, and APNs configuration.
- [ ] Use managed Connect endpoints for the primary remote product path.
- [ ] Retain Tailscale/direct pairing as a development or private fallback.
- [ ] Support `publish_only` mode when Tailscale carries traffic and the relay supplies notifications.
- [ ] Add delivery diagnostics and dead-letter visibility for failed proactive work.

## Later capabilities

- [ ] Add outbound TTS and richer audio responses.
- [ ] Inherit or adapt T3 Code's background-agent visualizer when it lands upstream.
- [ ] Add configurable cron destination policies, including persistent per-job delivery threads.
- [ ] Reintroduce selected coding, project, or Hermes-machine management capabilities only where they improve the agent surface.
- [ ] Adapt Sidebar V2 or future upstream thread UX when it materially improves T3 Agent.

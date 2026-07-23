# Hermes voice-note ingestion and transcription

Research snapshot: locally installed Hermes Agent v0.19.0 at upstream commit
[`fb0ed8396c1c598e3c116f41eea476ce18aa2dd3`](https://github.com/NousResearch/hermes-agent/tree/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3),
inspected 2026-07-23. Findings below come from that source and the current T3
bridge implementation, not inferred UI behavior.

## Conclusion

Hermes does own voice-note transcription, but its gateway contract is less rich
than a dedicated voice-upload API:

- A platform adapter downloads/caches the audio, then gives `GatewayRunner` a
  normal `MessageEvent` containing local file paths, per-file MIME types, and
  normally `message_type=VOICE`. `GatewayRunner` transcribes eligible audio
  before starting the agent turn and inserts the transcript into the text prompt.
  [`MessageEvent` media fields](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/platforms/base.py#L1758-L1788),
  [STT eligibility](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L2230-L2246),
  [pre-agent transcription](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L11586-L11670)
- On success, Hermes can echo `🎙️ "transcript"` through the adapter as an
  ordinary outgoing chat message. This is enabled by default but configurable;
  it is not a structured `transcript.complete` event and carries no
  voice-attachment identity. [`stt_echo_transcripts` default](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/config.py#L865-L867),
  [echo implementation](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L11666-L11689)
- On failure, Hermes logs the provider error and gives the agent the neutral
  marker `[voice message could not be transcribed]`. It deliberately sends no
  hardcoded failure message to the platform. Therefore a client cannot reliably
  render “transcription failed” from current callbacks. [success/failure
  enrichment](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L16644-L16688),
  [failure-send removal](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L11690-L11698)
- There is no gateway-facing STT retry primitive. A pending event is explicitly
  transcribed once and cached so interrupt/drain paths do not call STT twice.
  The only source-level retries are implementation details: media URL download
  retries transient failures twice, and local faster-whisper retries once on a
  narrowly detected CUDA-library failure by reloading on CPU. Neither is a UI
  action. [`_transcribe_pending_audio_event_once`](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L16699-L16727),
  [download retry](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/platforms/base.py#L853-L913),
  [CUDA fallback](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/tools/transcription_tools.py#L1160-L1189)

## What the gateway actually passes

Telegram illustrates the native voice-note path: it downloads `msg.voice`,
caches it as `.ogg`, and records `audio/ogg`; a normal Telegram audio file is
instead cached as `.mp3` and classified as `AUDIO`. [Telegram voice/audio
ingestion](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/plugins/platforms/telegram/adapter.py#L8450-L8484)
Discord similarly distinguishes native voice attachments (`VOICE`) from regular
audio files (`AUDIO`) and caches their bytes before constructing the event.
[Discord classification](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/plugins/platforms/discord/adapter.py#L7213-L7242),
[Discord audio caching](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/plugins/platforms/discord/adapter.py#L7287-L7321)

The distinction matters: automatic STT excludes message-level `AUDIO` and
`DOCUMENT`, while `VOICE` or an eligible non-`AUDIO` event with an `audio/*`
per-file MIME enters STT. Regular audio attachments are exposed to the agent as
files for optional tool use instead. [STT routing
predicate](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L2238-L2246),
[regular-audio handling](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L11603-L11608),
[agent file note](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L11700-L11717)

Transcription itself runs inside `GatewayRunner`, before `AIAgent`, using
`asyncio.to_thread(transcribe_audio, path)`. `transcribe_audio` selects the
configured built-in/plugin provider and returns a private
`{success, transcript, error?, provider?}` result envelope; that envelope is not
forwarded to the platform. [runner call](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/run.py#L16644-L16676),
[dispatcher contract and selection](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/tools/transcription_tools.py#L1712-L1789)

## T3 bridge implications

The current T3 Hermes plugin does **not** accept voice notes. Its message route
accepts `content` plus an `images` array, creates `MessageType.TEXT`, and
advertises `imageAttachments` but no audio/voice capability. [current ingress
shape](../../integrations/hermes/t3agent/adapter.py#L851-L900),
[current capabilities](../../integrations/hermes/t3agent/adapter.py#L835-L845)

Once audio ingress is added and normalized to a voice `MessageEvent`, transcript
success reaches T3 only through the plugin's generic `message.send` callback,
because every `adapter.send(...)` becomes `message.send`. There is no transcript
callback in the current tagged union. [generic send
mapping](../../integrations/hermes/t3agent/adapter.py#L1095-L1143),
[callback catalog](../../integrations/hermes/t3agent/README.md#L112-L118)
Consequently:

- The UI can keep the original audio playable from T3-owned attachment state.
- It may display Hermes' successful transcript echo as a separate ordinary
  message, but must not guess that it belongs to the preceding voice note.
- Accurate per-bubble `transcribing / transcribed / failed / retry` state needs
  a new, correlated Hermes-to-T3 bridge event (and a retry ingress operation if
  retry is desired). It is not available from the built-in gateway flow today.
- `turn.complete` is not evidence of transcription success; the agent can
  receive the neutral failure marker and still complete its turn normally.

## Formats and limits

Hermes' shared STT validator accepts these filename extensions:
`.aac`, `.flac`, `.m4a`, `.mp3`, `.mp4`, `.mpeg`, `.mpga`, `.ogg`, `.wav`, and
`.webm`. It rejects files larger than **25 MiB** before provider dispatch.
There is no shared duration limit. [format and size
constants](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/tools/transcription_tools.py#L90-L106),
[validation](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/tools/transcription_tools.py#L1041-L1068)

The gateway's earlier general media-cache guard defaults to **128 MiB** and is
configurable with `gateway.max_inbound_media_bytes`, but voice notes still hit
the stricter 25 MiB STT validation afterward. [gateway media
cap](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/platforms/base.py#L589-L646)
The current T3 plugin additionally caps its entire HTTP request body at
**16 MiB** and has no audio schema, so that body limit would need deliberate
revision for inline/base64 voice uploads. [T3 ingress
constants](../../integrations/hermes/t3agent/adapter.py#L55-L61)

One edge case is worth preserving in the client recorder choice: `.opus` is
recognized by the generic media cache but is **not** in the shared STT
allowlist. Prefer a supported container/extension such as WebM, Ogg, M4A, WAV,
or MP3 rather than uploading a bare `.opus` file. [cache audio
extensions](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/gateway/platforms/base.py#L1715-L1719),
[STT allowlist](https://github.com/NousResearch/hermes-agent/blob/fb0ed8396c1c598e3c116f41eea476ce18aa2dd3/tools/transcription_tools.py#L104-L106)

Product policy should therefore impose no invented time limit. Enforce the
actual byte limits, choose one of Hermes' accepted containers, and surface
recording/upload failures locally. Hermes-owned transcription outcome and retry
cannot be represented faithfully until the bridge protocol gains explicit,
attachment-correlated events.

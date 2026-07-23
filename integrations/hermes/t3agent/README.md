# T3 Agent Hermes platform plugin

This directory is the Hermes-native half of the T3 Agent gateway. Hermes stays
Hermes: it owns conversations, models, tools, cron jobs, approvals, and async
work. The T3 fork is a thread-native client and durable delivery surface.

The plugin starts a bearer-authenticated HTTP server on loopback and translates
T3 requests into normal Hermes `MessageEvent` objects. In the other direction,
it posts a versioned tagged union to the T3 server. It does not invoke the
Hermes CLI or create a second agent runtime.

## Install

The plugin needs Hermes' `messaging` extra because both directions use
`aiohttp`. Copy or symlink this directory into the Hermes plugin directory:

```bash
mkdir -p ~/.hermes/plugins
ln -s /absolute/path/to/t3agent/integrations/hermes/t3agent \
  ~/.hermes/plugins/t3agent-platform
hermes plugins enable t3agent-platform
```

Set four required values in `~/.hermes/.env` (generate the two tokens
independently with a cryptographically secure secret generator):

```dotenv
T3_AGENT_INSTANCE_ID=hermes
T3_AGENT_BRIDGE_URL=http://127.0.0.1:3000
T3_AGENT_INGRESS_TOKEN=<t3-to-hermes-secret>
T3_AGENT_BRIDGE_TOKEN=<hermes-to-t3-secret>
```

Hermes stores a bounded ingress idempotency ledger and a turn-completion
outbox under its state directory. Override their locations with
`T3_AGENT_INGRESS_LEDGER_PATH` and `T3_AGENT_OUTBOX_PATH` when the Hermes state
directory is not persistent.

In T3 Agent settings, open the Hermes provider and set:

- **Hermes bridge URL** to the plugin ingress (normally
  `http://127.0.0.1:8789`).
- **Hermes ingress token** to `T3_AGENT_INGRESS_TOKEN`.
- **T3 callback token** to `T3_AGENT_BRIDGE_TOKEN`.

`T3_AGENT_INSTANCE_ID` must match the T3 provider instance ID. The built-in
single-instance provider uses `hermes`; use another value only after creating a
matching explicit provider instance.

The ingress defaults to `127.0.0.1:8789`. A non-loopback bind is rejected. If
T3 and Hermes run on different machines, keep this plugin loopback-only and put
an authenticated tunnel or a small local forwarder next to Hermes; do not bind
the raw ingress to a LAN or public interface.

For cron delivery, configure a durable T3 thread:

```dotenv
T3_AGENT_HOME_CHAT=t3agent
T3_AGENT_HOME_CHAT_THREAD_ID=<thread-id>
T3_AGENT_HOME_CHAT_NAME=Hermes Inbox
```

Then use `deliver=t3agent`. Hermes registers `T3_AGENT_HOME_CHAT` as the
platform's cron destination and, by its standard convention, reads the thread
from `T3_AGENT_HOME_CHAT_THREAD_ID`. The chat value is deliberately fixed to
`t3agent`, matching interactive messages so replies continue the Hermes session
seeded by the cron run. It uses the standalone sender when the cron process is
separate from the gateway process. A cron callback is an ordinary
`message.send` event with `final: true`.

Restart the Hermes gateway after installing or changing configuration. Verify
the private ingress with:

```bash
curl -H "Authorization: Bearer $T3_AGENT_INGRESS_TOKEN" \
  http://127.0.0.1:8789/v1/health
```

## Wire protocol

Every request is authenticated exclusively with
`Authorization: Bearer <token>`. Tokens never appear in JSON. Every frame has
`protocolVersion: 1` and `requestId`; callbacks also have `deliveryId` and a
`type` tag. Hermes sends callbacks to:

```text
POST {T3_AGENT_BRIDGE_URL}/api/hermes/{T3_AGENT_INSTANCE_ID}/events
```

It also sends `Idempotency-Key: <requestId>`. T3 should return a JSON object on
every 2xx response. Message callbacks may return `messageId`; `thread.create`
returns `threadId`.

Ingress routes and tags:

| Route                          | `type`                       |
| ------------------------------ | ---------------------------- |
| `POST /v1/messages`            | `message.submit`             |
| `POST /v1/interrupt`           | `turn.interrupt`             |
| `POST /v1/approvals`           | `approval.respond`           |
| `POST /v1/clarifications`      | `clarification.respond`      |
| `POST /v1/slash-confirmations` | `slash-confirmation.respond` |

`GET /v1/health` and `GET /v1/capabilities` are bearer-authenticated too. The
capabilities response includes the initial command catalog; T3 can use it for
slash-command completion without reimplementing command behavior.

Callback tags are `message.send`, `message.edit`, `message.delete`,
`typing.set`, `turn.complete`, `approval.request`, `clarification.request`,
`slash-confirmation.request`, and `thread.create`. Message send/edit content is
always cumulative full content. `final` closes an individual message bubble;
it does not imply that the whole agent turn is done. The plugin emits
`turn.complete` from Hermes' post-delivery lifecycle hook only after the final
response and attachments have been delivered.

Request IDs are cached at ingress so retries do not inject duplicate turns or
resolve a prompt twice. Interactive T3 request IDs carry the resolver state
needed to answer an already-visible approval or clarification after a T3 server
restart. Outbound IDs prefer Hermes delivery metadata; when it does not provide
one, the plugin derives deterministic IDs from canonical event fields. The T3
bridge treats `requestId` as its idempotency key.

## Security and operations

- Use independent high-entropy ingress and bridge tokens.
- Keep file permissions on `~/.hermes/.env` owner-only.
- Never put tokens in a bridge URL, logs, thread content, or JSON bodies.
- Rotate either token by updating both peers and restarting the gateway/T3
  server together.
- The plugin intentionally suppresses the aiohttp access log so bearer headers
  cannot be exposed by custom access formats.
- T3 is the trusted upstream identity boundary. Once the bearer token is
  accepted, Hermes trusts the `user` asserted by T3 and does not apply a second
  platform-user allowlist.

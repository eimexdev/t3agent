# T3 Connect self-hosting and Hermes cron routing

Research snapshot: T3 Code `9a0a07167f0623c3a7db0ffeff2e3939760309df`; Hermes Agent `e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f`.

## Bottom line

- The entire implemented T3 Connect relay is present in this repository, and the repository includes its deployment stack. It can be deployed into accounts controlled by a fork operator, but the existing path is a cloud deployment rather than a process that runs beside Hermes: Cloudflare Worker/Tunnels/DNS/Queues/Hyperdrive, PlanetScale Postgres, Clerk, Axiom, and Apple APNs are assumed.
- With managed T3 Connect enabled, Tailscale is not needed for remote T3 Agent traffic. The phone bootstraps through the relay, then uses HTTPS/WSS through the managed Cloudflare endpoint directly to the local environment. Tailscale is an explicitly supported alternative transport: link the environment in `publish_only` mode so the relay handles activity/APNs while the client reaches the environment through Tailscale or direct pairing.
- Hermes cron execution and cron delivery are separate. Every agent-backed run gets a fresh isolated Hermes cron session. Its output can then be delivered to an existing origin topic/thread, optionally appended to that gateway session for continuity, or used to open and seed a new platform thread. Hermes does not currently rerun a cron job inside one persistent execution session.

## What exists and what self-hosting means

The relay owns account/environment links, managed endpoints, short-lived connection credentials, device registration, published agent activity, APNs notifications, and Live Activities. Normal HTTP/WebSocket traffic is deliberately outside the relay hot path after bootstrap. ([relay README](../../infra/relay/README.md#L6-L25))

The implementation is spread across:

- `infra/relay`: cloud control plane, HTTP API, persistence, authentication, managed endpoint allocation, APNs delivery, and deployment code. ([code map](../../infra/relay/README.md#L31-L48))
- `apps/server/src/cloud` and `apps/server/src/relay`: local environment linking, the `cloudflared` connector, credentials, and activity publishing.
- `packages/contracts` and `packages/client-runtime`: shared relay protocol and client.
- web/desktop/mobile clients: Clerk authentication, environment discovery, connection bootstrap, and notification registration.

The checked-in Alchemy stack provisions an Axiom trace destination, Cloudflare resources, Drizzle migrations, PlanetScale, and the Worker. ([stack](../../infra/relay/alchemy.run.ts#L1-L49)) The Worker binds Cloudflare queues, tunnel/DNS permissions, Hyperdrive/Postgres, Clerk credentials, APNs credentials, and generated signing keys. ([worker](../../infra/relay/src/worker.ts#L88-L215))

The supported deployment command is `vp run --filter t3code-relay deploy`. Production owns retained DNS zones and the PlanetScale database; developer stages refer to production and use isolated database branches, so a new operator deploys its own `prod` stage first. ([deployment guide](../../infra/relay/README.md#L77-L113))

Required external setup is substantial but conventional:

- Cloudflare account, API token, two DNS zones, Worker, Queues, Hyperdrive, and managed Tunnel permissions.
- PlanetScale organization and API credentials; the current database implementation is directly provisioned as PlanetScale Postgres. ([database stack](../../infra/relay/src/db.ts#L20-L68))
- Clerk application, JWT template/audience, and a public PKCE OAuth application for the headless CLI. ([Clerk setup](../../docs/cloud/t3-connect-clerk.md#L1-L73))
- Apple Developer APNs key, team/key IDs, environment, and a bundle ID matching the forked mobile app.
- Axiom organization/token for the deployment's observability resources.

The release/source builds point at an owned deployment using `T3CODE_RELAY_URL`, Clerk public configuration, and the CLI OAuth client ID. Missing values hide the cloud UI and commands. ([client configuration](../../docs/cloud/t3-connect-clerk.md#L9-L41)) Therefore this is genuinely operator-hostable with the shipped code, but “self-hosted” currently means “deployed into our vendor accounts.” Replacing those vendors or running the relay as a single local/Docker service would require a separate infrastructure port.

## T3 Connect versus Tailscale

Managed T3 Connect provisions a Cloudflare tunnel to the local loopback T3 server. Remote clients use the managed endpoint for normal HTTPS/WSS traffic; the relay performs discovery, authorization, sparse health checks, and credential minting, not steady-state proxying. ([architecture](../../docs/cloud/t3-code-connect-auth-flow.html#L720-L759))

The server also supports a `manual` endpoint. Its source explicitly describes this as an out-of-band route such as Tailscale, with notification-only relay scope. ([link modes](../../apps/server/src/cloud/http.ts#L304-L318)) The durable CLI mode calls this `publish_only`: it publishes agent activity to mobile while clients connect by Tailscale or direct pairing without T3 Connect's managed tunnel. ([CLI state](../../apps/server/src/cloud/CliState.ts#L17-L28))

Practical choices:

1. **Owned relay + managed endpoint:** one coherent T3 Agent remote-connect product; Tailscale is redundant.
2. **Owned relay + Tailscale + `publish_only`:** simplest private transport while retaining APNs/Live Activities; useful as a staged rollout.

## Exact Hermes cron behavior

### Execution session

Hermes documents cron jobs as fresh sessions with no current-chat context, so their prompts must be self-contained. ([cron tool schema](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/tools/cronjob_tools.py#L970-L988)) On every run, the scheduler generates `cron_<job-id>_<timestamp>`, constructs a new `AIAgent` with that session ID, titles it, ends it as `cron_complete`, and tears it down. ([session creation](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L2909-L2924), [agent construction](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L3340-L3371), [session close](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L3629-L3670))

Consequently, a cron job can deliver into a standing conversation, but its scheduled agent run does not inherit or continue that conversation's full history. Its independent cron transcript remains searchable/auditable.

### Delivery targets

`deliver` supports:

- omitted/`origin`: return to the chat and thread/topic where the job was created;
- `local`: save output only;
- `all`: fan out to configured home channels;
- `platform:chat_id[:thread_id]`: target a specific conversation lane;
- comma-separated combinations such as `origin,all`.

The origin captures platform, chat ID, thread ID, and user ID. ([origin capture](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/tools/cronjob_tools.py#L284-L308), [delivery schema](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/tools/cronjob_tools.py#L1016-L1019)) A new T3 Agent gateway can register as a Hermes platform plugin; setting `cron_deliver_env_var` makes it a valid cron target, without adding it to the hard-coded built-in list. ([platform registry](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/gateway/platform_registry.py#L138-L159))

### Standing conversation versus new thread

By default, delivery is visible on the target platform but is not copied into its Hermes gateway transcript. Per-job `attach_to_session`, or global `cron.mirror_delivery`, opts into continuity. For an existing origin topic/thread, Hermes appends a labelled cron-delivery turn to that exact origin session, so a later reply sees the result in context. Mirroring is origin-only; fan-out destinations are not mutated. ([mirror policy](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L624-L686), [mirror implementation](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L689-L755))

If continuity is enabled, the target is the origin, no explicit origin thread exists, and the live adapter supports threads, Hermes calls `create_handoff_thread`, delivers there, creates the matching thread-keyed Hermes gateway session, and seeds it with the cron result. DM-only platforms fall back to the origin DM session. ([thread open/seed](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L759-L865), [delivery decision](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/cron/scheduler.py#L1629-L1665))

One important implementation detail: the newly opened thread ID is local to that delivery call and is not persisted back into the cron job. Therefore a recurring job whose origin has no thread appears to attempt a fresh dedicated platform thread on every run. By contrast, a job created from an existing thread keeps delivering to that recorded thread ID.

## Implication for T3 Agent

The Hermes-native seam is a `t3agent` gateway platform adapter, not a second scheduler. Map a T3 Agent conversation to Hermes `chat_id`/`thread_id`, expose `deliver=origin`, implement delivery, and opt into transcript attachment for continuable jobs. T3 Agent can then offer an explicit per-job policy:

- **This thread:** preserve the T3 thread as origin and attach deliveries there.
- **New thread each run:** implement/retain Hermes' thread-creation behavior.
- **Fresh thread once, then reuse:** useful for a persistent “daily briefing” thread, but requires T3 Agent/Hermes to persist the created thread ID because current Hermes does not.

In every policy, keep the distinction visible: the scheduled computation runs in a fresh isolated Hermes cron session; the T3 thread is its delivery and continuation surface.

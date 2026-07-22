# Hermes Agent as a T3 Code surface: feasibility and server architecture

> **Scope note:** This document evaluates an ACP provider integration where T3 owns the
> provider lifecycle. For the intended product—a persistent Hermes gateway channel like
> Discord, including cron and proactive delivery—see
> [`hermes-t3-gateway.md`](./hermes-t3-gateway.md). That gateway architecture supersedes
> the recommendation below for this use case.

Research snapshot: T3 Code commit [`9a0a07167f0623c3a7db0ffeff2e3939760309df`](https://github.com/pingdotgg/t3code/tree/9a0a07167f0623c3a7db0ffeff2e3939760309df), inspected 2026-07-22. Hermes Agent references are pinned to upstream commit [`e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f`](https://github.com/NousResearch/hermes-agent/tree/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f).

## Verdict

Yes. A fork of T3 Code can be a first-class web, desktop, and mobile surface for Hermes Agent without replacing T3's server or inventing a Hermes-specific network protocol.

The lowest-risk design is:

```text
T3 web / mobile / desktop client
          |
          | TLS: authenticated HTTP + WebSocket RPC
          v
one isolated execution environment per user/trusted workspace
  T3 Node server -> ACP over stdio -> hermes acp
          |
          +-- workspace filesystem
          +-- persistent T3CODE_HOME
          +-- persistent HERMES_HOME
```

This is unusually favorable because both sides already expose the necessary seam. T3 nightly has an open provider-driver SPI, a reusable ACP client runtime, canonical provider events, authenticated remote access, and a headless server. Hermes now ships `hermes acp`, a stdio ACP server with session load/resume/list/fork, model selection, streaming messages/reasoning, plans, tools, permissions, images, usage, and cancellation. The work is therefore primarily an adapter and product-integration project, not a rewrite of either agent loop.

The main caveat is hosting: a T3 environment is an execution host, not a stateless web API. A production deployment needs a long-lived VM or container with persistent disk, checked-out repositories, Node, Python/Hermes, Git, PTY support, and any tools Hermes is allowed to run. The existing T3 relay exposes such an environment; it does not provide the compute or workspace itself.

## Why the T3 server is already the right host boundary

T3's runtime is already divided at the desired point. The client speaks typed RPC over an authenticated `/ws` endpoint, while the server owns provider processes, orchestration, filesystem, VCS, terminals, persistence, and previews. The route graph combines HTTP APIs, static assets, WebSocket RPC, and MCP into one server process ([`server.ts`, routes and runtime composition](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/server.ts#L287-L364)); the WebSocket upgrade is authenticated before the RPC layer is installed ([`ws.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/ws.ts#L2079-L2103)).

The provider seam is not a Codex-only abstraction anymore:

- `ProviderDriver<Config, R>` owns a config decoder and a scoped `create` function. Each created instance bundles a live status snapshot, runtime adapter, and text-generation service; its resources must be released with its scope ([`ProviderDriver.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/ProviderDriver.ts#L55-L74), [`ProviderDriver.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/ProviderDriver.ts#L106-L156)).
- `ProviderAdapterShape` is the protocol-neutral operational contract: start/send/interrupt, approvals and user input, stop/list/recover, rollback, and a canonical event stream ([`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Services/ProviderAdapter.ts#L45-L125)).
- `ProviderDriverKind` is deliberately an open slug, and driver configuration is an opaque envelope. Fork-only driver IDs therefore survive contract decoding even on builds that do not know the driver ([`providerInstance.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/providerInstance.ts#L16-L32), [`providerInstance.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/contracts/src/providerInstance.ts#L115-L139)).
- The built-in registration point explicitly documents the three steps for a new driver: implement it, add it to `BUILT_IN_DRIVERS`, and satisfy its Effect environment ([`builtInDrivers.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/builtInDrivers.ts#L1-L19), [`builtInDrivers.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/builtInDrivers.ts#L35-L53)).
- Provider instances are hydrated from a driver-agnostic settings map and hot-reconciled when settings change ([`ProviderInstanceRegistryHydration.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts#L60-L104), [`ProviderInstanceRegistryHydration.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts#L117-L174)).

That means a server-only proof can add a `hermes` entry under `providerInstances` without first changing the whole transport contract. First-class settings, icons, labels, model defaults, and onboarding still require client/contracts work, but routing and persistence are already instance-aware.

## Why ACP should be the Hermes integration boundary

Hermes officially exposes `hermes acp`, described by its CLI as an ACP server for editor integration ([Hermes `subcommands/acp.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/hermes_cli/subcommands/acp.py#L14-L37)). Its entry point reserves stdout for ACP JSON-RPC and sends logs to stderr, loads `HERMES_HOME`, and starts the agent through `acp.run_agent` ([Hermes `acp_adapter/entry.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/entry.py#L1-L14), [startup](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/entry.py#L217-L267)). ACP is specifically intended to standardize communication between code editors and coding agents; its official protocol includes initialization, authentication, session setup, prompt turns, content, tool calls, permissions, cancellation, terminals, plans, modes, and configuration ([official ACP protocol](https://agentclientprotocol.com/protocol/v1/overview)).

Hermes advertises session load, fork/list/resume, and image prompts during ACP initialization ([Hermes `server.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/server.py#L863-L897)). It implements new/load/resume, history replay, cancellation, fork, and paginated session listing ([Hermes `server.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/server.py#L1113-L1213), [cancellation and listing](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/server.py#L1215-L1295)). Its callback bridge emits native ACP tool lifecycle, plan, reasoning, and assistant-message updates ([Hermes `events.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/events.py#L39-L84), [`events.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/events.py#L114-L180), [`events.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/events.py#L189-L277)). Its permission bridge maps dangerous-command prompts to ACP `request_permission`, with allow-once/session/always and deny behavior ([Hermes `permissions.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/permissions.py#L18-L73), [`permissions.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/permissions.py#L110-L173)).

T3 already contains the complementary half. `AcpSessionRuntime` accepts a command/args/cwd/env spawn description, starts an ACP child process, performs initialization and session setup, and exposes model/session results ([`AcpSessionRuntime.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/acp/AcpSessionRuntime.ts#L43-L97), [`AcpSessionRuntime.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/acp/AcpSessionRuntime.ts#L332-L368)). Cursor proves the pattern: it wraps that runtime with provider-specific spawn arguments and authentication/capabilities, then maps common ACP updates to canonical T3 events ([`CursorAcpSupport.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/acp/CursorAcpSupport.ts#L16-L72), [`CursorAdapter.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Layers/CursorAdapter.ts#L43-L79)).

Therefore the recommended implementation is a thin Hermes ACP adapter, not a direct import of Hermes Python internals and not a second HTTP connection to Hermes's dashboard backend. ACP keeps process lifetime, cwd, cancellation, permissions, and event ordering inside T3's existing provider lifecycle.

### Local compatibility probe (2026-07-22)

A live stdio handshake against locally installed Hermes Agent v0.19.0 succeeded. T3-shaped test traffic sent ACP `initialize`; Hermes returned protocol version 1, image prompt support, load/fork/list/resume session capabilities, provider authentication methods, and the fixed `hermes-setup` method. `authenticate` with `methodId: "hermes-setup"` then succeeded. This confirms that T3's initialize/authenticate/new-or-load sequence has a compatible Hermes counterpart.

This was deliberately only a handshake probe. It did **not** create and complete a real model turn, stream a tool call, exercise an approval, or prove resume/cancel behavior. Those remain the go/no-go spike.

## What the new sidebar and mobile app change

The new sidebar is useful product scaffolding, but it is not just a visual skin. Sidebar v2 landed in [PR #4026](https://github.com/pingdotgg/t3code/pull/4026) and its settled/active lifecycle, attention states, grouping, filtering, and responsive behavior depend on server-backed thread state. Hermes should emit canonical T3 lifecycle, approval, input, and failure events so it naturally participates in those semantics; a fork should not maintain a Hermes-only parallel thread model.

Web and mobile share contracts, authorization/connection supervision, RPC, and domain state through `@t3tools/client-runtime` ([client-runtime responsibilities](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/packages/client-runtime/README.md#L1-L31)), but they do not share React UI. Web mounts `SidebarV2` behind `sidebarV2Enabled`; compact mobile has its own renderer and model behind `threadListV2Enabled`. The current iPad split view still mounts the older `ThreadNavigationSidebar`, so a complete branded experience needs a second mobile/tablet UI pass rather than assuming the web sidebar propagates automatically.

The mobile app is substantial but still explicitly in development and not distributed. It requires Expo Dev Client because of native modules, and T3 Connect is optional in a fresh clone ([mobile README](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/mobile/README.md#L1-L21)). Direct pairing to a reachable Hermes/T3 environment is therefore the right mobile MVP. A public branded fork later needs its own assets and strings, URL schemes, iOS bundle IDs, Android application IDs, EAS project/build profiles, Apple capabilities, and either replacement or removal of T3's Clerk/relay configuration. Provider/model data is mostly dynamic, but the mobile provider icon component has hard-coded branches and needs a Hermes glyph/fallback.

## Concrete implementation map

### 1. Contracts and configuration

Add a `HermesSettings` schema with at least:

- `enabled`
- `binaryPath` (default `hermes`)
- optional `homePath` (translated to `HERMES_HOME`)
- optional launch arguments
- optional configured/fallback model list if probing cannot obtain a catalog

For a polished default instance, add `hermes` to the legacy `ServerSettings.providers` struct and patch schema, `PROVIDER_DISPLAY_NAMES`, model defaults, and client provider metadata. A minimal spike can skip the legacy field and use the already-open `providerInstances` envelope.

### 2. Server provider driver

Create these modules, following Cursor's division:

- `apps/server/src/provider/Drivers/HermesDriver.ts`
- `apps/server/src/provider/Layers/HermesAdapter.ts`
- `apps/server/src/provider/Layers/HermesProvider.ts`
- `apps/server/src/provider/acp/HermesAcpSupport.ts`
- `apps/server/src/textGeneration/HermesTextGeneration.ts`

`HermesDriver.create()` should return all three required surfaces: snapshot, adapter, and text generation. Cursor's driver is the closest complete template: it builds per-instance environment and identity, creates adapter/text-generation closures, probes status, and wraps refreshes in `makeManagedServerProvider` ([`CursorDriver.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Drivers/CursorDriver.ts#L94-L164)). Register `HermesDriver` in `BUILT_IN_DRIVERS` and extend `BuiltInDriversEnv`.

`HermesAcpSupport` should spawn approximately:

```ts
{
  command: settings.binaryPath || "hermes",
  args: [...parsedLaunchArgs, "acp"],
  cwd,
  env: { ...instanceEnvironment, HERMES_HOME: settings.homePath }
}
```

For a preconfigured environment, use Hermes's fixed `hermes-setup` ACP auth method; the local probe confirmed that it succeeds. Do not hard-code a model-vendor auth ID. For interactive provider setup later, widen `AcpSessionRuntimeOptions` so the UI can select from `initializeResult.authMethods` and add an intentional secret-entry/setup flow.

### 3. Canonical event mapping

Reuse `AcpCoreRuntimeEvents` and the generic parsing in `AcpRuntimeModel` for:

- assistant and reasoning deltas
- tool start/update/complete
- plan updates
- permission request/open/resolved
- session and turn lifecycle
- token/context usage

Hermes already emits these through ACP. Provider-specific logic should be limited to model selection, mode aliases, resume-cursor shape, and any Hermes `_meta` extensions. This is a good opportunity to extract the provider-neutral majority of `CursorAdapter` into a shared `makeAcpProviderAdapter`; copying the full Cursor adapter would work for a spike but creates an expensive long-term fork seam.

The resume cursor should persist the Hermes ACP `session_id`. On reconnect, use ACP load/resume so Hermes replays the transcript before the response. T3's own event store remains the UI projection; Hermes remains the authoritative agent-memory/session store.

The rollback seam deserves an explicit product decision. T3's adapter contract requires `rollbackThread`, but its current Cursor implementation only trims the adapter's in-memory turn list ([`CursorAdapter.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/provider/Layers/CursorAdapter.ts#L1111-L1130)); Hermes ACP offers fork, not “delete last N turns.” Matching Cursor is acceptable for an MVP, but the UI must not imply Hermes memory was rewound unless Hermes gains a true rewind API.

### ACP gaps and explicit MVP non-goals

- Hermes ACP does not appear to bridge every interactive Hermes callback. In particular, clarify prompts, sudo-password collection, and skill-secret requests need targeted end-to-end tests and probably upstream ACP extensions. The MVP should preconfigure secrets, disable workflows that require an unbridged secret prompt, and treat clarify/sudo support as out of scope.
- Hermes maps edit-approval policy to ACP modes; these are not T3/Codex-style plan-versus-code modes ([Hermes `server.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/server.py#L534-L565)). The fork must label them accurately instead of translating T3 `sandboxMode` or plan-mode controls mechanically.
- T3's `sandboxMode` does not automatically isolate Hermes. Hermes's own security model says the OS is the security boundary and documents the limits of terminal-backend isolation ([Hermes `SECURITY.md`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/SECURITY.md#L58-L88)). Hosted safety comes from the containing VM/container plus explicit Hermes tool/backend policy.
- Do not promise true turn rewind, shared multi-tenant execution, offline mobile execution, T3 Connect, store distribution, or complete rebranding in the first proof.
- Do not switch to Hermes's richer TUI/dashboard WebSocket protocol for the MVP. ACP covers the useful common path; consider the richer protocol only if elicitation gaps cannot be closed in ACP.

### 4. Provider health and model catalog

The provider snapshot must answer “installed/authenticated/ready” and supply models. Suggested probe sequence:

1. run `hermes acp --check` and `hermes acp --version` with the instance environment;
2. start a short-lived ACP runtime and inspect the session setup model state, or add a non-mutating Hermes inventory command if creating a probe session is undesirable;
3. map the returned `provider:model` IDs into `ServerProviderModel` rows;
4. refresh on settings changes and a bounded interval.

Hermes's ACP server already constructs a model state with provider-qualified IDs and a current model ([Hermes `server.py`](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/acp_adapter/server.py#L572-L643)). Model switching can use ACP `session/set_model`; T3 should mark `sessionModelSwitch: "in-session"` only after an integration test proves Hermes preserves the active session during the switch.

`HermesTextGeneration` is required even if chat works, because T3 routes branch names, commit messages, PR text, and titles through the selected provider instance. It can use a short-lived Hermes ACP session with a restricted prompt, or a stable Hermes one-shot command if Hermes documents machine-readable output. Do not silently route these operations to Codex, because that would make a Hermes-only hosted environment incomplete.

### 5. Tests that define the compatibility contract

Use a deterministic mock ACP process first, then one opt-in real-Hermes smoke test. Cover:

- installed/missing/auth-failed provider snapshots;
- start, stream text/reasoning, tool lifecycle, plan, complete;
- accept/decline/session approval mapping;
- interrupt while awaiting model and while a tool runs;
- session resume with history replay;
- model discovery and in-session switching;
- image attachment path conversion;
- process exit, restart, and server shutdown cleanup;
- two Hermes instances with different `HERMES_HOME` values;
- checkpoint/revert behavior with the rollback limitation made explicit.

## Hosting architecture

### Deployable unit

Use one isolated T3+Hermes execution environment per user or trusted workspace, not one shared multi-tenant T3 process. T3 authorization scopes control what a connected client may call, but an environment intentionally shares its projects, filesystem, provider credentials, terminals, and agent sessions. Authentication is mature enough for remote access—remote-reachable bindings select one-time-token bootstrap and cookie/Bearer/DPoP sessions ([`EnvironmentAuthPolicy.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/auth/EnvironmentAuthPolicy.ts#L17-L45)); requests accept cookie, Bearer, or DPoP credentials and validate proof-bound tokens ([`EnvironmentAuth.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/auth/EnvironmentAuth.ts#L538-L630)); WebSockets can use short-lived tickets ([`EnvironmentAuth.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/auth/EnvironmentAuth.ts#L931-L956)). None of that is an OS-level tenant sandbox.

A practical first deployment is a single Linux VM/container per owner with:

```text
/data/t3        persistent T3CODE_HOME
/data/hermes    persistent HERMES_HOME
/workspaces     persistent project clones/worktrees
```

T3 stores SQLite state, settings, attachments, worktrees, logs, environment identity, runtime state, and secrets under its base directory ([`config.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/config.ts#L95-L128)). Both `/data/t3` and `/data/hermes` must survive restarts; workspaces must survive if the environment is expected to keep edits and git state.

Hermes similarly keeps configuration, credentials, skills, memories, and its canonical SQLite session database under its home directory ([Hermes contributor guide](https://github.com/NousResearch/hermes-agent/blob/e0b9ab5ac5d0b593df4f4a289200fcc116d5f75f/CONTRIBUTING.md#L283-L294)). That makes `HERMES_HOME` persistent application state, not a disposable child-process cache.

Run the bundled headless server behind TLS:

```bash
T3CODE_HOME=/data/t3 \
HERMES_HOME=/data/hermes \
t3 serve --host 0.0.0.0 --port 3773 /workspaces
```

`t3 serve` is specifically the headless mode ([`cli/server.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/cli/server.ts#L21-L35)); host, port, and base directory are CLI/env configuration ([`cli/config.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/cli/config.ts#L20-L37), [`cli/config.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/cli/config.ts#L78-L108)). The server can bind Node or Bun HTTP implementations ([`server.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/server.ts#L121-L144)). The reverse proxy or ingress must preserve WebSocket upgrades and use HTTPS/WSS for browser/mobile access.

### Packaging gap

T3 publishes a Node CLI, not a server container. Its build packs `src/bin.ts`, depends on a web build, and copies `apps/web/dist` into `dist/client` ([`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/vite.config.ts#L22-L45), [`scripts/cli.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/scripts/cli.ts#L160-L191)). The package exposes `dist/bin.mjs`, requires a compatible Node version, and depends on native `node-pty` ([`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/package.json#L1-L22), [`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/package.json#L24-L50)). A hosted fork therefore needs a Dockerfile or VM image that installs the correct Node architecture, Python/Hermes, Git and other system tools, includes the built T3 client/server artifact, and runs migrations at startup through the normal server boot.

The existing managed endpoint is useful but orthogonal: it launches `cloudflared tunnel run` with a connector token ([`ManagedEndpointRuntime.ts`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/src/cloud/ManagedEndpointRuntime.ts#L209-L245)). It can expose the environment, but the environment still has to exist and keep its disk and provider process alive.

### Production controls still needed

- container/VM isolation and per-environment CPU, memory, disk, and process limits;
- an explicit policy for which Hermes tools and terminal backends are allowed;
- encrypted secret injection and backup policy for both T3 and Hermes homes;
- TLS termination, WebSocket timeouts, origin policy, rate limits, and audit retention;
- environment provisioning, wake/sleep, upgrades, health checks, and draining active turns;
- egress policy for model APIs, MCP servers, browser tools, and package downloads;
- observability that correlates T3 thread/turn IDs with Hermes ACP session/tool IDs;
- dependency/license inventory and retained MIT notices. T3's server package is MIT-licensed ([`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/9a0a07167f0623c3a7db0ffeff2e3939760309df/apps/server/package.json#L1-L8)), so a fork is permitted subject to the license notice, but redistributed third-party components still need their own review.

## Suggested delivery plan

### Phase 0: protocol spike (2–4 engineering days)

Spawn `hermes acp` from T3's `AcpSessionRuntime`, create one session, stream assistant/reasoning/tool events, approve one command, interrupt one turn, and resume it. Hard-code one model and configure the `hermes` instance directly in `settings.json`. The successful handshake answered the first protocol question; this phase answers whether a complete turn—including tools, permission response, interrupt, and resume—maps correctly into T3's canonical event model.

### Phase 1: local fork MVP (roughly 2–4 weeks)

Implement the driver, adapter, snapshot probe, model picker, settings/onboarding, text generation, tests, and desktop/web branding. Preserve all provider functionality behind the new sidebar rather than creating a parallel Hermes-only chat screen. Validate web plus one mobile simulator against the same server.

### Phase 2: hosted single-user environment (roughly 1–3 additional weeks)

Build and harden the Linux image, persistent volumes, HTTPS/WSS ingress, pairing flow, backup/restore, logs/metrics, upgrades, and resource limits. Start with one always-on environment and then add suspend/resume only after ACP child-process recovery is reliable.

### Phase 3: managed product

Add per-user environment provisioning, billing/quotas, dormant-environment wakeup, region placement, workspace import/clone, secret management, abuse controls, support tooling, and mobile push/activity integration. This is the expensive part; it is infrastructure around the already-feasible agent surface, not provider adapter work.

## Go/no-go prototype checklist

Proceed from spike to product MVP only if one disposable Linux environment can demonstrate all of the following with pinned T3 and Hermes versions:

- `hermes acp` initializes and authenticates through T3 without stdout contamination;
- a prompt produces ordered text/reasoning and a terminal tool lifecycle in the T3 UI;
- allow and deny permission responses reach Hermes, and an interrupt terminates the active turn cleanly;
- server restart loads the same Hermes ACP session and does not duplicate replayed T3 events;
- model discovery and at least one in-session model switch behave predictably;
- image input reaches Hermes, while unsupported clarify/sudo/secret paths fail visibly rather than hanging;
- two isolated environments cannot see each other's workspaces, credentials, T3 state, or Hermes state;
- the web Sidebar v2 attention/settled states and one representative mobile flow agree for the same thread.

A failure in event mapping is an adapter bug and not a reason to abandon the design. A no-go signal would be a protocol-level inability to resume without corrupting or duplicating history, an unavoidable interactive callback that ACP cannot represent for the target workflows, or inability to contain Hermes process/tool execution at the environment boundary.

## Decision summary

The fork is technically viable now, and the ACP route is strong enough to justify a short implementation spike. The architecture to avoid is “host only the React app and call a centralized Hermes API.” T3's value comes from keeping the server beside the agent, repository, filesystem, git, and terminal runtime. Host that complete execution environment, expose it through T3's authenticated WebSocket boundary, and let the existing web/mobile clients remain thin surfaces.

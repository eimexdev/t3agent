# T3 Agent

T3 Agent is the working name for a rich Hermes-native conversation surface and gateway. Hermes remains the agent runtime and source of agent behavior.

## Current product boundaries

- The first deployment runs T3 Agent and Hermes on the same machine.
- Hermes is independently managed and already running. T3 Agent attaches to it; T3 Agent does not own the Hermes process lifecycle.
- Linux is the first execution-host and desktop target. macOS clients should reach that Linux host through Tailscale or the hosted web client using the same environment protocol.
- Remote clients should ultimately use an operator-owned T3 Connect deployment. Tailscale remains a useful development or fallback access path, not the primary product architecture.
- A new T3 Agent thread creates a normal Hermes conversation; projects and working directories are not part of the initial thread-creation flow.
- T3 Code's provider architecture should remain reusable, but the initial product exposes only Hermes.
- Coding, project, workspace, and specialized sidebar integrations are later capabilities. Existing T3 Code implementations should initially be hidden rather than treated as the core product.
- V1 targets Discord-like Hermes gateway parity before notification work: Hermes slash commands, streaming and interruption, approvals, clarifications, reconnect/restart recovery, and other core conversational gateway behavior must work end to end.
- Notifications and T3 Connect rollout follow gateway parity rather than compensating for an incomplete interactive surface.

## Language

**T3 Agent Thread**:
A Hermes conversation created in or proactively delivered to T3 Agent. Initially, it does not include conversations belonging to CLI, Discord, or another Hermes gateway.
_Avoid_: Project thread, global Hermes session

**Cross-gateway conversation**:
A Hermes conversation originating from a surface other than T3 Agent. Browsing or handing off these conversations is a later capability, not part of the initial scope.
_Avoid_: Synced thread

**Active Hermes model**:
The model currently backing a T3 Agent thread. It should be visible as read-only product context initially; changing it per thread through Hermes model-selection behavior is a later capability.
_Avoid_: T3 provider selection

**Cron execution session**:
The fresh, isolated Hermes agent session created for one scheduled run. It does not inherit the full history of the T3 Agent thread that receives its result.
_Avoid_: Cron thread

**Cron delivery thread**:
The T3 Agent conversation where a cron result is shown and may be continued. Depending on the job's delivery policy, this may be the originating thread, a fresh thread for each run, or a persistent thread created for the job.
_Avoid_: Cron session

**Operator-owned T3 Connect**:
Our deployment of the checked-in T3 Connect control plane and notification stack. In the current upstream architecture this is deployed into Cloudflare, PlanetScale, Clerk, Axiom, and Apple APNs accounts; it is not a sidecar on the Hermes machine.
_Avoid_: Local relay

**Gateway parity**:
Behavioral parity with using Hermes through a mature messaging gateway such as Discord. It includes Hermes-owned commands and interaction semantics; it does not mean copying Discord's visual design or Discord-specific social features.
_Avoid_: Basic chat support

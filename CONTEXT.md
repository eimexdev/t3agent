# T3 Agent

T3 Agent is a rich, thread-native conversation surface for Hermes. This glossary names the product concepts shared by its clients, gateway, and Hermes integration.

## Product

**T3 Agent**:
The product surface through which a person converses with Hermes and receives its proactive work.
_Avoid_: T3 Code provider, Hermes replacement

**Hermes runtime**:
The independently managed agent system that owns reasoning, tools, memory, models, sessions, scheduled work, and background work.
_Avoid_: T3 Agent backend, embedded agent

**T3 Agent gateway**:
The boundary that presents T3 Agent as a Hermes messaging surface while preserving Hermes behavior.
_Avoid_: Hermes CLI wrapper, ACP agent

**Gateway parity**:
Behavioral parity with using Hermes through a mature messaging gateway, including commands and interactive agent requests without copying that gateway's visual design.
_Avoid_: Discord clone, basic chat support

## Conversations

**T3 Agent thread**:
A visible T3 Agent conversation backed by one Hermes session.
_Avoid_: Project thread, workspace, channel

**Hermes session**:
The durable Hermes-owned conversation context that the agent continues across turns.
_Avoid_: T3 transcript, project

**Hermes session title**:
The Hermes-owned name of a session. A Hermes-backed T3 Agent thread displays this title as a local projection rather than owning an independent name.
_Avoid_: T3 thread name, synchronized title

**Cross-gateway conversation**:
A Hermes session that originated from the CLI or another messaging surface rather than T3 Agent.
_Avoid_: Synced thread

**Session browser**:
A grouped view of T3 Agent threads and cross-gateway Hermes sessions available to resume or import.
_Avoid_: Thread list, T3-only history

**Session import**:
A new T3 Agent thread and child Hermes session copied from a cross-gateway conversation while leaving the source session unchanged.
_Avoid_: Attach, move, sync

**Thread lineage**:
The provenance relationship connecting an imported or forked T3 Agent thread to its source conversation.
_Avoid_: Referral, synchronization

**Agent run**:
One bounded unit of Hermes work that reaches a terminal outcome and produces a completion point in a thread.
_Avoid_: Chat, session

**Fork**:
A new T3 Agent thread and child Hermes session whose history ends at a selected completed agent run.
_Avoid_: Git branch, copied transcript

**Resume**:
Returning to an existing T3 Agent thread, or importing a selected cross-gateway conversation into a new thread.
_Avoid_: Replace thread context, attach

## Interaction

**Hermes command**:
A slash command whose meaning and execution are owned by Hermes, even when T3 Agent provides discovery or argument guidance.
_Avoid_: T3 action

**Lifecycle command**:
A Hermes command such as new, fork, sessions, or resume whose T3 Agent presentation must preserve thread-to-session identity.
_Avoid_: Passthrough command

**Command hint**:
Non-message guidance that shows the next expected command argument without becoming part of the submitted text.
_Avoid_: Autofill, command form

**Active Hermes model**:
The effective model backing a T3 Agent thread.
_Avoid_: T3 provider selection

**Reasoning effort**:
The effective Hermes thinking level inherited or selected for a thread.
_Avoid_: T3 reasoning mode

**Session-setting change**:
A point in a thread's history where its active Hermes model or reasoning effort changes.
_Avoid_: System message, global configuration

**Approval**:
A blocking Hermes request for permission to perform a consequential action.
_Avoid_: Confirmation, clarification

**Clarification**:
A blocking Hermes request for information needed to continue an agent run.
_Avoid_: Approval, follow-up message

**Voice note**:
A recorded user message delivered to Hermes as speech for automatic transcription.
_Avoid_: Audio file, voice channel

**Voice draft**:
A completed but unsent voice recording available for replay, discard, or delivery.
_Avoid_: Paused recording, attachment

**Voice transcript**:
The Hermes-produced text associated with a specific voice note.
_Avoid_: Assistant reply, caption

## Automation and remote access

**Cron execution session**:
The fresh, isolated Hermes session created for one scheduled run.
_Avoid_: Cron thread

**Cron delivery thread**:
The T3 Agent thread where scheduled output appears and may be continued.
_Avoid_: Cron session

**Operator-owned T3 Connect**:
The operator's deployment of the T3 Connect control plane and notification stack.
_Avoid_: Local relay, Tailscale

# Hermes remains the agent runtime

T3 Agent is a first-class Hermes messaging surface, not a replacement CLI or a second agent runtime. Hermes continues to own sessions, models, reasoning, tools, memory, approvals, scheduled work, and background work; T3 Agent owns the rich thread projection, interaction controls, client connectivity, and durable delivery surface. This keeps gateway behavior consistent with Discord and other Hermes surfaces while allowing the T3 fork to specialize its product shell without taking ownership of agent execution.

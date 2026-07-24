import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("decider imported messages", (it) => {
  it.effect("replaces an existing history slot even when the imported text is empty", () =>
    Effect.gen(function* () {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-import");
      const threadId = ThreadId.make("thread-import");
      const initial = createEmptyReadModel(createdAt);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: EventId.make("event-project-import"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-import"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-import"),
        metadata: {},
        payload: {
          projectId,
          title: "Imports",
          workspaceRoot: "/tmp/imports",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const readModel = yield* projectEvent(withProject, {
        sequence: 2,
        eventId: EventId.make("event-thread-import"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-thread-import"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread-import"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Imported thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "openai-codex::gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.import",
          commandId: CommandId.make("command-message-import"),
          threadId,
          messageId: MessageId.make("message-import"),
          role: "assistant",
          text: "",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        readModel,
      });

      const importedEvent = Array.isArray(event) ? event[0] : event;
      expect(importedEvent?.type).toBe("thread.message-sent");
      if (importedEvent?.type !== "thread.message-sent") {
        return;
      }
      expect(importedEvent.payload.imported).toBe(true);
      expect(importedEvent.payload.replaceText).toBe(true);
      expect(importedEvent.payload.text).toBe("");
    }),
  );
});

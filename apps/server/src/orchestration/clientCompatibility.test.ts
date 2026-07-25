import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadMessageSentPayload,
} from "@t3tools/contracts";

import {
  makeOrchestrationThreadStreamProjectorForClient,
  projectOrchestrationEventForClient,
  projectOrchestrationMessageForClient,
  projectOrchestrationThreadForClient,
} from "./clientCompatibility.ts";

const audioAttachment = {
  type: "audio" as const,
  id: "audio-1",
  name: "Voice note",
  mimeType: "audio/webm",
  sizeBytes: 128,
  durationMs: 1_000,
  waveform: [0.1, 0.8],
};

const message: OrchestrationMessage = {
  id: MessageId.make("message-1"),
  role: "user",
  text: "",
  attachments: [audioAttachment],
  turnId: null,
  streaming: false,
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
};

function transcriptionActivity(
  status: "transcribing" | "ready" | "failed",
  transcript?: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${status}`),
    tone: status === "failed" ? "error" : "info",
    kind: "voice-transcription.updated",
    summary: "Voice transcription updated",
    payload: {
      attachmentId: audioAttachment.id,
      status,
      ...(transcript !== undefined ? { transcript } : {}),
    },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-07-24T12:00:01.000Z",
  };
}

function threadWithActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Voice thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("hermes"),
      model: "gpt-5.6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:01.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [message],
    proposedPlans: [],
    activities: [...activities],
    checkpoints: [],
    session: null,
  };
}

describe("clientCompatibility", () => {
  it("keeps audio attachments for capable clients", () => {
    expect(
      projectOrchestrationMessageForClient(message, {
        audioAttachments: true,
      }),
    ).toBe(message);
  });

  it("replaces audio attachments with legacy-safe text when capability is missing", () => {
    const projected = projectOrchestrationMessageForClient(message, undefined);
    const { attachments: _attachments, ...messageWithoutAttachments } = message;
    expect(projected).toEqual({
      ...messageWithoutAttachments,
      text: "[Voice note]",
    });
    expect(projected).not.toHaveProperty("attachments");
  });

  it("retains supported attachments and an embedded transcript", () => {
    expect(
      projectOrchestrationMessageForClient(
        {
          ...message,
          text: "Additional context",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "reference.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
            {
              ...audioAttachment,
              transcript: "Call Morgan tomorrow.",
              transcriptionStatus: "ready",
            },
          ],
        },
        undefined,
      ),
    ).toMatchObject({
      text: "Additional context\n\n[Voice note transcript]\nCall Morgan tomorrow.",
      attachments: [{ type: "image", id: "image-1" }],
    });
  });

  it("projects live message events for legacy clients", () => {
    const payload: ThreadMessageSentPayload = {
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "",
      attachments: [audioAttachment],
      turnId: null,
      streaming: false,
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
    };
    const event = {
      sequence: 1,
      eventId: EventId.make("event-1"),
      aggregateKind: "thread" as const,
      aggregateId: ThreadId.make("thread-1"),
      occurredAt: "2026-07-24T12:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent" as const,
      payload,
    };

    expect(projectOrchestrationEventForClient(event, undefined)).toMatchObject({
      payload: {
        text: "[Voice note]",
      },
    });
    expect(projectOrchestrationEventForClient(event, undefined).payload).not.toHaveProperty(
      "attachments",
    );
  });

  it("joins completed transcription activities into legacy thread snapshots", () => {
    const projected = projectOrchestrationThreadForClient(
      threadWithActivities([transcriptionActivity("ready", "The persisted transcript.")]),
      undefined,
    );

    expect(projected.messages[0]).toMatchObject({
      text: "[Voice note transcript]\nThe persisted transcript.",
    });
    expect(projected.messages[0]).not.toHaveProperty("attachments");
  });

  it("replaces a live legacy placeholder when transcription completes", () => {
    const projector = makeOrchestrationThreadStreamProjectorForClient(
      undefined,
      threadWithActivities([]),
    );
    const activity = transcriptionActivity("ready", "The live transcript.");
    const activityEvent = {
      sequence: 2,
      eventId: EventId.make("event-2"),
      aggregateKind: "thread" as const,
      aggregateId: ThreadId.make("thread-1"),
      occurredAt: activity.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended" as const,
      payload: {
        threadId: ThreadId.make("thread-1"),
        activity,
      },
    };

    expect(projector({ kind: "event", event: activityEvent })).toMatchObject({
      kind: "event",
      event: {
        sequence: 2,
        type: "thread.message-sent",
        payload: {
          messageId: MessageId.make("message-1"),
          text: "[Voice note transcript]\nThe live transcript.",
          replaceText: true,
        },
      },
    });
  });
});

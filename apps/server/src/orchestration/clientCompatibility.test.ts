import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationMessage,
  type ThreadMessageSentPayload,
} from "@t3tools/contracts";

import {
  projectOrchestrationEventForClient,
  projectOrchestrationMessageForClient,
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
});

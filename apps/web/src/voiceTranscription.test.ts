import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "./types";
import { deriveVoiceTranscriptionsByAttachmentId } from "./voiceTranscription";

function voiceMessage(input: {
  readonly messageId: string;
  readonly attachmentId: string;
  readonly createdAt: string;
  readonly turnId?: string;
}): ChatMessage {
  return {
    id: MessageId.make(input.messageId),
    role: "user",
    text: "",
    attachments: [
      {
        type: "audio",
        id: input.attachmentId,
        name: "Voice note",
        mimeType: "audio/webm",
        sizeBytes: 100,
        durationMs: 2_000,
        waveform: [0.2, 0.8],
        transcriptionStatus: "transcribing",
      },
    ],
    turnId: input.turnId ? TurnId.make(input.turnId) : null,
    streaming: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function transcriptionActivity(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: "voice-transcription.updated",
    summary: "Voice note transcribed",
    payload: input.payload,
    turnId: TurnId.make(input.turnId),
    createdAt: input.createdAt,
  };
}

describe("voice transcription association", () => {
  it("joins a transcript to a turnless optimistic message by attachment identity", () => {
    const message = voiceMessage({
      messageId: "message-1",
      attachmentId: "audio-1",
      createdAt: "2026-07-24T23:37:23.373Z",
    });
    const activity = transcriptionActivity({
      id: "activity-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T23:37:27.256Z",
      payload: {
        attachmentId: "audio-1",
        status: "ready",
        transcript: "The transcript made it back.",
      },
    });

    expect(deriveVoiceTranscriptionsByAttachmentId([message], [activity]).get("audio-1")).toEqual({
      status: "ready",
      transcript: "The transcript made it back.",
    });
  });

  it("associates legacy turn-only callbacks with the nearest preceding voice note", () => {
    const first = voiceMessage({
      messageId: "message-1",
      attachmentId: "audio-1",
      createdAt: "2026-07-24T23:30:00.000Z",
    });
    const second = voiceMessage({
      messageId: "message-2",
      attachmentId: "audio-2",
      createdAt: "2026-07-24T23:37:23.373Z",
    });
    const activity = transcriptionActivity({
      id: "activity-2",
      turnId: "turn-2",
      createdAt: "2026-07-24T23:37:27.256Z",
      payload: {
        messageId: "hermes-user:turn-2",
        status: "ready",
        transcript: "Legacy transcript.",
      },
    });

    expect(
      deriveVoiceTranscriptionsByAttachmentId([first, second], [activity]).get("audio-2"),
    ).toEqual({
      status: "ready",
      transcript: "Legacy transcript.",
    });
  });
});

import type {
  ChatAttachment,
  OrchestrationClientCapabilities,
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
  ThreadMessageSentPayload,
} from "@t3tools/contracts";
import {
  deriveVoiceTranscriptionsByAttachmentId,
  readVoiceTranscriptionActivity,
  readVoiceTranscriptionAttachmentId,
  type VoiceTranscriptionState,
} from "@t3tools/shared/voiceTranscription";

const LEGACY_VOICE_NOTE_PLACEHOLDER = "[Voice note]";
const LEGACY_VOICE_NOTE_FAILED_PLACEHOLDER = "[Voice note — transcription failed]";

function supportsAudioAttachments(
  capabilities: OrchestrationClientCapabilities | undefined,
): boolean {
  return capabilities?.audioAttachments === true;
}

function legacyVoiceNoteText(
  attachment: Extract<ChatAttachment, { type: "audio" }>,
  transcription?: VoiceTranscriptionState,
): string {
  const transcript = (transcription?.transcript ?? attachment.transcript)?.trim();
  const status = transcription?.status ?? attachment.transcriptionStatus;
  if (status === "failed") return LEGACY_VOICE_NOTE_FAILED_PLACEHOLDER;
  return transcript ? `[Voice note transcript]\n${transcript}` : LEGACY_VOICE_NOTE_PLACEHOLDER;
}

function projectMessageFields(input: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly transcriptions?: ReadonlyMap<string, VoiceTranscriptionState> | undefined;
}): {
  readonly changed: boolean;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
} {
  const attachments = input.attachments ?? [];
  const audioAttachments = attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { type: "audio" }> =>
      attachment.type === "audio",
  );
  if (audioAttachments.length === 0) {
    return {
      changed: false,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
  }

  const supportedAttachments = attachments.filter((attachment) => attachment.type !== "audio");
  const voiceNoteText = audioAttachments
    .map((attachment) => legacyVoiceNoteText(attachment, input.transcriptions?.get(attachment.id)))
    .join("\n\n");
  const text = input.text.trim().length > 0 ? `${input.text}\n\n${voiceNoteText}` : voiceNoteText;
  return {
    changed: true,
    text,
    ...(supportedAttachments.length > 0 ? { attachments: supportedAttachments } : {}),
  };
}

export function projectOrchestrationMessageForClient(
  message: OrchestrationMessage,
  capabilities: OrchestrationClientCapabilities | undefined,
  transcriptions?: ReadonlyMap<string, VoiceTranscriptionState>,
): OrchestrationMessage {
  if (supportsAudioAttachments(capabilities)) {
    return message;
  }
  const projected = projectMessageFields({ ...message, transcriptions });
  if (!projected.changed) {
    return message;
  }
  const { attachments: _attachments, ...messageWithoutAttachments } = message;
  return {
    ...messageWithoutAttachments,
    text: projected.text,
    ...(projected.attachments ? { attachments: [...projected.attachments] } : {}),
  };
}

function projectThreadMessageEventForClient(
  payload: ThreadMessageSentPayload,
  transcriptions?: ReadonlyMap<string, VoiceTranscriptionState>,
): ThreadMessageSentPayload {
  const projected = projectMessageFields({ ...payload, transcriptions });
  if (!projected.changed) {
    return payload;
  }
  const { attachments: _attachments, ...payloadWithoutAttachments } = payload;
  return {
    ...payloadWithoutAttachments,
    text: projected.text,
    ...(projected.attachments ? { attachments: [...projected.attachments] } : {}),
  };
}

export function projectOrchestrationThreadForClient(
  thread: OrchestrationThread,
  capabilities: OrchestrationClientCapabilities | undefined,
): OrchestrationThread {
  if (supportsAudioAttachments(capabilities)) {
    return thread;
  }
  const transcriptions = deriveVoiceTranscriptionsByAttachmentId(
    thread.messages,
    thread.activities,
  );
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      projectOrchestrationMessageForClient(message, capabilities, transcriptions),
    ),
  };
}

export function projectOrchestrationThreadSnapshotForClient(
  snapshot: OrchestrationThreadDetailSnapshot,
  capabilities: OrchestrationClientCapabilities | undefined,
): OrchestrationThreadDetailSnapshot {
  if (supportsAudioAttachments(capabilities)) {
    return snapshot;
  }
  return {
    ...snapshot,
    thread: projectOrchestrationThreadForClient(snapshot.thread, capabilities),
  };
}

export function projectOrchestrationReadModelForClient(
  snapshot: OrchestrationReadModel,
  capabilities: OrchestrationClientCapabilities | undefined,
): OrchestrationReadModel {
  if (supportsAudioAttachments(capabilities)) {
    return snapshot;
  }
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      projectOrchestrationThreadForClient(thread, capabilities),
    ),
  };
}

export function projectOrchestrationEventForClient(
  event: OrchestrationEvent,
  capabilities: OrchestrationClientCapabilities | undefined,
): OrchestrationEvent {
  if (supportsAudioAttachments(capabilities) || event.type !== "thread.message-sent") {
    return event;
  }
  return {
    ...event,
    payload: projectThreadMessageEventForClient(event.payload),
  };
}

export function projectOrchestrationThreadStreamItemForClient(
  item: OrchestrationThreadStreamItem,
  capabilities: OrchestrationClientCapabilities | undefined,
): OrchestrationThreadStreamItem {
  switch (item.kind) {
    case "synchronized":
      return item;
    case "snapshot":
      return {
        ...item,
        snapshot: projectOrchestrationThreadSnapshotForClient(item.snapshot, capabilities),
      };
    case "event":
      return {
        ...item,
        event: projectOrchestrationEventForClient(item.event, capabilities),
      };
    default:
      item satisfies never;
      return item;
  }
}

interface VoiceMessageState {
  readonly payload: ThreadMessageSentPayload;
  readonly attachmentIds: ReadonlyArray<string>;
}

export function makeOrchestrationThreadStreamProjectorForClient(
  capabilities: OrchestrationClientCapabilities | undefined,
  seedThread?: OrchestrationThread,
): (item: OrchestrationThreadStreamItem) => OrchestrationThreadStreamItem {
  if (supportsAudioAttachments(capabilities)) {
    return (item) => item;
  }

  const messageById = new Map<string, VoiceMessageState>();
  const messageIdByAttachmentId = new Map<string, string>();
  const transcriptions = new Map<string, VoiceTranscriptionState>();

  const registerMessage = (payload: ThreadMessageSentPayload): void => {
    const attachmentIds = (payload.attachments ?? [])
      .filter((attachment) => attachment.type === "audio")
      .map((attachment) => attachment.id);
    if (attachmentIds.length === 0) return;
    const previous = messageById.get(payload.messageId);
    for (const attachmentId of previous?.attachmentIds ?? []) {
      messageIdByAttachmentId.delete(attachmentId);
    }
    messageById.set(payload.messageId, { payload, attachmentIds });
    for (const attachmentId of attachmentIds) {
      messageIdByAttachmentId.set(attachmentId, payload.messageId);
    }
  };

  const seed = (thread: OrchestrationThread): void => {
    for (const [attachmentId, transcription] of deriveVoiceTranscriptionsByAttachmentId(
      thread.messages,
      thread.activities,
    )) {
      transcriptions.set(attachmentId, transcription);
    }
    for (const message of thread.messages) {
      registerMessage({
        threadId: thread.id,
        messageId: message.id,
        role: message.role,
        text: message.text,
        ...(message.attachments ? { attachments: [...message.attachments] } : {}),
        turnId: message.turnId,
        streaming: message.streaming,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      });
    }
  };

  if (seedThread) seed(seedThread);

  return (item) => {
    if (item.kind === "synchronized") return item;
    if (item.kind === "snapshot") {
      seed(item.snapshot.thread);
      return {
        ...item,
        snapshot: projectOrchestrationThreadSnapshotForClient(item.snapshot, capabilities),
      };
    }

    const event = item.event;
    if (event.type === "thread.message-sent") {
      registerMessage(event.payload);
      return {
        ...item,
        event: projectOrchestrationEventForClient(event, capabilities),
      };
    }
    if (event.type !== "thread.activity-appended") {
      return {
        ...item,
        event: projectOrchestrationEventForClient(event, capabilities),
      };
    }

    const transcription = readVoiceTranscriptionActivity(event.payload.activity);
    const explicitAttachmentId = readVoiceTranscriptionAttachmentId(event.payload.activity);
    const fallbackAttachmentId = deriveVoiceTranscriptionsByAttachmentId(
      [...messageById.values()].map(({ payload }) => payload),
      [event.payload.activity],
    )
      .keys()
      .next().value;
    const attachmentId =
      explicitAttachmentId && messageIdByAttachmentId.has(explicitAttachmentId)
        ? explicitAttachmentId
        : fallbackAttachmentId;
    if (!transcription || !attachmentId) return item;
    transcriptions.set(attachmentId, transcription);
    const messageId = messageIdByAttachmentId.get(attachmentId);
    const message = messageId ? messageById.get(messageId) : undefined;
    if (!message) return item;

    return {
      kind: "event",
      event: {
        ...event,
        type: "thread.message-sent",
        payload: {
          ...projectThreadMessageEventForClient(
            {
              ...message.payload,
              updatedAt: event.payload.activity.createdAt,
              replaceText: true,
            },
            transcriptions,
          ),
          replaceText: true,
        },
      },
    };
  };
}

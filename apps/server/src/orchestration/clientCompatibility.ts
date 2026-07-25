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

const LEGACY_VOICE_NOTE_PLACEHOLDER = "[Voice note]";

function supportsAudioAttachments(
  capabilities: OrchestrationClientCapabilities | undefined,
): boolean {
  return capabilities?.audioAttachments === true;
}

function legacyVoiceNoteText(attachment: Extract<ChatAttachment, { type: "audio" }>): string {
  const transcript = attachment.transcript?.trim();
  return transcript ? `[Voice note transcript]\n${transcript}` : LEGACY_VOICE_NOTE_PLACEHOLDER;
}

function projectMessageFields(input: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
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
  const voiceNoteText = audioAttachments.map(legacyVoiceNoteText).join("\n\n");
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
): OrchestrationMessage {
  if (supportsAudioAttachments(capabilities)) {
    return message;
  }
  const projected = projectMessageFields(message);
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
): ThreadMessageSentPayload {
  const projected = projectMessageFields(payload);
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
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      projectOrchestrationMessageForClient(message, capabilities),
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

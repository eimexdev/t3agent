import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import type { ChatMessage } from "./types";

export interface VoiceTranscriptionState {
  readonly status: "transcribing" | "ready" | "failed";
  readonly transcript?: string;
}

interface VoiceAttachmentCandidate {
  readonly attachmentId: string;
  readonly createdAt: string;
  readonly turnId: string | null;
}

function readTranscription(activity: OrchestrationThreadActivity): VoiceTranscriptionState | null {
  if (activity.kind !== "voice-transcription.updated") return null;
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as Record<string, unknown>;
  if (
    payload.status !== "transcribing" &&
    payload.status !== "ready" &&
    payload.status !== "failed"
  ) {
    return null;
  }
  return {
    status: payload.status,
    ...(typeof payload.transcript === "string" ? { transcript: payload.transcript } : {}),
  };
}

function readStringPayload(activity: OrchestrationThreadActivity, key: string): string | undefined {
  if (typeof activity.payload !== "object" || activity.payload === null) return undefined;
  const value = (activity.payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function deriveVoiceTranscriptionsByAttachmentId(
  messages: ReadonlyArray<ChatMessage>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, VoiceTranscriptionState> {
  const candidates: VoiceAttachmentCandidate[] = messages
    .flatMap((message) =>
      (message.attachments ?? []).flatMap((attachment) =>
        attachment.type === "audio"
          ? [
              {
                attachmentId: attachment.id,
                createdAt: message.createdAt,
                turnId: message.turnId,
              },
            ]
          : [],
      ),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const candidateIds = new Set(candidates.map((candidate) => candidate.attachmentId));
  const attachmentIdByTurnId = new Map<string, string>();
  const claimedAttachmentIds = new Set<string>();
  const result = new Map<string, VoiceTranscriptionState>();
  const orderedActivities = activities
    .map((activity, index) => ({ activity, index }))
    .sort(
      (left, right) =>
        left.activity.createdAt.localeCompare(right.activity.createdAt) || left.index - right.index,
    );

  for (const { activity } of orderedActivities) {
    const transcription = readTranscription(activity);
    if (!transcription) continue;
    const explicitAttachmentId =
      readStringPayload(activity, "attachmentId") ?? readStringPayload(activity, "messageId");
    let attachmentId =
      explicitAttachmentId && candidateIds.has(explicitAttachmentId)
        ? explicitAttachmentId
        : undefined;
    const activityTurnId = activity.turnId;
    if (!attachmentId && activityTurnId) {
      attachmentId = attachmentIdByTurnId.get(activityTurnId);
    }
    if (!attachmentId && activityTurnId) {
      attachmentId = candidates.find(
        (candidate) => candidate.turnId === activityTurnId,
      )?.attachmentId;
    }
    if (!attachmentId) {
      attachmentId = candidates.findLast(
        (candidate) =>
          candidate.createdAt <= activity.createdAt &&
          !claimedAttachmentIds.has(candidate.attachmentId),
      )?.attachmentId;
    }
    if (!attachmentId) continue;
    result.set(attachmentId, transcription);
    claimedAttachmentIds.add(attachmentId);
    if (activityTurnId) attachmentIdByTurnId.set(activityTurnId, attachmentId);
  }

  return result;
}

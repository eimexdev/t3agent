import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface VoiceTranscriptionState {
  readonly status: "transcribing" | "ready" | "failed";
  readonly transcript?: string;
}

export interface VoiceTranscriptionMessage {
  readonly attachments?:
    | ReadonlyArray<{
        readonly id: string;
        readonly type: string;
      }>
    | undefined;
  readonly createdAt: string;
  readonly turnId: string | null;
}

interface VoiceAttachmentCandidate {
  readonly attachmentId: string;
  readonly createdAt: string;
  readonly turnId: string | null;
}

export function readVoiceTranscriptionActivity(
  activity: OrchestrationThreadActivity,
): VoiceTranscriptionState | null {
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

export function readVoiceTranscriptionAttachmentId(
  activity: OrchestrationThreadActivity,
): string | undefined {
  if (typeof activity.payload !== "object" || activity.payload === null) return undefined;
  const payload = activity.payload as Record<string, unknown>;
  const attachmentId = payload.attachmentId;
  if (typeof attachmentId === "string" && attachmentId.length > 0) return attachmentId;
  const messageId = payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

export function deriveVoiceTranscriptionsByAttachmentId(
  messages: ReadonlyArray<VoiceTranscriptionMessage>,
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
    const transcription = readVoiceTranscriptionActivity(activity);
    if (!transcription) continue;
    const explicitAttachmentId = readVoiceTranscriptionAttachmentId(activity);
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

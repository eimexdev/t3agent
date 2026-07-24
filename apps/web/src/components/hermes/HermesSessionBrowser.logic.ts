import type {
  HermesBridgeSessionId,
  HermesBridgeSessionSummary,
  ThreadId,
} from "@t3tools/contracts";

export type HermesConversationBrowserMode = "open" | "fork";

export type HermesConversationSelection =
  | {
      readonly type: "open-thread";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "fork-session";
      readonly sessionId: HermesBridgeSessionId;
      readonly forceNew: boolean;
    };

type SelectableHermesSession = Pick<
  HermesBridgeSessionSummary,
  "importedThreadIds" | "sessionId" | "source" | "threadId"
>;

export function resolveHermesConversationSelection(input: {
  readonly mode: HermesConversationBrowserMode;
  readonly session: SelectableHermesSession;
}): HermesConversationSelection {
  if (input.mode === "fork") {
    return {
      type: "fork-session",
      sessionId: input.session.sessionId,
      forceNew: true,
    };
  }

  const existingThreadId =
    input.session.source === "t3agent"
      ? input.session.threadId
      : input.session.importedThreadIds?.[0];
  if (existingThreadId !== undefined) {
    return {
      type: "open-thread",
      threadId: existingThreadId,
    };
  }

  return {
    type: "fork-session",
    sessionId: input.session.sessionId,
    forceNew: false,
  };
}

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

  if (input.session.source === "t3agent" && input.session.threadId !== undefined) {
    return {
      type: "open-thread",
      threadId: input.session.threadId,
    };
  }

  return {
    type: "fork-session",
    sessionId: input.session.sessionId,
    forceNew: false,
  };
}

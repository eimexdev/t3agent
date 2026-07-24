import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { IS_T3_AGENT_MODE } from "../productMode";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

export function useRenameThreadTitle() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const renameHermesConversation = useAtomCommand(serverEnvironment.hermesConversationRename, {
    reportFailure: false,
  });

  return useCallback(
    (threadRef: ScopedThreadRef, title: string) =>
      IS_T3_AGENT_MODE
        ? renameHermesConversation({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, title },
          })
        : updateThreadMetadata({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, title },
          }),
    [renameHermesConversation, updateThreadMetadata],
  );
}

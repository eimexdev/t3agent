import { HermesBridgeSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveHermesConversationSelection } from "./HermesSessionBrowser.logic";

const SESSION_ID = HermesBridgeSessionId.make("session-1");

describe("resolveHermesConversationSelection", () => {
  it("opens the existing T3 Agent thread in open mode", () => {
    expect(
      resolveHermesConversationSelection({
        mode: "open",
        session: {
          sessionId: SESSION_ID,
          source: "t3agent",
          threadId: ThreadId.make("thread-1"),
        },
      }),
    ).toEqual({
      type: "open-thread",
      threadId: "thread-1",
    });
  });

  it("opens an existing imported copy in open mode", () => {
    expect(
      resolveHermesConversationSelection({
        mode: "open",
        session: {
          sessionId: SESSION_ID,
          source: "discord",
          importedThreadIds: [ThreadId.make("imported-thread")],
        },
      }),
    ).toEqual({
      type: "open-thread",
      threadId: "imported-thread",
    });
  });

  it("imports an external conversation with no existing copy in open mode", () => {
    expect(
      resolveHermesConversationSelection({
        mode: "open",
        session: {
          sessionId: SESSION_ID,
          source: "telegram",
        },
      }),
    ).toEqual({
      type: "fork-session",
      sessionId: "session-1",
      forceNew: false,
    });
  });

  it("always creates a new child copy in fork mode", () => {
    expect(
      resolveHermesConversationSelection({
        mode: "fork",
        session: {
          sessionId: SESSION_ID,
          source: "discord",
          importedThreadIds: [ThreadId.make("existing-import")],
        },
      }),
    ).toEqual({
      type: "fork-session",
      sessionId: "session-1",
      forceNew: true,
    });
  });
});

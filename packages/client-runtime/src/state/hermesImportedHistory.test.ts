import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { HERMES_LINEAGE_PREFIX, normalizeImportedHermesHistory } from "./hermesImportedHistory.ts";

const CREATED_AT = "2026-07-06T17:52:27.000Z";

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function lineage(sourceProvider: string): OrchestrationMessage {
  return message(
    `${sourceProvider}-lineage`,
    "system",
    `${HERMES_LINEAGE_PREFIX}${JSON.stringify({
      kind: "import",
      label: `Imported from ${sourceProvider}`,
      sourceProvider,
      sourceSessionId: `${sourceProvider}-source`,
    })}`,
  );
}

describe("normalizeImportedHermesHistory", () => {
  it("drops Telegram tool placeholders without changing user content", () => {
    const messages = [
      message("telegram-user", "user", "Research this event."),
      message("telegram-tool", "assistant", ""),
      message("telegram-answer", "assistant", "Here is the result."),
      lineage("telegram"),
    ];

    const normalized = normalizeImportedHermesHistory(messages);

    expect(normalized.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: MessageId.make("telegram-user"), text: "Research this event." },
      { id: MessageId.make("telegram-answer"), text: "Here is the result." },
      { id: MessageId.make("telegram-lineage"), text: messages[3]?.text },
    ]);
  });

  it("preserves empty assistant rows with attachments and rows after the import boundary", () => {
    const inheritedAttachment = message("inherited-image", "assistant", "", {
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "chart.png",
          mimeType: "image/png",
          sizeBytes: 12,
        },
      ],
    });
    const nativeEmptyAssistant = message("native-empty", "assistant", "");
    const messages = [
      inheritedAttachment,
      message("inherited-tool", "assistant", ""),
      lineage("discord"),
      nativeEmptyAssistant,
    ];

    const normalized = normalizeImportedHermesHistory(messages);

    expect(normalized).toEqual([inheritedAttachment, messages[2], nativeEmptyAssistant]);
  });

  it("simplifies Discord text-document wrappers and removes synthetic delegation results", () => {
    const messages = [
      message(
        "discord-document",
        "user",
        "[Triggering message id: `123` — use as `message_id` for reply/react/pin via the discord tools.]\n\n[The user sent a text document: 'copied-text.txt'. Its content has been included below. The file is also saved at: /home/hermes/.hermes/cache/documents/doc_123_copied-text.txt]\n\n[Parker] [Content of copied-text.txt]:\nUseful notes",
      ),
      message(
        "delegation-result",
        "user",
        "[ASYNC DELEGATION BATCH COMPLETE — deleg_123]\nInternal tool result",
      ),
      lineage("discord"),
    ];

    expect(normalizeImportedHermesHistory(messages).map(({ id, text }) => ({ id, text }))).toEqual([
      {
        id: MessageId.make("discord-document"),
        text: "**Attached:** copied-text.txt\n\n[Content of copied-text.txt]:\nUseful notes",
      },
      {
        id: MessageId.make("discord-lineage"),
        text: messages[2]?.text,
      },
    ]);
  });

  it("returns ordinary and malformed-lineage message collections unchanged", () => {
    const ordinary = [message("ordinary-user", "user", "[Parker] Keep this text.")];
    const malformed = [
      ...ordinary,
      message("bad-lineage", "system", `${HERMES_LINEAGE_PREFIX}{not-json`),
    ];

    expect(normalizeImportedHermesHistory(ordinary)).toBe(ordinary);
    expect(normalizeImportedHermesHistory(malformed)).toBe(malformed);
  });
});

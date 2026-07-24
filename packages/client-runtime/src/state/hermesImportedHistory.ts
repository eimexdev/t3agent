import {
  HermesLineageMetadata,
  type HermesLineageMetadata as LineageMetadata,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HERMES_LINEAGE_PREFIX = "t3agent-lineage:";

const decodeLineage = Schema.decodeUnknownOption(Schema.fromJsonString(HermesLineageMetadata));
const discordTriggeringMessagePrefix = /^\[Triggering message id:[^\r\n]*\]\s*/iu;
const discordTextDocumentPrefix =
  /^\[The user sent a text document: '([^'\r\n]+)'\. Its content has been included below\. The file is also saved at: [^\]\r\n]+\]\s*/iu;
const discordSenderPrefix = /^\[([^\]\r\n:]{1,80})\]\s+/u;
const discordNonSenderLabels = /^(?:async\b|the user\b)/iu;
const hermesAsyncDelegationResultPrefix = /^\[ASYNC DELEGATION BATCH COMPLETE\b/iu;

export function parseHermesLineageMessage(text: string): LineageMetadata | null {
  if (!text.startsWith(HERMES_LINEAGE_PREFIX)) {
    return null;
  }
  return Option.getOrNull(decodeLineage(text.slice(HERMES_LINEAGE_PREFIX.length)));
}

function normalizeImportedUserText(sourceProvider: string, text: string): string {
  if (sourceProvider.trim().toLocaleLowerCase() !== "discord") {
    return text;
  }

  const withoutTrigger = text.replace(discordTriggeringMessagePrefix, "");
  const documentMatch = discordTextDocumentPrefix.exec(withoutTrigger);
  const attachmentLabel = documentMatch?.[1] ? `**Attached:** ${documentMatch[1]}\n\n` : "";
  const body = documentMatch ? withoutTrigger.slice(documentMatch[0].length) : withoutTrigger;
  const senderMatch = discordSenderPrefix.exec(body);
  if (!senderMatch || discordNonSenderLabels.test(senderMatch[1] ?? "")) {
    return `${attachmentLabel}${body}`;
  }
  return `${attachmentLabel}${body.slice(senderMatch[0].length)}`;
}

function isEmptyAssistantPlaceholder(message: OrchestrationMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.streaming &&
    message.text.trim().length === 0 &&
    (message.attachments?.length ?? 0) === 0
  );
}

/**
 * Imported Hermes history is copied verbatim into the child session for model
 * continuity, but its display projection still contains gateway envelopes and
 * contentless assistant rows representing tool calls. Normalize only the
 * inherited prefix before the lineage marker so later T3 Agent turns retain
 * their native content and empty-message semantics.
 */
export function normalizeImportedHermesHistory(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  const lineageIndex = messages.findIndex((message) => {
    if (message.role !== "system") {
      return false;
    }
    return parseHermesLineageMessage(message.text)?.kind === "import";
  });
  if (lineageIndex < 0) {
    return messages;
  }

  const lineageMessage = messages[lineageIndex];
  if (!lineageMessage) {
    return messages;
  }
  const lineage = parseHermesLineageMessage(lineageMessage.text);
  if (lineage === null || lineage.kind !== "import") {
    return messages;
  }

  let changed = false;
  const normalized: Array<OrchestrationMessage> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (index >= lineageIndex) {
      normalized.push(message);
      continue;
    }
    if (isEmptyAssistantPlaceholder(message)) {
      changed = true;
      continue;
    }
    if (message.role === "user" && hermesAsyncDelegationResultPrefix.test(message.text)) {
      changed = true;
      continue;
    }
    if (message.role !== "user") {
      normalized.push(message);
      continue;
    }

    const text = normalizeImportedUserText(lineage.sourceProvider, message.text);
    if (text === message.text) {
      normalized.push(message);
      continue;
    }
    changed = true;
    normalized.push({ ...message, text });
  }

  return changed ? normalized : messages;
}

import { HermesLineageMetadata, type HermesLineageMetadata as Metadata } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HERMES_LINEAGE_PREFIX = "t3agent-lineage:";

const decodeLineage = Schema.decodeUnknownOption(Schema.fromJsonString(HermesLineageMetadata));

export function parseHermesLineageMessage(text: string): Metadata | null {
  if (!text.startsWith(HERMES_LINEAGE_PREFIX)) return null;
  return Option.getOrNull(decodeLineage(text.slice(HERMES_LINEAGE_PREFIX.length)));
}

export function formatHermesSourceLabel(source: string): string {
  const normalized = source.trim().toLocaleLowerCase();
  if (normalized === "t3agent") return "T3 Agent";
  if (normalized === "cli") return "CLI";
  if (normalized === "tui") return "TUI";
  return normalized ? normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1) : "Hermes";
}

export function formatHermesLineageLabel(lineage: Metadata): string {
  return lineage.kind === "import"
    ? `Imported from ${formatHermesSourceLabel(lineage.sourceProvider)}`
    : lineage.label;
}

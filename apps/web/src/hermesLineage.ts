import type { HermesLineageMetadata as Metadata } from "@t3tools/contracts";
export {
  HERMES_LINEAGE_PREFIX,
  parseHermesLineageMessage,
} from "@t3tools/client-runtime/state/hermes-imported-history";

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

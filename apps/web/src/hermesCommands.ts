import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export type T3AgentLifecycleCommand = "new" | "sessions" | "resume" | "fork";

export function parseT3AgentLifecycleCommand(input: string): T3AgentLifecycleCommand | null {
  const match = input.trim().match(/^\/(new|sessions|resume|fork)\s*$/i);
  return match ? (match[1]!.toLocaleLowerCase() as T3AgentLifecycleCommand) : null;
}

export function resolveCommandGhostHint(
  input: string,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): string | null {
  const match = input.match(/^\/([^\s/]+)(\s*)$/);
  if (!match) return null;
  const command = commands.find(
    (candidate) => candidate.name.toLocaleLowerCase() === match[1]!.toLocaleLowerCase(),
  );
  const hint = command?.input?.hint.trim();
  if (!hint) return null;
  return `${match[2]!.length > 0 ? "" : " "}${hint}`;
}

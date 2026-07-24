import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export type T3AgentLifecycleCommand = "new" | "sessions" | "resume" | "fork";

export function parseT3AgentLifecycleCommand(input: string): T3AgentLifecycleCommand | null {
  const match = input.trim().match(/^\/(new|reset|sessions|resume|fork|branch)(?:\s+.*)?$/i);
  const command = match?.[1];
  if (!command) return null;
  switch (command.toLocaleLowerCase()) {
    case "new":
    case "reset":
      return "new";
    case "sessions":
      return "sessions";
    case "resume":
      return "resume";
    case "fork":
    case "branch":
      return "fork";
    default:
      return null;
  }
}

type HintUnit = {
  readonly raw: string;
  readonly atoms: ReadonlyArray<string>;
};

function parseHintUnits(hint: string): ReadonlyArray<HintUnit> {
  const units: string[] = [];
  let current = "";
  let squareDepth = 0;
  let angleDepth = 0;

  for (const character of hint.trim()) {
    if (/\s/.test(character) && squareDepth === 0 && angleDepth === 0) {
      if (current) {
        units.push(current);
        current = "";
      }
      continue;
    }

    current += character;
    if (character === "[") squareDepth += 1;
    if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    if (character === "<") angleDepth += 1;
    if (character === ">") angleDepth = Math.max(0, angleDepth - 1);
  }
  if (current) units.push(current);

  return units.map((raw) => {
    const body =
      (raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("<") && raw.endsWith(">"))
        ? raw.slice(1, -1)
        : raw;
    return {
      raw,
      atoms: body.split(/\s+/).filter(Boolean),
    };
  });
}

function renderHintFrom(
  units: ReadonlyArray<HintUnit>,
  unitIndex: number,
  atomIndex: number,
): string | null {
  const unit = units[unitIndex];
  if (!unit) return null;

  const current = atomIndex === 0 ? unit.raw : unit.atoms.slice(atomIndex).join(" ");
  const remaining = units.slice(unitIndex + 1).map((candidate) => candidate.raw);
  return [current, ...remaining].filter(Boolean).join(" ") || null;
}

function findAtomPosition(
  units: ReadonlyArray<HintUnit>,
  targetIndex: number,
): { readonly unitIndex: number; readonly atomIndex: number } | null {
  let visited = 0;
  for (const [unitIndex, unit] of units.entries()) {
    if (targetIndex < visited + unit.atoms.length) {
      return { unitIndex, atomIndex: targetIndex - visited };
    }
    visited += unit.atoms.length;
  }
  return null;
}

function resolveAtomCompletion(atom: string, input: string): string | null {
  const alternatives = atom.split("|");
  const matches = alternatives.filter((candidate) =>
    candidate.toLocaleLowerCase().startsWith(input.toLocaleLowerCase()),
  );
  if (matches.length !== 1) return null;
  const match = matches[0];
  return match ? match.slice(input.length) : null;
}

export function resolveCommandGhostHint(
  input: string,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): string | null {
  const match = input.match(/^\/([^\s/]+)([ \t]*)([^\r\n]*)$/);
  if (!match) return null;
  const [, rawCommand, commandSpacing = "", argumentText = ""] = match;
  if (!rawCommand) return null;
  const command = commands.find(
    (candidate) => candidate.name.toLocaleLowerCase() === rawCommand.toLocaleLowerCase(),
  );
  const hint = command?.input?.hint.trim();
  if (!hint) return null;

  if (!commandSpacing && !argumentText) return ` ${hint}`;

  const units = parseHintUnits(hint);
  const trimmedArguments = argumentText.trim();
  if (!trimmedArguments) return hint;

  const argumentAtoms = trimmedArguments.split(/\s+/);
  const endsWithWhitespace = /[ \t]$/.test(argumentText);
  const targetIndex = endsWithWhitespace ? argumentAtoms.length : argumentAtoms.length - 1;
  const position = findAtomPosition(units, targetIndex);
  if (!position) return null;

  if (endsWithWhitespace) {
    return renderHintFrom(units, position.unitIndex, position.atomIndex);
  }

  const currentInput = argumentAtoms.at(-1);
  const currentUnit = units[position.unitIndex];
  const currentAtom = currentUnit?.atoms[position.atomIndex];
  if (currentInput === undefined || currentAtom === undefined) return null;
  const completion = resolveAtomCompletion(currentAtom, currentInput);
  const nextPosition = findAtomPosition(units, targetIndex + 1);
  const remaining = nextPosition
    ? renderHintFrom(units, nextPosition.unitIndex, nextPosition.atomIndex)
    : null;

  if (completion) {
    return `${completion}${remaining ? ` ${remaining}` : ""}`;
  }
  if (completion === "") {
    return remaining ? ` ${remaining}` : null;
  }
  return remaining ? ` ${remaining}` : null;
}

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

export interface ThreadRenameFailureMessage {
  readonly title: string;
  readonly description: string;
}

export function describeThreadRenameFailure(
  result: AtomCommandResult<unknown, unknown>,
): ThreadRenameFailureMessage | null {
  if (result._tag !== "Failure") {
    return null;
  }
  if (isAtomCommandInterrupted(result)) {
    return {
      title: "Thread rename interrupted",
      description: "The connection changed before Hermes confirmed the new title. Try again.",
    };
  }
  const error = squashAtomCommandFailure(result);
  return {
    title: "Failed to rename thread",
    description: error instanceof Error ? error.message : "An error occurred.",
  };
}

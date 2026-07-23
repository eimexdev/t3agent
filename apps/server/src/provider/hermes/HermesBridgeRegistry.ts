import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderAdapterError } from "../Errors.ts";
import type { HermesBridgeClient } from "./HermesBridgeClient.ts";

export class HermesBridgeRegistryError extends Schema.TaggedErrorClass<HermesBridgeRegistryError>()(
  "HermesBridgeRegistryError",
  {
    operation: Schema.Literals(["lookup", "authenticate", "receive"]),
    instanceId: Schema.String,
    detail: Schema.String,
  },
) {}

export interface HermesBridgeReceiver {
  readonly token: string;
  readonly receive: (payload: unknown) => Effect.Effect<unknown, ProviderAdapterError>;
  readonly client?: Pick<HermesBridgeClient, "listSessions" | "forkSession">;
}

const receivers = new Map<ProviderInstanceId, HermesBridgeReceiver>();

function constantTimeEqual(left: string, right: string): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export const register = (instanceId: ProviderInstanceId, receiver: HermesBridgeReceiver) =>
  Effect.sync(() => {
    receivers.set(instanceId, receiver);
  });

export const unregister = (instanceId: ProviderInstanceId) =>
  Effect.sync(() => {
    receivers.delete(instanceId);
  });

export const getClient = (
  instanceId: ProviderInstanceId,
): Effect.Effect<
  Pick<HermesBridgeClient, "listSessions" | "forkSession">,
  HermesBridgeRegistryError
> =>
  Effect.suspend(() => {
    const receiver = receivers.get(instanceId);
    return receiver?.client
      ? Effect.succeed(receiver.client)
      : Effect.fail(
          new HermesBridgeRegistryError({
            operation: "lookup",
            instanceId,
            detail: receiver
              ? "Hermes provider lifecycle client is unavailable."
              : "Hermes provider instance is not registered.",
          }),
        );
  });

export const receive = (
  instanceId: ProviderInstanceId,
  token: string,
  payload: unknown,
): Effect.Effect<unknown, HermesBridgeRegistryError> =>
  Effect.suspend(() => {
    const receiver = receivers.get(instanceId);
    if (!receiver) {
      return Effect.fail(
        new HermesBridgeRegistryError({
          operation: "lookup",
          instanceId,
          detail: "Hermes provider instance is not registered.",
        }),
      );
    }
    if (!receiver.token || !constantTimeEqual(receiver.token, token)) {
      return Effect.fail(
        new HermesBridgeRegistryError({
          operation: "authenticate",
          instanceId,
          detail: "Invalid bridge credential.",
        }),
      );
    }
    return receiver.receive(payload).pipe(
      Effect.mapError(
        (cause) =>
          new HermesBridgeRegistryError({
            operation: "receive",
            instanceId,
            detail: cause.message,
          }),
      ),
    );
  });

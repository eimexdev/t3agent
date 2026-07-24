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
  readonly client?: Pick<HermesBridgeClient, "listSessions" | "forkSession" | "deleteSession">;
}

export interface HermesBridgeRegistration {
  readonly instanceId: ProviderInstanceId;
  readonly receiver: HermesBridgeReceiver;
}

const registrations = new Map<ProviderInstanceId, HermesBridgeRegistration>();

function constantTimeEqual(left: string, right: string): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export const register = Effect.fn("HermesBridgeRegistry.register")(function* (
  instanceId: ProviderInstanceId,
  receiver: HermesBridgeReceiver,
): Effect.fn.Return<HermesBridgeRegistration> {
  const registration = { instanceId, receiver } satisfies HermesBridgeRegistration;
  yield* Effect.sync(() => {
    registrations.set(instanceId, registration);
  });
  return registration;
});

export const unregister = Effect.fn("HermesBridgeRegistry.unregister")(function* (
  registration: HermesBridgeRegistration,
): Effect.fn.Return<void> {
  yield* Effect.sync(() => {
    if (registrations.get(registration.instanceId) === registration) {
      registrations.delete(registration.instanceId);
    }
  });
});

export const getClient = Effect.fn("HermesBridgeRegistry.getClient")(function* (
  instanceId: ProviderInstanceId,
): Effect.fn.Return<
  Pick<HermesBridgeClient, "listSessions" | "forkSession" | "deleteSession">,
  HermesBridgeRegistryError
> {
  const receiver = registrations.get(instanceId)?.receiver;
  if (receiver?.client) {
    return receiver.client;
  }
  return yield* new HermesBridgeRegistryError({
    operation: "lookup",
    instanceId,
    detail: receiver
      ? "Hermes provider lifecycle client is unavailable."
      : "Hermes provider instance is not registered.",
  });
});

export const receive = Effect.fn("HermesBridgeRegistry.receive")(function* (
  instanceId: ProviderInstanceId,
  token: string,
  payload: unknown,
): Effect.fn.Return<unknown, HermesBridgeRegistryError> {
  const receiver = registrations.get(instanceId)?.receiver;
  if (!receiver) {
    return yield* new HermesBridgeRegistryError({
      operation: "lookup",
      instanceId,
      detail: "Hermes provider instance is not registered.",
    });
  }
  if (!receiver.token || !constantTimeEqual(receiver.token, token)) {
    return yield* new HermesBridgeRegistryError({
      operation: "authenticate",
      instanceId,
      detail: "Invalid bridge credential.",
    });
  }
  return yield* receiver.receive(payload).pipe(
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

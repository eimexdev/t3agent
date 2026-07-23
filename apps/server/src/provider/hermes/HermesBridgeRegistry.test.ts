import { assert, describe, it, vi } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  HermesBridgeRegistryError,
  receive,
  register,
  unregister,
} from "./HermesBridgeRegistry.ts";

describe("HermesBridgeRegistry", () => {
  it.effect("propagates the authenticated payload and receiver result", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_propagation");
    const payload = { type: "typing.set", deliveryId: "delivery-1" };
    const receiver = vi.fn((received: unknown) => Effect.succeed({ accepted: true, received }));

    return Effect.gen(function* () {
      yield* register(instanceId, { token: "correct-token", receive: receiver });
      const result = yield* receive(instanceId, "correct-token", payload);

      assert.deepStrictEqual(result, { accepted: true, received: payload });
      assert.strictEqual(receiver.mock.calls.length, 1);
      assert.strictEqual(receiver.mock.calls[0]![0], payload);
    }).pipe(Effect.ensuring(unregister(instanceId)));
  });

  it.effect("rejects an incorrect token without invoking the receiver", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_auth");
    const receiver = vi.fn(() => Effect.succeed("should-not-run"));

    return Effect.gen(function* () {
      yield* register(instanceId, { token: "correct-token", receive: receiver });
      const result = yield* Effect.result(receive(instanceId, "incorrect-token", {}));
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      const error = result.failure;

      assert.instanceOf(error, HermesBridgeRegistryError);
      assert.strictEqual(error.operation, "authenticate");
      assert.strictEqual(receiver.mock.calls.length, 0);
    }).pipe(Effect.ensuring(unregister(instanceId)));
  });

  it.effect("rejects an empty configured token", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_empty_token");
    const receiver = vi.fn(() => Effect.succeed("should-not-run"));

    return Effect.gen(function* () {
      yield* register(instanceId, { token: "", receive: receiver });
      const result = yield* Effect.result(receive(instanceId, "", {}));
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      const error = result.failure;

      assert.strictEqual(error.operation, "authenticate");
      assert.strictEqual(receiver.mock.calls.length, 0);
    }).pipe(Effect.ensuring(unregister(instanceId)));
  });

  it.effect("reports unknown instances and unregistered instances as lookup failures", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_lifecycle");
    const receiver = vi.fn(() => Effect.succeed("received"));

    return Effect.gen(function* () {
      const unknownResult = yield* Effect.result(receive(instanceId, "token", {}));
      assert.isTrue(Result.isFailure(unknownResult));
      if (Result.isSuccess(unknownResult)) return;
      const unknownError = unknownResult.failure;
      assert.strictEqual(unknownError.operation, "lookup");

      yield* register(instanceId, { token: "token", receive: receiver });
      assert.strictEqual(yield* receive(instanceId, "token", {}), "received");
      yield* unregister(instanceId);

      const unregisteredResult = yield* Effect.result(receive(instanceId, "token", {}));
      assert.isTrue(Result.isFailure(unregisteredResult));
      if (Result.isSuccess(unregisteredResult)) return;
      const unregisteredError = unregisteredResult.failure;
      assert.strictEqual(unregisteredError.operation, "lookup");
      assert.strictEqual(receiver.mock.calls.length, 1);
    }).pipe(Effect.ensuring(unregister(instanceId)));
  });

  it.effect("wraps receiver failures without exposing them as authentication errors", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_receiver_error");
    const receiverError = new ProviderAdapterRequestError({
      provider: "hermes",
      method: "message.send",
      detail: "Callback was invalid.",
    });

    return Effect.gen(function* () {
      yield* register(instanceId, {
        token: "token",
        receive: () => Effect.fail(receiverError),
      });
      const result = yield* Effect.result(receive(instanceId, "token", {}));
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      const error = result.failure;

      assert.instanceOf(error, HermesBridgeRegistryError);
      assert.strictEqual(error.operation, "receive");
      assert.strictEqual(error.detail, receiverError.message);
    }).pipe(Effect.ensuring(unregister(instanceId)));
  });
});

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

    return Effect.acquireUseRelease(
      register(instanceId, { token: "correct-token", receive: receiver }),
      () =>
        Effect.gen(function* () {
          const result = yield* receive(instanceId, "correct-token", payload);

          assert.deepStrictEqual(result, { accepted: true, received: payload });
          assert.strictEqual(receiver.mock.calls.length, 1);
          assert.strictEqual(receiver.mock.calls[0]![0], payload);
        }),
      unregister,
    );
  });

  it.effect("rejects an incorrect token without invoking the receiver", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_auth");
    const receiver = vi.fn(() => Effect.succeed("should-not-run"));

    return Effect.acquireUseRelease(
      register(instanceId, { token: "correct-token", receive: receiver }),
      () =>
        Effect.gen(function* () {
          const result = yield* Effect.result(receive(instanceId, "incorrect-token", {}));
          assert.isTrue(Result.isFailure(result));
          if (Result.isSuccess(result)) return;
          const error = result.failure;

          assert.instanceOf(error, HermesBridgeRegistryError);
          assert.strictEqual(error.operation, "authenticate");
          assert.strictEqual(receiver.mock.calls.length, 0);
        }),
      unregister,
    );
  });

  it.effect("rejects an empty configured token", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_empty_token");
    const receiver = vi.fn(() => Effect.succeed("should-not-run"));

    return Effect.acquireUseRelease(
      register(instanceId, { token: "", receive: receiver }),
      () =>
        Effect.gen(function* () {
          const result = yield* Effect.result(receive(instanceId, "", {}));
          assert.isTrue(Result.isFailure(result));
          if (Result.isSuccess(result)) return;
          const error = result.failure;

          assert.strictEqual(error.operation, "authenticate");
          assert.strictEqual(receiver.mock.calls.length, 0);
        }),
      unregister,
    );
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

      assert.strictEqual(
        yield* Effect.acquireUseRelease(
          register(instanceId, { token: "token", receive: receiver }),
          () => receive(instanceId, "token", {}),
          unregister,
        ),
        "received",
      );

      const unregisteredResult = yield* Effect.result(receive(instanceId, "token", {}));
      assert.isTrue(Result.isFailure(unregisteredResult));
      if (Result.isSuccess(unregisteredResult)) return;
      const unregisteredError = unregisteredResult.failure;
      assert.strictEqual(unregisteredError.operation, "lookup");
      assert.strictEqual(receiver.mock.calls.length, 1);
    });
  });

  it.effect("wraps receiver failures without exposing them as authentication errors", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_receiver_error");
    const receiverError = new ProviderAdapterRequestError({
      provider: "hermes",
      method: "message.send",
      detail: "Callback was invalid.",
    });

    return Effect.acquireUseRelease(
      register(instanceId, {
        token: "token",
        receive: () => Effect.fail(receiverError),
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* Effect.result(receive(instanceId, "token", {}));
          assert.isTrue(Result.isFailure(result));
          if (Result.isSuccess(result)) return;
          const error = result.failure;

          assert.instanceOf(error, HermesBridgeRegistryError);
          assert.strictEqual(error.operation, "receive");
          assert.strictEqual(error.detail, receiverError.message);
        }),
      unregister,
    );
  });

  it.effect("does not let a stale owner unregister its replacement", () => {
    const instanceId = ProviderInstanceId.make("hermes_registry_replacement");
    const oldReceiver = vi.fn(() => Effect.succeed("old"));
    const newReceiver = vi.fn(() => Effect.succeed("new"));

    return Effect.acquireUseRelease(
      register(instanceId, { token: "old-token", receive: oldReceiver }),
      (oldRegistration) =>
        Effect.acquireUseRelease(
          register(instanceId, { token: "new-token", receive: newReceiver }),
          () =>
            Effect.gen(function* () {
              yield* unregister(oldRegistration);

              assert.strictEqual(yield* receive(instanceId, "new-token", {}), "new");
              assert.strictEqual(oldReceiver.mock.calls.length, 0);
              assert.strictEqual(newReceiver.mock.calls.length, 1);
            }),
          unregister,
        ),
      unregister,
    );
  });
});

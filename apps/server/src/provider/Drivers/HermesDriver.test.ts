import { assert, it } from "@effect/vitest";
import { HermesBridgeRequestId, ProviderInstanceId } from "@t3tools/contracts";

import { makeHermesProviderSnapshot } from "./HermesDriver.ts";

it("surfaces the active Hermes identity and canonical commands plus aliases", () => {
  const snapshot = makeHermesProviderSnapshot({
    instanceId: ProviderInstanceId.make("hermes"),
    displayName: undefined,
    accentColor: undefined,
    enabled: true,
    checkedAt: "2026-07-22T00:00:00.000Z",
    capabilities: {
      protocolVersion: 1,
      requestId: HermesBridgeRequestId.make("capabilities"),
      capabilities: {
        asynchronousDelivery: true,
        imageAttachments: true,
        interrupts: true,
        approvals: true,
        clarifications: true,
        slashConfirmations: true,
        threadCreation: true,
        commandCatalog: true,
      },
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      profile: "default",
      commands: [
        {
          name: "new",
          description: "Start a new conversation",
          inputHint: "[name]",
          aliases: ["reset"],
        },
      ],
    },
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.auth.label, "default");
  assert.deepEqual(snapshot.models, [
    {
      slug: "anthropic/claude-sonnet-4",
      name: "anthropic/claude-sonnet-4",
      subProvider: "openrouter",
      isCustom: true,
      isDefault: true,
      capabilities: null,
    },
  ]);
  assert.deepEqual(
    snapshot.slashCommands.map(({ name }) => name),
    ["new", "reset"],
  );
});

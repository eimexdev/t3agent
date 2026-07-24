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
      reasoningEffort: "high",
      models: [
        {
          provider: "openrouter",
          slug: "anthropic/claude-sonnet-4",
          isDefault: true,
          reasoningEfforts: ["none", "medium", "high"],
          defaultReasoningEffort: "medium",
        },
        {
          provider: "openai-codex",
          slug: "gpt-5.6-sol",
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        },
      ],
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
      slug: "openrouter::anthropic/claude-sonnet-4",
      name: "anthropic/claude-sonnet-4",
      subProvider: "openrouter",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "reset", label: "Default (High)", isDefault: true },
              { id: "none", label: "None" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
            currentValue: "reset",
          },
        ],
      },
    },
    {
      slug: "openai-codex::gpt-5.6-sol",
      name: "gpt-5.6-sol",
      subProvider: "openai-codex",
      isCustom: false,
      isDefault: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "reset", label: "Default (High)", isDefault: true },
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
            currentValue: "reset",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(
    snapshot.slashCommands.map(({ name }) => name),
    ["new", "reset", "sessions", "resume", "fork", "branch"],
  );
  assert.equal(snapshot.slashCommands[0]?.input, undefined);
});

it("does not invent a model inventory while the Hermes bridge is unavailable", () => {
  const snapshot = makeHermesProviderSnapshot({
    instanceId: ProviderInstanceId.make("hermes"),
    displayName: undefined,
    accentColor: undefined,
    enabled: true,
    error: "Hermes bridge is unavailable.",
    checkedAt: "2026-07-22T00:00:00.000Z",
  });

  assert.equal(snapshot.status, "error");
  assert.deepEqual(snapshot.models, []);
});

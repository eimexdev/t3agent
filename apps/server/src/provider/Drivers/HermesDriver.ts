import {
  HermesSettings,
  ProviderDriverKind,
  TextGenerationError,
  type HermesBridgeCapabilitiesResponse,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeHermesBridgeClient } from "../hermes/HermesBridgeClient.ts";
import * as HermesBridgeRegistry from "../hermes/HermesBridgeRegistry.ts";
import { encodeHermesModelSlug } from "../hermes/HermesModel.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const decodeSettings = Schema.decodeSync(HermesSettings);

function reasoningLabel(value: string): string {
  return value === "none" ? "None" : value.charAt(0).toUpperCase() + value.slice(1);
}

export function makeHermesProviderSnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly capabilities?: HermesBridgeCapabilitiesResponse;
  readonly error?: string;
  readonly checkedAt: string;
}): ServerProvider {
  const activeModel = input.capabilities?.model?.trim() || "active";
  const activeProvider = input.capabilities?.provider?.trim();
  const inventory = input.capabilities?.models ?? [];
  const models =
    inventory.length > 0
      ? inventory.map((model) => {
          const reasoningEfforts = model.reasoningEfforts ?? [];
          return {
            slug: encodeHermesModelSlug(model.provider, model.slug),
            name: model.name ?? model.slug,
            subProvider: model.provider,
            isCustom: true,
            isDefault:
              model.isDefault === true ||
              (model.provider === activeProvider && model.slug === activeModel),
            capabilities:
              reasoningEfforts.length > 0
                ? {
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select" as const,
                        options: reasoningEfforts.map((effort) => ({
                          id: effort,
                          label: reasoningLabel(effort),
                          ...(effort === model.defaultReasoningEffort ? { isDefault: true } : {}),
                        })),
                        ...(model.provider === activeProvider &&
                        model.slug === activeModel &&
                        input.capabilities?.reasoningEffort
                          ? { currentValue: input.capabilities.reasoningEffort }
                          : model.defaultReasoningEffort
                            ? { currentValue: model.defaultReasoningEffort }
                            : {}),
                      },
                    ],
                  }
                : null,
          };
        })
      : [
          {
            slug: activeProvider ? encodeHermesModelSlug(activeProvider, activeModel) : activeModel,
            name: activeModel === "active" ? "Active Hermes model" : activeModel,
            ...(activeProvider ? { subProvider: activeProvider } : {}),
            isCustom: true,
            isDefault: true,
            capabilities: null,
          },
        ];
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? "Hermes",
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    badgeLabel: "Agent",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: true,
    version: null,
    status: input.enabled ? (input.error ? "error" : "ready") : "disabled",
    auth: {
      status: input.error ? "unknown" : "authenticated",
      type: "local-bridge",
      ...(input.capabilities?.profile ? { label: input.capabilities.profile } : {}),
    },
    checkedAt: input.checkedAt,
    ...(input.error ? { message: input.error } : {}),
    availability: "available",
    models,
    slashCommands: (input.capabilities?.commands ?? []).flatMap((command) =>
      [command.name, ...(command.aliases ?? [])].map((name) => ({
        name: name.replace(/^\/+/, ""),
        ...(command.description ? { description: command.description } : {}),
        ...(command.inputHint ? { input: { hint: command.inputHint } } : {}),
      })),
    ),
    skills: [],
    continuation: { groupKey: `hermes:instance:${input.instanceId}` },
  };
}

const unsupportedTextGeneration = {
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Hermes is a conversation gateway and does not generate T3 git metadata.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail: "Hermes is a conversation gateway and does not generate T3 git metadata.",
      }),
    ),
  generateBranchName: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "Hermes conversations are not project branches.",
      }),
    ),
  generateThreadTitle: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Hermes thread titles are owned by the gateway conversation.",
      }),
    ),
};

export type HermesDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("HermesDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
    config,
  }: ProviderDriverCreateInput<HermesSettings>) {
    const httpClient = yield* HttpClient.HttpClient;
    const client = makeHermesBridgeClient({
      baseUrl: config.bridgeUrl,
      token: config.ingressToken,
      httpClient,
    });
    const adapter = yield* makeHermesAdapter({ instanceId, client });
    yield* HermesBridgeRegistry.register(instanceId, {
      token: config.callbackToken,
      receive: adapter.receiveCallback,
    });
    yield* Effect.addFinalizer(() => HermesBridgeRegistry.unregister(instanceId));

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const initial = makeHermesProviderSnapshot({
      instanceId,
      displayName,
      accentColor,
      enabled,
      error:
        config.ingressToken && config.callbackToken
          ? "Waiting for the Hermes T3 Agent plugin."
          : "Configure both Hermes bridge tokens.",
      checkedAt,
    });
    const snapshotRef = yield* Ref.make(initial);
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const refresh = client.getCapabilities.pipe(
      Effect.matchEffect({
        onFailure: Effect.fn("HermesDriver.refreshFailure")(function* () {
          const next = makeHermesProviderSnapshot({
            instanceId,
            displayName,
            accentColor,
            enabled,
            error: "Hermes bridge is unavailable.",
            checkedAt: DateTime.formatIso(yield* DateTime.now),
          });
          yield* Ref.set(snapshotRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
        onSuccess: Effect.fn("HermesDriver.refreshSuccess")(function* (
          capabilities: HermesBridgeCapabilitiesResponse,
        ) {
          const next = makeHermesProviderSnapshot({
            instanceId,
            displayName,
            accentColor,
            enabled,
            capabilities,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
          });
          yield* Ref.set(snapshotRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      }),
    );
    if (enabled && config.ingressToken && config.callbackToken) {
      yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(refresh))).pipe(
        Effect.forkScoped,
      );
      yield* refresh.pipe(Effect.forkScoped);
    }

    const snapshot: ServerProviderShape = {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      }),
      getSnapshot: Ref.get(snapshotRef),
      refresh,
      streamChanges: Stream.fromPubSub(changes),
    };
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      adapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};

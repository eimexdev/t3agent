import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeRequestId,
  HermesBridgeSessionId,
  HermesLineageMetadata,
  HermesLifecycleError,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type HermesBridgeSessionListResponse,
  type HermesBridgeSessionForkResponse,
  type HermesConversationForkInput,
  type HermesConversationForkResult,
  type OrchestrationCommand,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { HermesBridgeClient } from "./HermesBridgeClient.ts";
import { encodeHermesModelSlug } from "./HermesModel.ts";

const HERMES_INSTANCE_ID = ProviderInstanceId.make("hermes");
const isHermesLifecycleError = Schema.is(HermesLifecycleError);
const encodeLineage = Schema.encodeEffect(Schema.fromJsonString(HermesLineageMetadata));

interface LifecycleSnapshot {
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly deletedAt: string | null;
  }>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title?: string;
    readonly deletedAt: string | null;
  }>;
}

interface LifecycleProvider {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

export interface HermesConversationLifecycleDependencies {
  readonly getClient: () => Effect.Effect<
    Pick<HermesBridgeClient, "listSessions" | "forkSession" | "deleteSession">,
    Error
  >;
  readonly getSnapshot: () => Effect.Effect<LifecycleSnapshot, Error>;
  readonly getProviders: Effect.Effect<ReadonlyArray<LifecycleProvider>, Error>;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, Error>;
  readonly randomUuid: Effect.Effect<string, Error>;
  readonly nowIso: Effect.Effect<string, Error>;
}

export interface HermesConversationLifecycle {
  readonly listSessions: Effect.Effect<HermesBridgeSessionListResponse, HermesLifecycleError>;
  readonly forkConversation: (
    input: HermesConversationForkInput,
  ) => Effect.Effect<HermesConversationForkResult, HermesLifecycleError>;
}

type LifecycleOperation = HermesLifecycleError["operation"];

interface LifecycleErrorContext {
  readonly sourceSessionId?: HermesLifecycleError["sourceSessionId"];
  readonly sourceThreadId?: HermesLifecycleError["sourceThreadId"];
}

function sourceContext(input: HermesConversationForkInput): LifecycleErrorContext {
  return input.source.type === "session"
    ? { sourceSessionId: input.source.sessionId }
    : { sourceThreadId: input.source.threadId };
}

function lifecycleError(
  operation: LifecycleOperation,
  cause: unknown,
  fallback: string,
  context: LifecycleErrorContext = {},
): HermesLifecycleError {
  if (isHermesLifecycleError(cause)) {
    return cause;
  }
  const detail =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : undefined;
  return new HermesLifecycleError({
    operation,
    message: detail ?? fallback,
    ...(detail !== undefined ? { detail } : {}),
    ...context,
  });
}

export function makeHermesConversationLifecycle(
  dependencies: HermesConversationLifecycleDependencies,
): HermesConversationLifecycle {
  const forkLock = Semaphore.makeUnsafe(1);
  const nextCommandId = Effect.fn("HermesConversationLifecycle.nextCommandId")(function* (
    tag: string,
  ) {
    const uuid = yield* dependencies.randomUuid;
    return CommandId.make(`server:${tag}:${uuid}`);
  });

  const deleteThread = Effect.fn("HermesConversationLifecycle.deleteThread")(function* (
    threadId: ThreadId,
  ) {
    yield* dependencies
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`server:hermes-conversation-fork-cleanup:${threadId}`),
        threadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const importHistory = Effect.fn("HermesConversationLifecycle.importHistory")(function* (
    threadId: ThreadId,
    fork: HermesBridgeSessionForkResponse,
  ) {
    for (const [index, message] of fork.messages.entries()) {
      yield* dependencies.dispatch({
        type: "thread.message.import",
        commandId: yield* nextCommandId(`hermes-history-${index}`),
        threadId,
        messageId: MessageId.make(`hermes-history:${fork.childSessionId}:${index}`),
        role: message.role,
        text: message.content,
        ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
        createdAt: message.createdAt,
      });
    }
    for (const activity of fork.activities ?? []) {
      yield* dependencies.dispatch({
        type: "thread.activity.append",
        commandId: yield* nextCommandId(`hermes-activity-${activity.id}`),
        threadId,
        activity,
        createdAt: activity.createdAt,
      });
    }
  });

  const listSessions = Effect.gen(function* () {
    const client = yield* dependencies.getClient();
    const [response, snapshot] = yield* Effect.all([
      client.listSessions,
      dependencies.getSnapshot(),
    ]);
    const liveThreadIds = new Set(
      snapshot.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
    );
    return {
      ...response,
      sessions: response.sessions.map((session) => {
        const { threadId, importedThreadIds, ...metadata } = session;
        return {
          ...metadata,
          ...(threadId && liveThreadIds.has(threadId) ? { threadId } : {}),
          ...(importedThreadIds
            ? {
                importedThreadIds: importedThreadIds.filter((candidate) =>
                  liveThreadIds.has(candidate),
                ),
              }
            : {}),
        };
      }),
    };
  }).pipe(
    Effect.withSpan("HermesConversationLifecycle.listSessions"),
    Effect.mapError((cause) =>
      lifecycleError("sessions.list", cause, "Unable to load Hermes sessions."),
    ),
  );

  const forkConversation = Effect.fn("HermesConversationLifecycle.forkConversation")(
    function* (input: HermesConversationForkInput) {
      const client = yield* dependencies.getClient();
      const [sessions, snapshot] = yield* Effect.all([
        client.listSessions,
        dependencies.getSnapshot(),
      ]);
      const source =
        input.source.type === "session"
          ? (() => {
              const sourceSessionId = input.source.sessionId;
              return sessions.sessions.find((session) => session.sessionId === sourceSessionId);
            })()
          : (() => {
              const sourceThreadId = input.source.threadId;
              return sessions.sessions.find((session) => session.threadId === sourceThreadId);
            })();
      if (!source) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "The source Hermes session is no longer available.",
          ...sourceContext(input),
        });
      }

      const existingThreadId = source.importedThreadIds?.find((threadId) =>
        snapshot.threads.some((thread) => thread.id === threadId && thread.deletedAt === null),
      );
      if (
        input.forceNew !== true &&
        source.source !== "t3agent" &&
        existingThreadId !== undefined
      ) {
        const childSessionId = HermesBridgeSessionId.make(`t3-${existingThreadId}`);
        const fork = yield* client
          .forkSession({
            protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
            requestId: HermesBridgeRequestId.make(
              `conversation-refresh:${source.sessionId}:${existingThreadId}`,
            ),
            type: "session.fork",
            sourceSessionId: source.sessionId,
            childSessionId,
            targetThreadId: existingThreadId,
            ...(input.userTurnCount !== undefined ? { userTurnCount: input.userTurnCount } : {}),
          })
          .pipe(Effect.retry({ times: 1 }));
        yield* importHistory(existingThreadId, fork);
        return {
          threadId: existingThreadId,
          existing: true,
        };
      }

      const project = snapshot.projects.find((candidate) => candidate.deletedAt === null);
      if (!project) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "T3 Agent's internal conversation workspace is unavailable.",
          ...sourceContext(input),
        });
      }

      const providers = yield* dependencies.getProviders;
      const hermesProvider = providers.find(
        (provider) => provider.instanceId === HERMES_INSTANCE_ID,
      );
      const defaultModel =
        hermesProvider?.models.find((model) => model.isDefault) ?? hermesProvider?.models[0];
      if (!defaultModel) {
        return yield* new HermesLifecycleError({
          operation: "conversation.fork",
          message: "Hermes has not reported an available model.",
          ...sourceContext(input),
        });
      }

      const threadId = ThreadId.make(yield* dependencies.randomUuid);
      const childSessionId = HermesBridgeSessionId.make(`t3-${threadId}`);
      const createdAt = yield* dependencies.nowIso;
      const forkRequest = {
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: HermesBridgeRequestId.make(`conversation-fork:${source.sessionId}:${threadId}`),
        type: "session.fork" as const,
        sourceSessionId: source.sessionId,
        childSessionId,
        targetThreadId: threadId,
        ...(input.userTurnCount !== undefined ? { userTurnCount: input.userTurnCount } : {}),
      };
      const deleteChildSession = Effect.fn("HermesConversationLifecycle.deleteChildSession")(
        function* () {
          yield* client
            .deleteSession({
              protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
              requestId: HermesBridgeRequestId.make(
                `conversation-fork-cleanup:${childSessionId}:${threadId}`,
              ),
              type: "session.delete",
              sessionId: childSessionId,
              targetThreadId: threadId,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        },
      );
      const fork = yield* client.forkSession(forkRequest).pipe(
        Effect.retry({ times: 1 }),
        Effect.onError(() => deleteChildSession()),
      );

      const sourceThread =
        source.threadId === undefined
          ? undefined
          : snapshot.threads.find((thread) => thread.id === source.threadId);
      const sourceTitle = sourceThread?.title ?? source.title ?? "Conversation";
      const modelSelection = fork.modelSelection
        ? {
            instanceId: HERMES_INSTANCE_ID,
            model: encodeHermesModelSlug(fork.modelSelection.provider, fork.modelSelection.model),
            ...(fork.modelSelection.reasoningEffort
              ? {
                  options: [
                    {
                      id: "reasoningEffort",
                      value: fork.modelSelection.reasoningEffort,
                    },
                  ],
                }
              : {}),
          }
        : {
            instanceId: HERMES_INSTANCE_ID,
            model: defaultModel.slug,
          };

      return yield* Effect.gen(function* () {
        yield* dependencies.dispatch({
          type: "thread.create",
          commandId: yield* nextCommandId("hermes-conversation-fork-create"),
          threadId,
          projectId: project.id,
          title: `${sourceTitle} copy`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* dependencies.dispatch({
          type: "thread.meta.update",
          commandId: yield* nextCommandId("hermes-conversation-fork-title"),
          threadId,
          title: fork.title,
        });
        yield* importHistory(threadId, fork);

        const isT3Fork = source.source === "t3agent" && source.threadId !== undefined;
        const lineage: HermesLineageMetadata = {
          kind: isT3Fork ? "fork" : "import",
          label: isT3Fork ? `Continued from ${sourceTitle}` : `Imported from ${source.source}`,
          sourceProvider: source.source,
          sourceSessionId: source.sessionId,
          ...(source.threadId ? { sourceThreadId: source.threadId } : {}),
        };
        const lineageJson = yield* encodeLineage(lineage);
        yield* dependencies.dispatch({
          type: "thread.message.import",
          commandId: yield* nextCommandId("hermes-lineage"),
          threadId,
          messageId: MessageId.make(`hermes-lineage:${fork.childSessionId}`),
          role: "system",
          text: `t3agent-lineage:${lineageJson}`,
          createdAt,
        });
        return { threadId, existing: false };
      }).pipe(
        Effect.onError(() =>
          Effect.all([deleteThread(threadId), deleteChildSession()], {
            concurrency: "unbounded",
          }).pipe(Effect.asVoid),
        ),
      );
    },
    (effect, input) =>
      forkLock
        .withPermit(effect)
        .pipe(
          Effect.mapError((cause) =>
            lifecycleError(
              "conversation.fork",
              cause,
              "Unable to create the Hermes conversation copy.",
              sourceContext(input),
            ),
          ),
        ),
  );

  return { listSessions, forkConversation };
}

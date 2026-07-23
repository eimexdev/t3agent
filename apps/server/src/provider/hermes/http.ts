import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  HermesBridgeChatId,
  HermesBridgeThreadCreateResponse,
  HermesBridgeThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as HermesBridgeRegistry from "./HermesBridgeRegistry.ts";

const decodeInstanceId = Schema.decodeUnknownEffect(ProviderInstanceId);
const HERMES_CALLBACK_MAX_BODY_SIZE = FileSystem.MiB(16);
const isThreadCreateCallback = (
  value: unknown,
): value is {
  readonly type: "thread.create";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly deliveryId: string;
  readonly parentChatId: string;
  readonly name: string;
} =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value as { readonly type?: unknown }).type === "thread.create";

function bearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

function stableIdSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 96);
  return normalized || "delivery";
}

export const hermesBridgeHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const orchestration = yield* OrchestrationEngineService;
    const config = yield* ServerConfig;

    return HttpRouter.add(
      "POST",
      "/api/hermes/:instanceId/events",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;
        const rawInstanceId = params.instanceId;
        const token = bearerToken(request);
        if (!rawInstanceId || !token) {
          return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
        }
        const instanceId = yield* decodeInstanceId(rawInstanceId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (!instanceId) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_instance" }, { status: 400 });
        }
        const payload = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, HERMES_CALLBACK_MAX_BODY_SIZE),
          Effect.orElseSucceed(() => undefined),
        );
        if (payload === undefined) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_json" }, { status: 400 });
        }
        const result = yield* HermesBridgeRegistry.receive(instanceId, token, payload).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              _bridgeError: true as const,
              status:
                error.operation === "authenticate" || error.operation === "lookup" ? 401 : 400,
            }),
          ),
        );
        if (typeof result === "object" && result !== null && "_bridgeError" in result) {
          const status =
            "status" in result && typeof result.status === "number" ? result.status : 400;
          return HttpServerResponse.jsonUnsafe(
            { error: status === 401 ? "unauthorized" : "invalid_callback" },
            { status },
          );
        }
        if (isThreadCreateCallback(result)) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const instanceSegment = stableIdSegment(instanceId);
          const deliverySegment = stableIdSegment(result.deliveryId);
          const projectId = ProjectId.make(`t3-agent-${instanceSegment}`);
          const threadId = ThreadId.make(`hermes-${deliverySegment}`);
          yield* orchestration.dispatch({
            type: "project.create",
            commandId: CommandId.make(`hermes:${instanceId}:inbox-project`),
            projectId,
            title: "T3 Agent",
            workspaceRoot: config.cwd,
            defaultModelSelection: { instanceId, model: "active" },
            createdAt,
          });
          yield* orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`hermes:${result.deliveryId}:thread-create`),
            threadId,
            projectId,
            title: result.name,
            modelSelection: { instanceId, model: "active" },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          });
          const response: HermesBridgeThreadCreateResponse = {
            protocolVersion: result.protocolVersion,
            requestId: result.requestId as never,
            deliveryId: result.deliveryId as never,
            chatId: HermesBridgeChatId.make("t3agent"),
            threadId: HermesBridgeThreadId.make(threadId),
          };
          return HttpServerResponse.jsonUnsafe(response, { status: 200 });
        }
        return HttpServerResponse.jsonUnsafe(
          {
            protocolVersion: 1,
            requestId:
              typeof payload === "object" &&
              payload !== null &&
              "requestId" in payload &&
              typeof payload.requestId === "string"
                ? payload.requestId
                : "callback",
            deliveryId:
              typeof payload === "object" &&
              payload !== null &&
              "deliveryId" in payload &&
              typeof payload.deliveryId === "string"
                ? payload.deliveryId
                : undefined,
            status:
              typeof result === "object" &&
              result !== null &&
              "status" in result &&
              result.status === "duplicate"
                ? "duplicate"
                : "accepted",
          },
          { status: 200 },
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Hermes bridge callback failed", { cause }).pipe(
            Effect.as(HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500 })),
          ),
        ),
      ),
    );
  }),
);

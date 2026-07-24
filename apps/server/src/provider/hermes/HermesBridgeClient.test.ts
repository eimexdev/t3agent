import { assert, describe, it, vi } from "@effect/vitest";
import {
  HermesBridgeT3ToHermesRequest,
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeRequestId,
  HermesBridgeSessionId,
} from "@t3tools/contracts/hermesBridge";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { makeHermesBridgeClient } from "./HermesBridgeClient.ts";

const decodeRequest = Schema.decodeUnknownSync(HermesBridgeT3ToHermesRequest);

function jsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
  assert.strictEqual(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") {
    throw new Error("Expected a JSON Uint8Array request body");
  }
  return JSON.parse(new TextDecoder().decode(request.body.body));
}

function makeClient(response: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
  );
  return {
    client: makeHermesBridgeClient({
      baseUrl: " http://127.0.0.1:8789/// ",
      token: "bridge-secret",
      httpClient: HttpClient.make(execute),
    }),
    execute,
  };
}

describe("HermesBridgeClient", () => {
  it.effect("authenticates and decodes the capabilities snapshot", () => {
    const { client, execute } = makeClient(() =>
      Response.json({
        protocolVersion: HERMES_BRIDGE_PROTOCOL_VERSION,
        requestId: "provider-capabilities",
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
        commands: [{ name: "restart", description: "Restart Hermes" }],
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        profile: "default",
      }),
    );

    return Effect.gen(function* () {
      const result = yield* client.getCapabilities;

      assert.strictEqual(result.model, "anthropic/claude-sonnet-4");
      assert.strictEqual(result.commands[0]?.name, "restart");
      assert.strictEqual(execute.mock.calls.length, 1);

      const call = execute.mock.calls[0];
      assert.ok(call);
      const [request] = call;
      const url = new URL(request.url);
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(url.origin, "http://127.0.0.1:8789");
      assert.strictEqual(url.pathname, "/v1/capabilities");
      assert.strictEqual(url.searchParams.get("protocolVersion"), "1");
      assert.strictEqual(url.searchParams.get("requestId"), "provider-capabilities");
      assert.strictEqual(request.headers.authorization, "Bearer bridge-secret");
      assert.strictEqual(request.headers.accept, "application/json");
      assert.strictEqual(request.headers["user-agent"], "t3-agent-hermes-bridge/1");
    });
  });

  it.effect("lists Hermes sessions with import linkage", () => {
    const importedThreadId = "00000000-0000-4000-8000-000000000001";
    const { client, execute } = makeClient(() =>
      Response.json({
        protocolVersion: 1,
        requestId: "sessions-list",
        sessions: [
          {
            sessionId: "discord-source",
            source: "discord",
            title: "Planning",
            startedAt: "2026-07-23T10:00:00.000Z",
            messageCount: 8,
            importedThreadIds: [importedThreadId],
          },
        ],
      }),
    );

    return Effect.gen(function* () {
      const result = yield* client.listSessions;

      assert.strictEqual(result.sessions[0]?.source, "discord");
      assert.strictEqual(result.sessions[0]?.importedThreadIds?.[0], importedThreadId);
      const call = execute.mock.calls[0];
      assert.ok(call);
      const [request] = call;
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(new URL(request.url).pathname, "/v1/sessions");
      assert.strictEqual(new URL(request.url).searchParams.get("requestId"), "sessions-list");
    });
  });

  it.effect("creates a child Hermes session for a T3 conversation", () => {
    const targetThreadId = ThreadId.make("00000000-0000-4000-8000-000000000002");
    const { client, execute } = makeClient(() =>
      Response.json({
        protocolVersion: 1,
        requestId: "fork-request",
        sourceSessionId: HermesBridgeSessionId.make("discord-source"),
        childSessionId: "t3-child",
        targetThreadId,
        source: "discord",
        title: "Planning #2",
        messages: [
          {
            role: "user",
            content: "Continue this",
            createdAt: "2026-07-23T10:00:00.000Z",
          },
          {
            role: "assistant",
            content: "Done",
            createdAt: "2026-07-23T10:00:02.000Z",
            turnId: "hermes-turn-1",
          },
        ],
        activities: [
          {
            id: "hermes-activity-1",
            tone: "tool",
            kind: "tool.completed",
            summary: "Searched files",
            payload: {
              itemType: "mcp_tool_call",
              status: "completed",
              data: { toolCallId: "call-1" },
            },
            turnId: "hermes-turn-1",
            sequence: 0,
            createdAt: "2026-07-23T10:00:01.000Z",
          },
        ],
      }),
    );

    return Effect.gen(function* () {
      const result = yield* client.forkSession({
        protocolVersion: 1,
        requestId: HermesBridgeRequestId.make("fork-request"),
        type: "session.fork",
        sourceSessionId: HermesBridgeSessionId.make("discord-source"),
        childSessionId: HermesBridgeSessionId.make("t3-child"),
        targetThreadId,
        userTurnCount: 1,
      });

      assert.strictEqual(result.childSessionId, "t3-child");
      assert.strictEqual(result.messages[1]?.turnId, "hermes-turn-1");
      assert.strictEqual(result.activities?.[0]?.kind, "tool.completed");
      const call = execute.mock.calls[0];
      assert.ok(call);
      const [request] = call;
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(new URL(request.url).pathname, "/v1/sessions/fork");
      assert.strictEqual(request.headers["idempotency-key"], "fork-request");
      assert.deepStrictEqual(jsonBody(request), {
        protocolVersion: 1,
        requestId: "fork-request",
        type: "session.fork",
        sourceSessionId: HermesBridgeSessionId.make("discord-source"),
        childSessionId: HermesBridgeSessionId.make("t3-child"),
        targetThreadId,
        userTurnCount: 1,
      });
    });
  });

  it.effect("deletes only the child session correlated to its T3 thread", () => {
    const targetThreadId = ThreadId.make("00000000-0000-4000-8000-000000000002");
    const sessionId = HermesBridgeSessionId.make("t3-child");
    const { client, execute } = makeClient(() =>
      Response.json({
        protocolVersion: 1,
        requestId: "delete-request",
        status: "accepted",
      }),
    );

    return Effect.gen(function* () {
      const result = yield* client.deleteSession({
        protocolVersion: 1,
        requestId: HermesBridgeRequestId.make("delete-request"),
        type: "session.delete",
        sessionId,
        targetThreadId,
      });

      assert.strictEqual(result.status, "accepted");
      const call = execute.mock.calls[0];
      assert.ok(call);
      const [request] = call;
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(new URL(request.url).pathname, "/v1/sessions/delete");
      assert.strictEqual(request.headers["idempotency-key"], "delete-request");
      assert.deepStrictEqual(jsonBody(request), {
        protocolVersion: 1,
        requestId: "delete-request",
        type: "session.delete",
        sessionId,
        targetThreadId,
      });
    });
  });

  const requests = [
    [
      "/v1/messages",
      decodeRequest({
        protocolVersion: 1,
        requestId: "request-message",
        type: "message.submit",
        messageId: "message-1",
        chatId: "t3agent",
        threadId: "thread-1",
        user: { id: "owner", name: "Owner" },
        content: "/restart",
      }),
    ],
    [
      "/v1/interrupt",
      decodeRequest({
        protocolVersion: 1,
        requestId: "request-interrupt",
        type: "turn.interrupt",
        chatId: "t3agent",
        threadId: "thread-1",
      }),
    ],
    [
      "/v1/approvals",
      decodeRequest({
        protocolVersion: 1,
        requestId: "request-approval",
        type: "approval.respond",
        sessionKey: "session-1",
        approvalId: "approval-1",
        providerRequestId: "provider-request-1",
        choice: "allow",
      }),
    ],
    [
      "/v1/clarifications",
      decodeRequest({
        protocolVersion: 1,
        requestId: "request-clarification",
        type: "clarification.respond",
        sessionKey: "session-1",
        clarifyId: "clarify-1",
        providerRequestId: "provider-request-2",
        response: "Use the safe default",
      }),
    ],
    [
      "/v1/slash-confirmations",
      decodeRequest({
        protocolVersion: 1,
        requestId: "request-confirmation",
        type: "slash-confirmation.respond",
        sessionKey: "session-1",
        confirmId: "confirm-1",
        choice: "once",
      }),
    ],
  ] as const;

  for (const [path, bridgeRequest] of requests) {
    it.effect(`posts ${bridgeRequest.type} to ${path} with its idempotency key`, () => {
      const { client, execute } = makeClient(() =>
        Response.json({
          protocolVersion: 1,
          requestId: bridgeRequest.requestId,
          deliveryId: "delivery-1",
          status: "accepted",
        }),
      );

      return Effect.gen(function* () {
        const acknowledgement = yield* client.send(bridgeRequest);

        assert.strictEqual(acknowledgement.status, "accepted");
        const call = execute.mock.calls[0];
        assert.ok(call);
        const [request] = call;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(new URL(request.url).pathname, path);
        assert.strictEqual(request.headers.authorization, "Bearer bridge-secret");
        assert.strictEqual(request.headers["idempotency-key"], bridgeRequest.requestId);
        assert.strictEqual(request.headers["content-type"], "application/json");
        assert.deepStrictEqual(jsonBody(request), bridgeRequest);
      });
    });
  }

  it.effect("maps non-success responses to a provider request error", () => {
    const { client } = makeClient(() => Response.json({ error: "unavailable" }, { status: 503 }));

    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.getCapabilities);

      assert.instanceOf(error, ProviderAdapterRequestError);
      assert.strictEqual(error.provider, "hermes");
      assert.strictEqual(error.method, "capabilities");
      assert.strictEqual(error.detail, "Hermes bridge request failed for capabilities.");
    });
  });

  it.effect("maps malformed acknowledgements to a provider request error", () => {
    const firstRequest = requests[0];
    assert.ok(firstRequest);
    const [, request] = firstRequest;
    const { client } = makeClient(() =>
      Response.json({
        protocolVersion: 1,
        requestId: request.requestId,
        status: "not-a-valid-status",
      }),
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.send(request));

      assert.instanceOf(error, ProviderAdapterRequestError);
      assert.strictEqual(error.provider, "hermes");
      assert.strictEqual(error.method, "message.submit");
    });
  });
});

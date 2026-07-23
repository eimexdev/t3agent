import {
  HERMES_BRIDGE_PROTOCOL_VERSION,
  HermesBridgeAcknowledgement,
  HermesBridgeCapabilitiesResponse,
  type HermesBridgeT3ToHermesRequest,
} from "@t3tools/contracts/hermesBridge";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = "hermes";

export interface HermesBridgeClient {
  readonly getCapabilities: Effect.Effect<
    HermesBridgeCapabilitiesResponse,
    ProviderAdapterRequestError
  >;
  readonly send: (
    request: HermesBridgeT3ToHermesRequest,
  ) => Effect.Effect<HermesBridgeAcknowledgement, ProviderAdapterRequestError>;
}

function requestPath(request: HermesBridgeT3ToHermesRequest): string {
  switch (request.type) {
    case "message.submit":
      return "/v1/messages";
    case "turn.interrupt":
      return "/v1/interrupt";
    case "approval.respond":
      return "/v1/approvals";
    case "clarification.respond":
      return "/v1/clarifications";
    case "slash-confirmation.respond":
      return "/v1/slash-confirmations";
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function makeHermesBridgeClient(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly httpClient: HttpClient.HttpClient;
}): HermesBridgeClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const execute = input.httpClient.pipe(HttpClient.filterStatusOk);

  const authorize = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(input.token),
      HttpClientRequest.setHeader("user-agent", "t3-agent-hermes-bridge/1"),
    );

  const mapRequestError = (method: string) => (cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: `Hermes bridge request failed for ${method}.`,
      cause,
    });

  const capabilityQuery = new URLSearchParams({
    protocolVersion: String(HERMES_BRIDGE_PROTOCOL_VERSION),
    requestId: "provider-capabilities",
  });
  const getCapabilities = HttpClientRequest.get(
    `${baseUrl}/v1/capabilities?${capabilityQuery.toString()}`,
  ).pipe(
    authorize,
    execute.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(HermesBridgeCapabilitiesResponse)),
    Effect.mapError(mapRequestError("capabilities")),
  );

  const send: HermesBridgeClient["send"] = (request) =>
    HttpClientRequest.post(`${baseUrl}${requestPath(request)}`).pipe(
      authorize,
      HttpClientRequest.setHeader("idempotency-key", request.requestId),
      HttpClientRequest.bodyJsonUnsafe(request),
      execute.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(HermesBridgeAcknowledgement)),
      Effect.mapError(mapRequestError(request.type)),
    );

  return { getCapabilities, send };
}

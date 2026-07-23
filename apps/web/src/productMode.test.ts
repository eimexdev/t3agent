import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { isT3AgentProviderInstance, isT3AgentThread, resolveProductMode } from "./productMode";

describe("resolveProductMode", () => {
  it.each(["1", "true", "t3agent", " T3Agent "])("enables T3 Agent for %j", (value) => {
    expect(resolveProductMode(value)).toBe("t3agent");
  });

  it.each([undefined, "", "0", "false", "nightly"])(
    "keeps the upstream T3 Code shell for %j",
    (value) => {
      expect(resolveProductMode(value)).toBe("t3code");
    },
  );
});

describe("T3 Agent provider policy", () => {
  const hermes = ProviderInstanceId.make("hermes");
  const codex = ProviderInstanceId.make("codex");

  it("recognizes only the Hermes provider instance", () => {
    expect(isT3AgentProviderInstance(hermes)).toBe(true);
    expect(isT3AgentProviderInstance(codex)).toBe(false);
  });

  it("keeps restored Hermes threads when the session identifies Hermes", () => {
    expect(
      isT3AgentThread({
        modelSelection: { instanceId: codex },
        session: { providerInstanceId: hermes },
      }),
    ).toBe(true);
  });

  it("rejects threads with no Hermes provider identity", () => {
    expect(
      isT3AgentThread({
        modelSelection: { instanceId: codex },
        session: null,
      }),
    ).toBe(false);
  });
});

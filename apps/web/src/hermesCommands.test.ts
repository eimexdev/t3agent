import { describe, expect, it } from "vite-plus/test";

import { parseT3AgentLifecycleCommand, resolveCommandGhostHint } from "./hermesCommands";
import { formatHermesSourceLabel } from "./hermesLineage";

describe("parseT3AgentLifecycleCommand", () => {
  it.each(["/new", "/sessions", "/resume", "/fork"] as const)(
    "routes %s through the T3 Agent lifecycle",
    (command) => {
      expect(parseT3AgentLifecycleCommand(command)).toBe(command.slice(1));
    },
  );

  it("does not intercept Hermes-native commands or arguments", () => {
    expect(parseT3AgentLifecycleCommand("/restart")).toBeNull();
    expect(parseT3AgentLifecycleCommand("/fork named-copy")).toBeNull();
  });
});

describe("resolveCommandGhostHint", () => {
  const commands = [{ name: "resume", input: { hint: "session" } }, { name: "restart" }];

  it("renders a non-submitted argument hint after a selected command", () => {
    expect(resolveCommandGhostHint("/resume", commands)).toBe(" session");
    expect(resolveCommandGhostHint("/resume ", commands)).toBe("session");
  });

  it("hides the hint once arguments or multiline text are present", () => {
    expect(resolveCommandGhostHint("/resume discord", commands)).toBeNull();
    expect(resolveCommandGhostHint("/resume\nmore", commands)).toBeNull();
    expect(resolveCommandGhostHint("/restart", commands)).toBeNull();
  });
});

describe("formatHermesSourceLabel", () => {
  it("uses readable gateway names", () => {
    expect(formatHermesSourceLabel("discord")).toBe("Discord");
    expect(formatHermesSourceLabel("cli")).toBe("CLI");
    expect(formatHermesSourceLabel("t3agent")).toBe("T3 Agent");
  });
});

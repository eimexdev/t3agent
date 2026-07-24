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

  it("keeps session-changing aliases and arguments on the native T3 lifecycle", () => {
    expect(parseT3AgentLifecycleCommand("/reset")).toBe("new");
    expect(parseT3AgentLifecycleCommand("/branch")).toBe("fork");
    expect(parseT3AgentLifecycleCommand("/resume discord-session")).toBe("resume");
    expect(parseT3AgentLifecycleCommand("/fork named-copy")).toBe("fork");
  });

  it("does not intercept unrelated Hermes-native commands", () => {
    expect(parseT3AgentLifecycleCommand("/restart")).toBeNull();
  });
});

describe("resolveCommandGhostHint", () => {
  const commands = [
    { name: "resume", input: { hint: "session" } },
    { name: "cron", input: { hint: "<pause|resume|list> [name]" } },
    {
      name: "model",
      input: { hint: "[model] [--provider name] [--global|--session]" },
    },
    { name: "voice", input: { hint: "[on|off|status]" } },
    { name: "restart" },
  ];

  it("renders a non-submitted argument hint after a selected command", () => {
    expect(resolveCommandGhostHint("/resume", commands)).toBe(" session");
    expect(resolveCommandGhostHint("/resume ", commands)).toBe("session");
  });

  it("consumes a matching typed prefix without inserting it into the prompt", () => {
    expect(resolveCommandGhostHint("/resume ses", commands)).toBe("sion");
    expect(resolveCommandGhostHint("/resume session", commands)).toBeNull();
  });

  it("advances through literal alternatives and subsequent placeholders", () => {
    expect(resolveCommandGhostHint("/cron res", commands)).toBe("ume [name]");
    expect(resolveCommandGhostHint("/cron resume", commands)).toBe(" [name]");
    expect(resolveCommandGhostHint("/cron resume ", commands)).toBe("[name]");
  });

  it("advances through grouped multi-argument hints", () => {
    expect(resolveCommandGhostHint("/model claude", commands)).toBe(
      " [--provider name] [--global|--session]",
    );
    expect(resolveCommandGhostHint("/model claude ", commands)).toBe(
      "[--provider name] [--global|--session]",
    );
    expect(resolveCommandGhostHint("/model claude --p", commands)).toBe(
      "rovider name [--global|--session]",
    );
    expect(resolveCommandGhostHint("/model claude --provider ", commands)).toBe(
      "name [--global|--session]",
    );
  });

  it("hides exhausted, ambiguous, and multiline hints", () => {
    expect(resolveCommandGhostHint("/resume discord", commands)).toBeNull();
    expect(resolveCommandGhostHint("/voice o", commands)).toBeNull();
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

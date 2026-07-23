import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  mergeSlashCommandItemsWithProviderPrecedence,
  searchSlashCommandItems,
} from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("gives advertised provider commands precedence over colliding built-ins", () => {
    const builtInItems = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model for this thread",
      },
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch this thread into plan mode",
      },
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" }>>;
    const providerItems = [
      {
        id: "provider-slash-command:hermes:model",
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("hermes"),
        command: { name: "MODEL", description: "Change the Hermes model" },
        label: "/MODEL",
        description: "Change the Hermes model",
      },
      {
        id: "provider-slash-command:hermes:plan",
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("hermes"),
        command: { name: "plan", description: "Run the Hermes plan command" },
        label: "/plan",
        description: "Run the Hermes plan command",
      },
      {
        id: "provider-slash-command:hermes:default",
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("hermes"),
        command: { name: "default", description: "Run the Hermes default command" },
        label: "/default",
        description: "Run the Hermes default command",
      },
      {
        id: "provider-slash-command:hermes:restart",
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("hermes"),
        command: { name: "restart", description: "Restart the Hermes session" },
        label: "/restart",
        description: "Restart the Hermes session",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "provider-slash-command" }>>;

    expect(
      mergeSlashCommandItemsWithProviderPrecedence(builtInItems, providerItems).map(
        (item) => item.id,
      ),
    ).toEqual([
      "provider-slash-command:hermes:model",
      "provider-slash-command:hermes:plan",
      "provider-slash-command:hermes:default",
      "provider-slash-command:hermes:restart",
    ]);
    expect(
      searchSlashCommandItems(
        mergeSlashCommandItemsWithProviderPrecedence(builtInItems, providerItems),
        "model",
      ).map((item) => item.id),
    ).toEqual(["provider-slash-command:hermes:model"]);
  });
});

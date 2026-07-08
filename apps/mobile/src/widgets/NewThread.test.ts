import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Link: "Link",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  containerBackground: (color: unknown) => ({ containerBackground: color }),
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createWidget: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  NewThread,
  type NewThreadWidgetConfiguration,
  type NewThreadWidgetProject,
} from "./NewThread";

function makeProject(overrides: Partial<NewThreadWidgetProject>): NewThreadWidgetProject {
  return {
    title: "Project",
    deepLink: "/new/draft?environmentId=env-1&projectId=proj-1&title=Project",
    ...overrides,
  };
}

function makeEnvironment(overrides: {
  readonly widgetFamily: "systemSmall" | "systemMedium" | "systemLarge";
  readonly colorScheme?: "light" | "dark";
  readonly configuration?: Partial<NewThreadWidgetConfiguration>;
}) {
  return {
    date: new Date("2026-07-07T12:00:00.000Z"),
    widgetFamily: overrides.widgetFamily,
    colorScheme: overrides.colorScheme ?? "dark",
    configuration: { pinnedProjects: "", showRecent: true, ...overrides.configuration },
  } as never;
}

const smallEnvironment = makeEnvironment({ widgetFamily: "systemSmall" });
const mediumEnvironment = makeEnvironment({ widgetFamily: "systemMedium" });

describe("NewThread widget layout", () => {
  it("deep links the whole small widget to the new-task sheet", () => {
    const layout = JSON.stringify(NewThread({ projects: [] }, smallEnvironment));
    expect(layout).toContain('"widgetURL":"t3code://new"');
    expect(layout).toContain("New Thread");
  });

  it("renders the small call to action even when projects are present", () => {
    const layout = JSON.stringify(
      NewThread({ projects: [makeProject({ title: "t3code" })] }, smallEnvironment),
    );
    expect(layout).not.toContain("t3code://new/draft");
    expect(layout).toContain('"widgetURL":"t3code://new"');
  });

  it("tolerates missing props and configuration (WidgetKit placeholder renders with none)", () => {
    const layout = JSON.stringify(
      NewThread(
        {} as never,
        {
          date: new Date("2026-07-07T12:00:00.000Z"),
          widgetFamily: "systemMedium",
          colorScheme: "light",
          configuration: undefined,
        } as never,
      ),
    );
    expect(layout).toContain('"widgetURL":"t3code://new"');
  });

  it("links each medium row to its project's draft composer", () => {
    const layout = JSON.stringify(
      NewThread(
        {
          projects: [
            makeProject({ title: "t3code", deepLink: "/new/draft?projectId=a" }),
            makeProject({ title: "marketing", deepLink: "/new/draft?projectId=b" }),
          ],
        },
        mediumEnvironment,
      ),
    );
    expect(layout).toContain("t3code");
    expect(layout).toContain("marketing");
    expect(layout).toContain('"destination":"t3code://new/draft?projectId=a"');
    expect(layout).toContain('"destination":"t3code://new/draft?projectId=b"');
    // Header link falls back to the plain new-task sheet.
    expect(layout).toContain('"destination":"t3code://new"');
  });

  it("renders at most three rows on medium and seven on large", () => {
    const projects = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      makeProject({ title: `Project ${n}`, deepLink: `/new/draft?projectId=p${n}` }),
    );
    const medium = JSON.stringify(NewThread({ projects }, mediumEnvironment));
    expect(medium).toContain("Project 3");
    expect(medium).not.toContain("Project 4");
    const large = JSON.stringify(
      NewThread({ projects }, makeEnvironment({ widgetFamily: "systemLarge" })),
    );
    expect(large).toContain("Project 7");
    expect(large).not.toContain("Project 8");
  });

  it("pins configured projects ahead of recents, in pin order", () => {
    const layout = JSON.stringify(
      NewThread(
        {
          projects: [
            makeProject({ title: "recent" }),
            makeProject({ title: "beta" }),
            makeProject({ title: "alpha" }),
          ],
        },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "Alpha, Beta" },
        }),
      ),
    );
    expect(layout.indexOf("alpha")).toBeLessThan(layout.indexOf("beta"));
    expect(layout.indexOf("beta")).toBeLessThan(layout.indexOf("recent"));
    // Pinned rows carry the pin glyph; the recent row keeps the folder.
    expect(layout).toContain("pin.fill");
    expect(layout).toContain("folder");
  });

  it("matches pins by case-insensitive prefix and skips unmatched pins", () => {
    const layout = JSON.stringify(
      NewThread(
        {
          projects: [makeProject({ title: "recent" }), makeProject({ title: "T3 Marketing Site" })],
        },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "t3 mark, no-such-project" },
        }),
      ),
    );
    expect(layout.indexOf("T3 Marketing Site")).toBeLessThan(layout.indexOf("recent"));
    expect(layout).toContain("pin.fill");
  });

  it("pins can surface projects beyond the visible row budget", () => {
    const projects = [1, 2, 3, 4, 5].map((n) => makeProject({ title: `Project ${n}` }));
    const layout = JSON.stringify(
      NewThread(
        { projects },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "Project 5" },
        }),
      ),
    );
    expect(layout).toContain("Project 5");
    expect(layout).toContain("Project 1");
    expect(layout).toContain("Project 2");
    expect(layout).not.toContain("Project 3");
  });

  it("skips ambiguous pin titles instead of linking the first match", () => {
    const layout = JSON.stringify(
      NewThread(
        {
          projects: [
            makeProject({
              title: "t3code (Laptop)",
              deepLink: "/new/draft?environmentId=env-1&projectId=a&title=t3code",
            }),
            makeProject({
              title: "t3code (Desktop)",
              deepLink: "/new/draft?environmentId=env-2&projectId=b&title=t3code",
            }),
            makeProject({ title: "recent", deepLink: "/new/draft?projectId=recent" }),
          ],
        },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "t3code", showRecent: false },
        }),
      ),
    );
    // Ambiguous bare title must not deep-link either duplicate.
    expect(layout).not.toContain("environmentId=env-1");
    expect(layout).not.toContain("environmentId=env-2");
    expect(layout).toContain('"widgetURL":"t3code://new"');
  });

  it("pins a disambiguated title to the intended environment", () => {
    const layout = JSON.stringify(
      NewThread(
        {
          projects: [
            makeProject({
              title: "t3code (Laptop)",
              deepLink: "/new/draft?environmentId=env-1&projectId=a&title=t3code",
            }),
            makeProject({
              title: "t3code (Desktop)",
              deepLink: "/new/draft?environmentId=env-2&projectId=b&title=t3code",
            }),
          ],
        },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "t3code (Desktop)", showRecent: false },
        }),
      ),
    );
    expect(layout).toContain("t3code (Desktop)");
    expect(layout).toContain(
      '"destination":"t3code://new/draft?environmentId=env-2&projectId=b&title=t3code"',
    );
    expect(layout).not.toContain("environmentId=env-1");
  });

  it("hides recents when the fill toggle is off", () => {
    const layout = JSON.stringify(
      NewThread(
        { projects: [makeProject({ title: "pinned-one" }), makeProject({ title: "recent" })] },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "pinned-one", showRecent: false },
        }),
      ),
    );
    expect(layout).toContain("pinned-one");
    expect(layout).not.toContain("recent");
  });

  it("falls back to the call to action when recents are off and no pin matches", () => {
    const layout = JSON.stringify(
      NewThread(
        { projects: [makeProject({ title: "recent" })] },
        makeEnvironment({
          widgetFamily: "systemMedium",
          configuration: { pinnedProjects: "gone", showRecent: false },
        }),
      ),
    );
    expect(layout).toContain('"widgetURL":"t3code://new"');
    expect(layout).not.toContain("recent");
  });

  it("drops the link but keeps the row for unsafe deep links", () => {
    const layout = JSON.stringify(
      NewThread(
        { projects: [makeProject({ title: "sneaky", deepLink: "//evil.example" })] },
        mediumEnvironment,
      ),
    );
    expect(layout).toContain("sneaky");
    expect(layout).not.toContain("evil.example");
  });

  it("adapts the container background to the color scheme", () => {
    const dark = JSON.stringify(NewThread({ projects: [] }, smallEnvironment));
    const light = JSON.stringify(
      NewThread(
        { projects: [] },
        makeEnvironment({ widgetFamily: "systemSmall", colorScheme: "light" }),
      ),
    );
    expect(dark).toContain('"containerBackground":"#0a0a0a"');
    expect(light).toContain('"containerBackground":"#ffffff"');
  });
});

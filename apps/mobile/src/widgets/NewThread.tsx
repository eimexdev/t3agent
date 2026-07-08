import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import type { ComponentProps, JSX } from "react";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

export interface NewThreadWidgetProject {
  readonly title: string;
  /** App-relative path to the prefilled draft composer, e.g. "/new/draft?environmentId=…". */
  readonly deepLink: string;
}

export interface NewThreadWidgetProps {
  /**
   * Candidate projects, most recently active first. The medium/large widgets
   * render a slice of these as one-tap shortcuts into the draft composer.
   * The full workspace set is synced (not just the visible rows): pinned-
   * project matching happens here in the widget (the configuration is per
   * widget instance, so the app cannot precompute it), and a pin should
   * resolve even when its project has fallen out of the top displayed rows.
   * Optional because WidgetKit renders placeholder/gallery entries with no
   * props before the app has ever written a timeline.
   */
  readonly projects?: ReadonlyArray<NewThreadWidgetProject>;
}

/** Mirrors the `configuration.parameters` in app.config.ts. */
export interface NewThreadWidgetConfiguration {
  /** Comma-separated project titles to pin ahead of recent projects. */
  readonly pinnedProjects: string;
  /** Whether to fill the remaining rows with recently active projects. */
  readonly showRecent: boolean;
}

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function NewThread(
  props: NewThreadWidgetProps,
  environment: WidgetEnvironment<NewThreadWidgetConfiguration>,
): JSX.Element {
  "widget";

  // Semantic label colors adapt to whatever material the OS renders the
  // widget on (light/dark home screen, tinted iOS 18 mode).
  const primaryForeground = "primary";
  const secondaryForeground = "secondary";
  // Home-screen widgets must supply their own container background on iOS 17+;
  // match the app's splash background per scheme.
  const containerColor = environment.colorScheme === "dark" ? "#0a0a0a" : "#ffffff";

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const newThreadUrl = "t3code://new";
  const toWidgetUrl = (deepLink: string): string | null =>
    deepLink.startsWith("/") && !deepLink.startsWith("//") ? `t3code://${deepLink.slice(1)}` : null;

  // SF Symbols and the logo ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container the resizable image fills.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const renderGlyph = (systemName: SFName, size: number, color: string) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );
  // The 3:2 frame matches the T3 mark's aspect ratio so it never distorts.
  const renderLogo = (height: number, color: string) => (
    <HStack modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color)]}>
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  const available = props.projects ?? [];
  const configuration = environment.configuration;

  // Pins are typed titles (see app.config.ts for why there is no picker).
  // Match case-insensitively, exact title first and then prefix, preserving
  // the user's pin order. A query that matches more than one remaining project
  // is skipped (no ambiguous deep link) rather than picking the first by
  // activity order. Unmatched pins (typo, deleted project) are skipped.
  const pinnedQueries = (
    typeof configuration?.pinnedProjects === "string" ? configuration.pinnedProjects : ""
  )
    .split(",")
    .map((title) => title.trim().toLowerCase())
    .filter((title) => title.length > 0);
  const pinned: NewThreadWidgetProject[] = [];
  for (const query of pinnedQueries) {
    const unused = available.filter((project) => !pinned.includes(project));
    const exactMatches = unused.filter((project) => project.title.toLowerCase() === query);
    let match: NewThreadWidgetProject | undefined;
    if (exactMatches.length === 1) {
      match = exactMatches[0];
    } else if (exactMatches.length === 0) {
      const prefixMatches = unused.filter((project) =>
        project.title.toLowerCase().startsWith(query),
      );
      if (prefixMatches.length === 1) {
        match = prefixMatches[0];
      }
    }
    if (match) {
      pinned.push(match);
    }
  }

  // Pinned first, then latest activity — unless recents are configured off.
  const rows = [...pinned];
  if (configuration?.showRecent !== false) {
    for (const project of available) {
      if (!rows.includes(project)) {
        rows.push(project);
      }
    }
  }
  const rowLimit = environment.widgetFamily === "systemLarge" ? 7 : 3;
  const visible = rows.slice(0, rowLimit);

  // The whole small widget is one tap target; the medium/large widgets add
  // per-row links, with the root widgetURL as the fallback for untargeted areas.
  const rootModifiers = [containerBackground(containerColor, "widget"), widgetURL(newThreadUrl)];

  // Small family — and the larger families with nothing to list (no sync yet,
  // or recents off with no pin matched) — render a single centered call to action.
  if (environment.widgetFamily === "systemSmall" || visible.length === 0) {
    return (
      <VStack spacing={7} modifiers={rootModifiers}>
        <Spacer minLength={0} />
        {renderLogo(20, primaryForeground)}
        <HStack spacing={5} alignment="center">
          {renderGlyph("square.and.pencil", 12, secondaryForeground)}
          <Text
            modifiers={[font({ weight: "semibold", size: 13 }), foregroundStyle(primaryForeground)]}
          >
            New Thread
          </Text>
        </HStack>
        <Spacer minLength={0} />
      </VStack>
    );
  }

  // Project shortcut row: tapping opens the draft composer with that project
  // preselected. Rows whose deep link fails the safety check still render,
  // but fall through to the root's plain new-thread tap target.
  const renderProjectRow = (project: NewThreadWidgetProject, isPinned: boolean) => {
    const url = toWidgetUrl(project.deepLink);
    const row = (
      <HStack spacing={7} alignment="center">
        {renderGlyph(isPinned ? "pin.fill" : "folder", 11, secondaryForeground)}
        <Text
          modifiers={[
            font({ weight: "semibold", size: 13 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {project.title}
        </Text>
        <Spacer minLength={8} />
        {renderGlyph("chevron.forward", 9, secondaryForeground)}
      </HStack>
    );
    return url ? <Link destination={url}>{row}</Link> : row;
  };

  // Pinned rows always precede recents, so index < pinned.length marks them.
  const renderRow = (index: number) => {
    const project = visible[index];
    return project ? renderProjectRow(project, index < pinned.length) : null;
  };

  return (
    <VStack alignment="leading" spacing={8} modifiers={rootModifiers}>
      <Link destination={newThreadUrl}>
        <HStack spacing={7} alignment="center">
          {renderLogo(15, primaryForeground)}
          <Text
            modifiers={[font({ weight: "bold", size: 14 }), foregroundStyle(primaryForeground)]}
          >
            New Thread
          </Text>
          <Spacer minLength={8} />
          {renderGlyph("square.and.pencil", 14, secondaryForeground)}
        </HStack>
      </Link>
      <Spacer minLength={0} modifiers={[padding({ vertical: 1 })]} />
      {renderRow(0)}
      {renderRow(1)}
      {renderRow(2)}
      {renderRow(3)}
      {renderRow(4)}
      {renderRow(5)}
      {renderRow(6)}
      <Spacer minLength={0} />
    </VStack>
  );
}

export default createWidget<NewThreadWidgetProps, NewThreadWidgetConfiguration>(
  "NewThread",
  NewThread,
);

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import type { NewThreadWidgetProps } from "../../widgets/NewThread";

/**
 * Builds the home-screen widget payload: all projects ordered by recent
 * activity, each with a deep link into the new-task draft composer.
 *
 * The full set is synced (not just the visible rows) so pinned-project matching
 * inside the widget can resolve a deliberately pinned low-activity project.
 * Medium shows 3 rows and large 7; the widget layout slices after pin matching.
 *
 * "Recently active" means the newest thread update in the project, falling
 * back to the project's own updatedAt for projects with no threads — so the
 * widget surfaces where the user actually works, not what was created last.
 *
 * When two projects share a title, the display title is disambiguated with the
 * environment label (falling back to environment id, then project id) so pin
 * matching and the deep link target the intended workspace.
 */
export function makeNewThreadWidgetProps(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentLabels: ReadonlyMap<string, string> = new Map(),
): NewThreadWidgetProps {
  const latestThreadActivity = new Map<string, string>();
  for (const thread of threads) {
    const key = projectActivityKey(thread.environmentId, thread.projectId);
    const previous = latestThreadActivity.get(key);
    // ISO-8601 timestamps order lexicographically.
    if (previous === undefined || thread.updatedAt > previous) {
      latestThreadActivity.set(key, thread.updatedAt);
    }
  }

  const lastActivity = (project: EnvironmentProject): string => {
    const threadActivity = latestThreadActivity.get(
      projectActivityKey(project.environmentId, project.id),
    );
    return threadActivity !== undefined && threadActivity > project.updatedAt
      ? threadActivity
      : project.updatedAt;
  };

  const ordered = [...projects].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  const displayTitles = disambiguateProjectTitles(ordered, environmentLabels);

  return {
    projects: ordered.map((project, index) => ({
      title: displayTitles[index] ?? project.title,
      // Matches the NewTaskSheet > NewTaskDraft linking config in Stack.tsx;
      // the widget layout prefixes the scheme after a safety check. Keep the
      // original project title in the query — not the disambiguated display.
      deepLink:
        `/new/draft?environmentId=${encodeURIComponent(String(project.environmentId))}` +
        `&projectId=${encodeURIComponent(String(project.id))}` +
        `&title=${encodeURIComponent(project.title)}`,
    })),
  };
}

function disambiguateProjectTitles(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<string, string>,
): string[] {
  const titleCounts = countBy((project) => project.title.toLowerCase(), projects);
  const withEnvironment = projects.map((project) => {
    if ((titleCounts.get(project.title.toLowerCase()) ?? 0) <= 1) {
      return project.title;
    }
    const envLabel =
      environmentLabels.get(String(project.environmentId)) ?? String(project.environmentId);
    return `${project.title} (${envLabel})`;
  });

  const envTitleCounts = countBy((title) => title.toLowerCase(), withEnvironment);
  return withEnvironment.map((title, index) => {
    if ((envTitleCounts.get(title.toLowerCase()) ?? 0) <= 1) {
      return title;
    }
    const project = projects[index];
    return project ? `${title} · ${project.id}` : title;
  });
}

function countBy<T>(keyOf: (value: T) => string, values: ReadonlyArray<T>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function projectActivityKey(environmentId: string, projectId: string): string {
  return `${environmentId}\u0000${projectId}`;
}

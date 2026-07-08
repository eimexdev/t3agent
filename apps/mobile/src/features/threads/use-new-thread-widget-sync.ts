import { useEffect, useMemo } from "react";
import { Platform } from "react-native";

import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import NewThreadWidget from "../../widgets/NewThread";
import { makeNewThreadWidgetProps } from "./new-thread-widget";

// Last payload written to the widget timeline. Module-level (not React state)
// so navigator remounts don't rewrite an unchanged payload: every write ends
// in a WidgetCenter reload, and iOS throttles widgets that reload too often.
let lastSyncedSignature: string | null = null;

/** Delay before retrying a failed snapshot write while entity data is unchanged. */
const SNAPSHOT_RETRY_MS = 5_000;

/**
 * Keeps the NewThread home-screen widget's project shortcuts in sync with the
 * workspace. Writing the snapshot also persists the widget layout to the
 * shared app group, which is what lets the widget render at all — so this
 * must run on every launch, not only when projects change.
 */
export function useNewThreadWidgetSync(): void {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const environmentLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const environment of environments) {
      labels.set(String(environment.environmentId), environment.label);
    }
    return labels;
  }, [environments]);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sync = () => {
      if (cancelled) {
        return;
      }
      const props = makeNewThreadWidgetProps(projects, threads, environmentLabels);
      const signature = JSON.stringify(props);
      if (signature === lastSyncedSignature) {
        return;
      }
      try {
        NewThreadWidget.updateSnapshot(props);
        lastSyncedSignature = signature;
      } catch (error) {
        // Do not treat the write as succeeded. Schedule a retry so a transient
        // app-group failure still recovers when projects/threads stay the same.
        lastSyncedSignature = null;
        if (__DEV__) {
          console.warn("[new-thread-widget] snapshot update failed", error);
        }
        retryTimer = setTimeout(sync, SNAPSHOT_RETRY_MS);
      }
    };

    sync();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [projects, threads, environmentLabels]);
}

import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CloudIcon, PlusIcon, SearchIcon, Undo2Icon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  isTrailingDoubleClick,
  resolveAdjacentThreadId,
  resolveSidebarV2Status,
  sortThreadsForSidebarV2,
  type SidebarV2Status,
} from "./Sidebar.logic";
import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { CommandDialogTrigger } from "./ui/command";
import { Kbd } from "./ui/kbd";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Row heights are fixed per variant so the list only changes shape at
// lifecycle transitions (settle/unsettle), never from streaming updates.
const RAIL_CLASS_BY_STATUS: Partial<Record<SidebarV2Status, string>> = {
  approval: "bg-amber-500 dark:bg-amber-300/90",
  working: "bg-sky-500 dark:bg-sky-300/80 animate-pulse",
  failed: "bg-red-500 dark:bg-red-400/90",
};

const STATUS_WORD_BY_STATUS: Partial<
  Record<SidebarV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-amber-600 dark:text-amber-300/90" },
  working: { label: "Working", className: "text-sky-600 dark:text-sky-300/80" },
  failed: { label: "Failed", className: "text-red-600 dark:text-red-400/90" },
};

// The working timer re-renders once per second only for rows that show it.
function useTickWhile(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? Date.now() : 0;
}

function threadTimeLabel(thread: SidebarThreadSummary, status: SidebarV2Status): string {
  if (status === "working" && thread.latestTurn?.startedAt) {
    return formatElapsedDurationLabel(thread.latestTurn.startedAt);
  }
  if (status === "approval") {
    const waitingSince = thread.latestTurn?.startedAt ?? thread.updatedAt;
    return `waiting ${formatElapsedDurationLabel(waitingSince)}`;
  }
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatRelativeTimeLabel(timestamp);
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  isActive: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onChangeRequestState: (threadKey: string, state: "open" | "closed" | "merged" | null) => void;
}) {
  const {
    onChangeRequestState,
    onContextMenu,
    onSettle,
    onThreadClick,
    onUnsettle,
    thread,
    variant,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();

  const status = resolveSidebarV2Status(thread);
  useTickWhile(variant === "card" && (status === "working" || status === "approval"));

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch != null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  // Report the PR state up: the parent partitions rows with effectiveSettled,
  // and a merged/closed PR auto-settles a thread — data only rows have.
  const prState = pr?.state ?? null;
  useEffect(() => {
    onChangeRequestState(threadKey, prState);
  }, [onChangeRequestState, prState, threadKey]);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const driverKind = props.providerEntryByInstanceId.get(modelInstanceId)?.driverKind ?? null;

  const isUnread =
    thread.latestTurn?.completedAt != null &&
    (lastVisitedAt == null ||
      Date.parse(thread.latestTurn.completedAt) > Date.parse(lastVisitedAt));

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  const rowClassName = cn(
    "group/v2-row relative w-full cursor-pointer select-none rounded-md text-left",
    props.isActive
      ? "bg-accent/85 dark:bg-accent/55"
      : isSelected
        ? "bg-primary/15 dark:bg-primary/22"
        : "hover:bg-accent/60 dark:hover:bg-accent/40",
  );

  const favicon = (
    <ProjectFavicon
      environmentId={thread.environmentId}
      cwd={props.projectCwd ?? ""}
      className={variant === "card" ? "size-4" : "size-3.5"}
    />
  );

  const prBadge =
    prStatus && pr ? (
      <button
        type="button"
        onClick={handlePrClick}
        className={cn("shrink-0 font-mono text-[10px] hover:underline", prStatus.colorClass)}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </button>
    ) : null;

  if (variant === "slim") {
    return (
      <li
        data-thread-item
        className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_28px]"
      >
        <div
          role="button"
          tabIndex={0}
          data-testid="sidebar-v2-row-slim"
          className={cn(rowClassName, "flex h-7 items-center gap-2 px-2")}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          {favicon}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {thread.title}
          </span>
          {prBadge}
          <button
            type="button"
            aria-label="Un-settle thread"
            onClick={handleUnsettleClick}
            className="hidden shrink-0 items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground group-hover/v2-row:inline-flex"
          >
            <Undo2Icon className="size-2.5" />
          </button>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40 group-hover/v2-row:hidden">
            {props.jumpLabel ??
              formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
          </span>
        </div>
      </li>
    );
  }

  const rail = RAIL_CLASS_BY_STATUS[status];
  const statusWord = STATUS_WORD_BY_STATUS[status];
  const diff = latestTurnDiff(thread);

  return (
    <li
      data-thread-item
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_52px]"
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-v2-row-card"
        className={cn(rowClassName, "px-2 py-1.5", rail && "pl-3")}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {rail ? (
          <span
            aria-hidden
            className={cn("absolute bottom-1.5 left-1 top-1.5 w-0.5 rounded-full", rail)}
          />
        ) : null}
        <div className="flex items-center gap-2">
          {favicon}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              isUnread ? "font-semibold text-foreground" : "text-foreground/80",
            )}
          >
            {thread.title}
          </span>
          {diff ? (
            <span className="shrink-0 font-mono text-[10px]">
              <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Settle thread"
            onClick={handleSettleClick}
            className="hidden shrink-0 items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground group-hover/v2-row:inline-flex"
          >
            <CheckIcon className="size-2.5" />
            Settle
          </button>
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums group-hover/v2-row:hidden",
              status === "approval"
                ? "text-amber-600 dark:text-amber-300/90"
                : "text-muted-foreground/40",
            )}
          >
            {props.jumpLabel ?? threadTimeLabel(thread, status)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 pl-6 text-[10px] text-muted-foreground/60">
          {statusWord ? (
            <span className={cn("font-semibold", statusWord.className)}>{statusWord.label}</span>
          ) : null}
          {status === "failed" && thread.session?.lastError ? (
            <span className="min-w-0 truncate text-red-600/80 dark:text-red-400/80">
              {thread.session.lastError}
            </span>
          ) : null}
          {thread.branch ? (
            <span className="min-w-0 truncate font-mono">{thread.branch}</span>
          ) : null}
          {prBadge}
          <span className="inline-flex shrink-0 items-center gap-1 font-mono">
            {driverKind ? (
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={thread.session?.providerName ?? modelInstanceId}
                iconClassName="size-2.5"
              />
            ) : null}
            {thread.modelSelection.model}
          </span>
          {isRemote ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/50" />
                }
              >
                <CloudIcon className="size-2.5" />
                {props.environmentLabel ?? "Remote"}
              </TooltipTrigger>
              <TooltipPopup side="top">
                Running on {props.environmentLabel ?? "a remote environment"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </li>
  );
});

function latestTurnDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

export default function SidebarV2() {
  const projects = useProjects();
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const { settleThread, unsettleThread, archiveThread, deleteThread } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByInstanceId = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  );

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMinute(new Date().toISOString().slice(0, 16)),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);

  // PR states stream in per-row (rows own the VCS subscriptions); a merged or
  // closed PR auto-settles its thread on the next partition.
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, state);
        }
        return next;
      });
    },
    [],
  );

  const { activeThreads, settledThreads } = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    const visible = threads.filter((thread) => thread.archivedAt === null);
    const active: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    for (const thread of visible) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;
      if (effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })) {
        settled.push(thread);
      } else {
        active.push(thread);
      }
    }
    return {
      activeThreads: sortThreadsForSidebarV2(active),
      settledThreads: settled.toSorted(
        (left, right) =>
          Date.parse(right.latestUserMessageAt ?? right.updatedAt) -
          Date.parse(left.latestUserMessageAt ?? left.updatedAt),
      ),
    };
  }, [autoSettleAfterDays, changeRequestStateByKey, nowMinute, threads]);

  const orderedThreads = useMemo(
    () => [...activeThreads, ...settledThreads],
    [activeThreads, settledThreads],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const [showJumpHints, setShowJumpHints] = useState(false);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await settleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [settleThread],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsettleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unsettleThread],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "settle", label: `Settle (${count})` },
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "settle") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) continue;
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptSettle,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        // Match what the user sees: a row renders slim iff it is in the
        // settled partition, so the menu label mirrors that exact state.
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              isSettled
                ? { id: "unsettle", label: "Un-settle thread" }
                : { id: "settle", label: "Settle thread" },
              { id: "mark-unread", label: "Mark unread" },
              { id: "archive", label: "Archive" },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "archive": {
            const result = await archiveThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      attemptSettle,
      attemptUnsettle,
      confirmThreadDelete,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setShowJumpHints(event.metaKey || event.ctrlKey);
    const clear = () => setShowJumpHints(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) return;
    autoAnimate(node, { duration: 150, easing: "ease-out" });
  }, []);

  const handleNewThreadClick = useCallback(() => {
    const firstProject = projects[0];
    if (!firstProject) return;
    if (isMobile) setOpenMobile(false);
    void handleNewThread(scopeProjectRef(firstProject.environmentId, firstProject.id));
  }, [handleNewThread, isMobile, projects, setOpenMobile]);

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                    data-testid="command-palette-trigger"
                  />
                }
              >
                <SearchIcon className="size-3.5 text-muted-foreground/70" />
                <span className="flex-1 truncate text-left text-xs">Search</span>
                {commandPaletteShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
                    {commandPaletteShortcutLabel}
                  </Kbd>
                ) : null}
              </CommandDialogTrigger>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={handleNewThreadClick}
                disabled={projects.length === 0}
              >
                <PlusIcon className="size-3.5 text-muted-foreground/70" />
                <span className="flex-1 truncate text-left text-xs">New thread</span>
                {newThreadShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
                    {newThreadShortcutLabel}
                  </Kbd>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-0.5">
            {orderedThreads.map((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              const isSettledRow = settledThreadKeys.has(threadKey);
              return (
                <SidebarV2Row
                  key={threadKey}
                  thread={thread}
                  variant={isSettledRow ? "slim" : "card"}
                  isActive={routeThreadKey === threadKey}
                  jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                  currentEnvironmentId={primaryEnvironmentId}
                  environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                  projectCwd={
                    projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                  }
                  providerEntryByInstanceId={providerEntryByInstanceId}
                  onThreadClick={handleThreadClick}
                  onContextMenu={handleThreadContextMenu}
                  onSettle={attemptSettle}
                  onUnsettle={attemptUnsettle}
                  onChangeRequestState={handleChangeRequestState}
                />
              );
            })}
          </ul>
          {orderedThreads.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">
              No threads yet
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}

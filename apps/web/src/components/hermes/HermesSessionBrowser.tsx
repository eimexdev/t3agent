import type { EnvironmentId, HermesBridgeSessionSummary, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { Clock3Icon, ImportIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildThreadRouteParams } from "~/threadRoutes";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { formatHermesSourceLabel } from "~/hermesLineage";
import { cn } from "~/lib/utils";
import {
  type HermesConversationBrowserMode,
  resolveHermesConversationSelection,
} from "./HermesSessionBrowser.logic";

interface HermesSessionBrowserProps {
  readonly environmentId: EnvironmentId;
  readonly mode?: HermesConversationBrowserMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function sessionTitle(session: HermesBridgeSessionSummary): string {
  return session.title ?? `${session.source} conversation`;
}

function sessionTimestamp(session: HermesBridgeSessionSummary): string {
  const timestamp = Date.parse(String(session.endedAt ?? session.startedAt));
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function HermesSessionBrowser({
  environmentId,
  mode = "open",
  open,
  onOpenChange,
}: HermesSessionBrowserProps) {
  const navigate = useNavigate();
  const listSessions = useAtomCommand(serverEnvironment.hermesSessionsList, {
    reportFailure: false,
  });
  const forkConversation = useAtomCommand(serverEnvironment.hermesConversationFork, {
    reportFailure: false,
  });
  const [sessions, setSessions] = useState<ReadonlyArray<HermesBridgeSessionSummary>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await listSessions({ environmentId, input: {} });
    setLoading(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Unable to load Hermes conversations.");
      return;
    }
    setSessions(result.value.sessions);
  }, [environmentId, listSessions]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    void refresh();
  }, [open, refresh]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return sessions;
    return sessions.filter((session) =>
      [sessionTitle(session), session.source, session.model]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, sessions]);
  const groups = useMemo(
    () => [
      {
        label: "T3 Agent",
        sessions: filtered.filter(
          (session) => session.source === "t3agent" && session.threadId !== undefined,
        ),
      },
      {
        label: "Other Hermes conversations",
        sessions: filtered.filter((session) => session.source !== "t3agent"),
      },
    ],
    [filtered],
  );

  const openThread = useCallback(
    (threadId: ThreadId) => {
      onOpenChange(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    },
    [environmentId, navigate, onOpenChange],
  );

  const forkSession = useCallback(
    async (session: HermesBridgeSessionSummary, forceNew: boolean) => {
      setBusySessionId(session.sessionId);
      setError(null);
      const result = await forkConversation({
        environmentId,
        input: {
          source: { type: "session", sessionId: session.sessionId },
          ...(forceNew ? { forceNew: true } : {}),
        },
      });
      setBusySessionId(null);
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? cause.message
            : mode === "fork"
              ? "Unable to fork the conversation."
              : "Unable to import the conversation.",
        );
        return;
      }
      openThread(result.value.threadId);
    },
    [environmentId, forkConversation, mode, openThread],
  );

  const selectSession = useCallback(
    (session: HermesBridgeSessionSummary) => {
      const selection = resolveHermesConversationSelection({ mode, session });
      switch (selection.type) {
        case "open-thread":
          openThread(selection.threadId);
          return;
        case "fork-session":
          void forkSession(session, selection.forceNew);
          return;
      }
    },
    [forkSession, mode, openThread],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[min(42rem,calc(100dvh-2rem))] w-[min(42rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>
            {mode === "fork" ? "Fork conversation" : "Open Hermes conversation"}
          </DialogTitle>
          <DialogDescription>
            {mode === "fork"
              ? "Select any Hermes conversation to create a new child copy."
              : "Open a T3 Agent conversation or import a child copy from another Hermes gateway."}
          </DialogDescription>
          <div className="relative pt-2">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations"
              className="pl-9"
            />
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-5 px-3">
          {error ? (
            <div className="mx-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-sm">
              {error}
            </div>
          ) : null}
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading Hermes conversations…
            </div>
          ) : null}
          {!loading && groups.every((group) => group.sessions.length === 0) && error === null ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              No matching Hermes conversations.
            </div>
          ) : null}
          {groups.map((group) =>
            group.sessions.length > 0 ? (
              <section key={group.label} aria-label={group.label}>
                <div className="px-3 pb-1.5 font-medium text-muted-foreground text-xs">
                  {group.label}
                </div>
                <div className="space-y-1">
                  {group.sessions.map((session) => {
                    const selection = resolveHermesConversationSelection({ mode, session });
                    const busy = busySessionId === session.sessionId;
                    return (
                      <div
                        key={session.sessionId}
                        className={cn(
                          "group flex min-w-0 items-center gap-2 rounded-xl border border-transparent px-3 py-2 transition-colors",
                          "hover:border-border/60 hover:bg-muted/55",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left outline-none"
                          disabled={busy}
                          onClick={() => selectSession(session)}
                        >
                          <div className="truncate font-medium text-sm">
                            {sessionTitle(session)}
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                            <span>{formatHermesSourceLabel(session.source)}</span>
                            {session.model ? (
                              <span className="truncate">{session.model}</span>
                            ) : null}
                            <span className="flex shrink-0 items-center gap-1">
                              <Clock3Icon className="size-3" />
                              {sessionTimestamp(session)}
                            </span>
                            <span className="shrink-0">
                              {session.messageCount}{" "}
                              {session.messageCount === 1 ? "message" : "messages"}
                            </span>
                          </div>
                        </button>
                        {busy ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                        {mode === "open" &&
                        session.source !== "t3agent" &&
                        selection.type === "open-thread" &&
                        !busy ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground"
                            title="Import another child copy"
                            onClick={() => void forkSession(session, true)}
                          >
                            <ImportIcon className="size-3.5" />
                            Import another copy
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null,
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

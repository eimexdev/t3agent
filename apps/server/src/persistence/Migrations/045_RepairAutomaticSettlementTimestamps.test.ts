import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_RepairAutomaticSettlementTimestamps", (it) => {
  it.effect("repairs automatic stamps without changing later manual settlement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          latest_turn_id,
          created_at,
          updated_at,
          latest_user_message_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES
          (
            'thread-auto',
            'project-1',
            'Automatic',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}',
            'turn-auto',
            '2026-05-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z',
            '2026-06-01T00:00:00.000Z',
            'settled',
            '2026-09-01T00:00:00.000Z',
            NULL
          ),
          (
            'thread-manual',
            'project-1',
            'Manual',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}',
            NULL,
            '2026-05-01T00:00:00.000Z',
            '2026-08-10T00:00:00.000Z',
            '2026-06-10T00:00:00.000Z',
            'settled',
            '2026-08-10T00:00:00.000Z',
            NULL
          ),
          (
            'thread-resettled',
            'project-1',
            'Manually re-settled',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}',
            NULL,
            '2026-05-01T00:00:00.000Z',
            '2026-09-02T00:00:00.000Z',
            '2026-06-05T00:00:00.000Z',
            'settled',
            '2026-09-02T00:00:00.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          ('message-auto', 'thread-auto', 'turn-auto', 'user', 'Prompt', 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          ('message-manual', 'thread-manual', NULL, 'user', 'Prompt', 0, '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z'),
          ('message-resettled', 'thread-resettled', NULL, 'user', 'Prompt', 0, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z')
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'thread-auto',
          'turn-auto',
          'completed',
          '2026-06-02T00:00:00.000Z',
          '2026-06-02T00:01:00.000Z',
          '2026-06-03T00:00:00.000Z',
          '[]'
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-auto', 'thread', 'thread-auto', 0, 'thread.settled',
            '2026-09-01T00:00:00.000Z',
            'server:auto-settle:thread-auto:uuid', NULL, 'server:auto-settle:thread-auto:uuid', 'server',
            '{"threadId":"thread-auto","settledAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}', '{}'
          ),
          (
            'event-auto-repeat', 'thread', 'thread-auto', 1, 'thread.settled',
            '2026-09-01T00:00:05.000Z',
            'command-repeat', NULL, 'command-repeat', 'client',
            '{"threadId":"thread-auto","settledAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}', '{}'
          ),
          (
            'event-manual', 'thread', 'thread-manual', 0, 'thread.settled',
            '2026-08-10T00:00:00.000Z',
            'command-manual', NULL, 'command-manual', 'client',
            '{"threadId":"thread-manual","settledAt":"2026-08-10T00:00:00.000Z","updatedAt":"2026-08-10T00:00:00.000Z"}', '{}'
          ),
          (
            'event-resettled-auto', 'thread', 'thread-resettled', 0, 'thread.settled',
            '2026-09-01T00:00:00.000Z',
            'server:auto-settle:thread-resettled:uuid', NULL, 'server:auto-settle:thread-resettled:uuid', 'server',
            '{"threadId":"thread-resettled","settledAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}', '{}'
          ),
          (
            'event-resettled-manual', 'thread', 'thread-resettled', 1, 'thread.settled',
            '2026-09-02T00:00:00.000Z',
            'command-resettled-manual', NULL, 'command-resettled-manual', 'client',
            '{"threadId":"thread-resettled","settledAt":"2026-09-02T00:00:00.000Z","updatedAt":"2026-09-02T00:00:00.000Z"}', '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const threads = yield* sql<{
        readonly threadId: string;
        readonly settledAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          settled_at AS "settledAt",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threads, [
        {
          threadId: "thread-auto",
          settledAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          threadId: "thread-manual",
          settledAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
        {
          threadId: "thread-resettled",
          settledAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ]);

      const events = yield* sql<{
        readonly eventId: string;
        readonly settledAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          event_id AS "eventId",
          json_extract(payload_json, '$.settledAt') AS "settledAt",
          json_extract(payload_json, '$.updatedAt') AS "updatedAt"
        FROM orchestration_events
        WHERE event_type = 'thread.settled'
        ORDER BY event_id
      `;
      assert.deepStrictEqual(events, [
        {
          eventId: "event-auto",
          settledAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          eventId: "event-auto-repeat",
          settledAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          eventId: "event-manual",
          settledAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
        {
          eventId: "event-resettled-auto",
          settledAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          eventId: "event-resettled-manual",
          settledAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ]);
    }),
  );
});

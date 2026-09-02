import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS automatic_settlement_timestamp_repairs`;
  yield* sql`
    CREATE TEMP TABLE automatic_settlement_timestamp_repairs AS
    WITH activity_timestamps AS (
      SELECT thread_id, created_at AS activity_at
      FROM projection_thread_messages
      WHERE role = 'user'
      UNION ALL
      SELECT thread_id, requested_at
      FROM projection_turns
      UNION ALL
      SELECT thread_id, started_at
      FROM projection_turns
      WHERE started_at IS NOT NULL
      UNION ALL
      SELECT thread_id, completed_at
      FROM projection_turns
      WHERE completed_at IS NOT NULL
    )
    SELECT
      automatic.stream_id AS thread_id,
      json_extract(automatic.payload_json, '$.settledAt') AS incorrect_settled_at,
      COALESCE(
        (
          SELECT activity.activity_at
          FROM activity_timestamps AS activity
          WHERE activity.thread_id = automatic.stream_id
            AND julianday(activity.activity_at) IS NOT NULL
            AND julianday(activity.activity_at) <= julianday(automatic.occurred_at)
          ORDER BY julianday(activity.activity_at) DESC
          LIMIT 1
        ),
        thread.created_at
      ) AS corrected_settled_at
    FROM orchestration_events AS automatic
    INNER JOIN projection_threads AS thread
      ON thread.thread_id = automatic.stream_id
    WHERE automatic.aggregate_kind = 'thread'
      AND automatic.event_type = 'thread.settled'
      AND automatic.actor_kind = 'server'
      AND automatic.command_id LIKE 'server:auto-settle:%'
      AND json_type(automatic.payload_json, '$.settledAt') = 'text'
      AND json_extract(automatic.payload_json, '$.settledAt') = automatic.occurred_at
  `;

  yield* sql`
    UPDATE projection_threads AS thread
    SET settled_at = (
      SELECT repair.corrected_settled_at
      FROM automatic_settlement_timestamp_repairs AS repair
      WHERE repair.thread_id = thread.thread_id
        AND repair.incorrect_settled_at = thread.settled_at
      LIMIT 1
    )
    WHERE thread.settled_override = 'settled'
      AND EXISTS (
        SELECT 1
        FROM automatic_settlement_timestamp_repairs AS repair
        WHERE repair.thread_id = thread.thread_id
          AND repair.incorrect_settled_at = thread.settled_at
      )
  `;

  // Repeated manual settlement preserves the original stamp. Repair those
  // re-emissions too so rebuilding projections cannot restore the bad value.
  yield* sql`
    UPDATE orchestration_events AS settled
    SET payload_json = json_set(
      settled.payload_json,
      '$.settledAt',
      (
        SELECT repair.corrected_settled_at
        FROM automatic_settlement_timestamp_repairs AS repair
        WHERE repair.thread_id = settled.stream_id
          AND repair.incorrect_settled_at = json_extract(settled.payload_json, '$.settledAt')
        LIMIT 1
      )
    )
    WHERE settled.aggregate_kind = 'thread'
      AND settled.event_type = 'thread.settled'
      AND EXISTS (
        SELECT 1
        FROM automatic_settlement_timestamp_repairs AS repair
        WHERE repair.thread_id = settled.stream_id
          AND repair.incorrect_settled_at = json_extract(settled.payload_json, '$.settledAt')
      )
  `;

  yield* sql`DROP TABLE automatic_settlement_timestamp_repairs`;
});

import { randomUUID } from "crypto";
import { getDatabase } from "./db";

export function forkSession(sourceSessionId: string): string | null {
  const db = getDatabase();
  const source = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sourceSessionId) as
    | Record<string, unknown>
    | undefined;
  if (!source) return null;

  const newId = randomUUID().replace(/-/g, "").slice(0, 12);
  const now = new Date().toISOString();
  const title = typeof source.title === "string" && source.title ? `${source.title} (fork)` : null;

  db.transaction(() => {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, parent_id, title, recap_text, recap_model, recap_updated_at, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    ).run(
      newId,
      source.workspace_id,
      title,
      source.recap_text ?? null,
      source.recap_model ?? null,
      source.recap_updated_at ?? null,
      source.model,
      source.mode,
      source.cwd_at_start,
      source.cwd_last,
      now,
      now,
    );

    const messages = db
      .prepare("SELECT seq, role, message_json, created_at FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sourceSessionId) as Array<{ seq: number; role: string; message_json: string; created_at: string }>;
    const insertMessage = db.prepare(
      "INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const message of messages) {
      insertMessage.run(newId, message.seq, message.role, message.message_json, message.created_at);
    }

    const toolCalls = db
      .prepare(
        "SELECT id, message_seq, tool_call_id, tool_name, args_json, status, started_at, completed_at FROM tool_calls WHERE session_id = ? ORDER BY id ASC",
      )
      .all(sourceSessionId) as Array<{
      id: number;
      message_seq: number;
      tool_call_id: string;
      tool_name: string;
      args_json: string;
      status: string;
      started_at: string;
      completed_at: string | null;
    }>;
    const idMap = new Map<number, number>();
    const insertToolCall = db.prepare(
      "INSERT INTO tool_calls (session_id, message_seq, tool_call_id, tool_name, args_json, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const call of toolCalls) {
      const result = insertToolCall.run(
        newId,
        call.message_seq,
        call.tool_call_id,
        call.tool_name,
        call.args_json,
        call.status,
        call.started_at,
        call.completed_at,
      ) as { lastInsertRowid?: number | bigint };
      idMap.set(call.id, Number(result.lastInsertRowid ?? 0));
    }

    const results = db
      .prepare(
        "SELECT tool_call_row_id, output_kind, output_json, success, created_at FROM tool_results WHERE tool_call_row_id IN (SELECT id FROM tool_calls WHERE session_id = ?)",
      )
      .all(sourceSessionId) as Array<{
      tool_call_row_id: number;
      output_kind: string;
      output_json: string;
      success: number;
      created_at: string;
    }>;
    const insertResult = db.prepare(
      "INSERT INTO tool_results (tool_call_row_id, output_kind, output_json, success, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const result of results) {
      const newRowId = idMap.get(result.tool_call_row_id);
      if (newRowId == null) continue;
      insertResult.run(newRowId, result.output_kind, result.output_json, result.success, result.created_at);
    }

    const thoughts = db
      .prepare("SELECT message_seq, duration_ms, text, created_at FROM thoughts WHERE session_id = ?")
      .all(sourceSessionId) as Array<{ message_seq: number; duration_ms: number; text: string; created_at: string }>;
    const insertThought = db.prepare(
      "INSERT INTO thoughts (session_id, message_seq, duration_ms, text, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const thought of thoughts) {
      insertThought.run(newId, thought.message_seq, thought.duration_ms, thought.text, thought.created_at);
    }

    const compactions = db
      .prepare(
        "SELECT first_kept_seq, summary, tokens_before, created_at FROM compactions WHERE session_id = ? ORDER BY id ASC",
      )
      .all(sourceSessionId) as Array<{
      first_kept_seq: number;
      summary: string;
      tokens_before: number;
      created_at: string;
    }>;
    const insertCompaction = db.prepare(
      "INSERT INTO compactions (session_id, first_kept_seq, summary, tokens_before, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const compaction of compactions) {
      insertCompaction.run(
        newId,
        compaction.first_kept_seq,
        compaction.summary,
        compaction.tokens_before,
        compaction.created_at,
      );
    }
  })();

  return newId;
}

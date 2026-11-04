import { getDatabase } from "./db";
import { appendMessages } from "./transcript";

export interface TurnClaim {
  pid: number;
  startedAt: string;
  preview: string;
}

export function getTurnClaim(sessionId: string): TurnClaim | null {
  const row = getDatabase()
    .prepare("SELECT pid, started_at, preview FROM turn_claims WHERE session_id = ?")
    .get(sessionId) as { pid: number; started_at: string; preview: string } | undefined;
  if (!row) return null;
  return { pid: row.pid, startedAt: row.started_at, preview: row.preview };
}

export function setTurnClaim(sessionId: string, preview: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO turn_claims (session_id, pid, started_at, preview) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, preview = excluded.preview",
    )
    .run(sessionId, process.pid, new Date().toISOString(), preview);
}

export function clearTurnClaim(sessionId: string): void {
  getDatabase().prepare("DELETE FROM turn_claims WHERE session_id = ?").run(sessionId);
}

export function getTurnDraft(sessionId: string): string | null {
  const row = getDatabase().prepare("SELECT text FROM turn_drafts WHERE session_id = ?").get(sessionId) as
    | { text: string }
    | undefined;
  return row?.text ?? null;
}

export function upsertTurnDraft(sessionId: string, text: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO turn_drafts (session_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
    )
    .run(sessionId, text, new Date().toISOString());
}

export function deleteTurnDraft(sessionId: string): void {
  getDatabase().prepare("DELETE FROM turn_drafts WHERE session_id = ?").run(sessionId);
}

export function deletePersistedMessage(sessionId: string, seq: number): void {
  getDatabase().prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?").run(sessionId, seq);
}

export interface InboxItem {
  id: number;
  text: string;
  displayText: string;
}

export function enqueueInbox(sessionId: string, text: string, displayText: string): number {
  const result = getDatabase()
    .prepare("INSERT INTO inbox (session_id, text, display_text, created_at) VALUES (?, ?, ?, ?)")
    .run(sessionId, text, displayText, new Date().toISOString()) as {
    lastInsertRowid?: number | bigint;
  };
  return Number(result.lastInsertRowid ?? 0);
}

export function listInbox(sessionId: string): InboxItem[] {
  const rows = getDatabase()
    .prepare("SELECT id, text, display_text FROM inbox WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId) as Array<{ id: number; text: string; display_text: string }>;
  return rows.map((row) => ({ id: row.id, text: row.text, displayText: row.display_text }));
}

export function deleteInboxItem(id: number): void {
  getDatabase().prepare("DELETE FROM inbox WHERE id = ?").run(id);
}

export function clearInbox(sessionId: string): void {
  getDatabase().prepare("DELETE FROM inbox WHERE session_id = ?").run(sessionId);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

export function sweepInterruptedTurn(sessionId: string): boolean {
  const claim = getTurnClaim(sessionId);
  if (!claim) return false;
  if (claim.pid !== process.pid && isPidAlive(claim.pid)) return false;

  const draft = getTurnDraft(sessionId);
  let note = "[Interrupted: the previous turn ended unexpectedly and did not finish.]";
  if (claim.preview && !draft) {
    note += ` It started with: "${claim.preview}"`;
  }
  const content = draft ? `${draft}\n\n${note}` : note;
  appendMessages(sessionId, [{ role: "assistant", content }]);
  deleteTurnDraft(sessionId);
  clearTurnClaim(sessionId);
  return true;
}

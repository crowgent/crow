import { getDatabase } from "./db";

export type TodoStatus = "open" | "done";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  createdAt: string;
}

interface TodoRow {
  id: number;
  text: string;
  status: string;
  created_at: string;
}

function toTodoItem(row: TodoRow): TodoItem {
  return {
    id: row.id,
    text: row.text,
    status: row.status === "done" ? "done" : "open",
    createdAt: row.created_at,
  };
}

export function listTodos(sessionId: string): TodoItem[] {
  const rows = getDatabase()
    .prepare("SELECT id, text, status, created_at FROM todos WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId) as TodoRow[];
  return rows.map(toTodoItem);
}

export function addTodo(sessionId: string, text: string): TodoItem {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare("INSERT INTO todos (session_id, text, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)")
    .run(sessionId, text, now, now) as { lastInsertRowid?: number | bigint };
  const id = Number(result.lastInsertRowid ?? 0);
  return { id, text, status: "open", createdAt: now };
}

export function setTodoStatus(sessionId: string, id: number, status: TodoStatus): boolean {
  const result = getDatabase()
    .prepare("UPDATE todos SET status = ?, updated_at = ? WHERE session_id = ? AND id = ?")
    .run(status, new Date().toISOString(), sessionId, id) as { changes?: number };
  return Number(result.changes ?? 0) > 0;
}

export function removeTodo(sessionId: string, id: number): boolean {
  const result = getDatabase().prepare("DELETE FROM todos WHERE session_id = ? AND id = ?").run(sessionId, id) as {
    changes?: number;
  };
  return Number(result.changes ?? 0) > 0;
}

export function clearTodos(sessionId: string): void {
  getDatabase().prepare("DELETE FROM todos WHERE session_id = ?").run(sessionId);
}

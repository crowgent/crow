import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { SessionListEntry } from "../storage/index";
import type { Theme } from "./theme";

export function filterSessionRows(rows: SessionListEntry[], query: string): SessionListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (row) =>
      (row.title ?? "").toLowerCase().includes(q) ||
      row.model.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q),
  );
}

function formatSessionTime(date: Date): string {
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays <= 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })} ${time}`;
}

export function SessionModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
  currentId,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: SessionListEntry[];
  currentId: string | null;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`session-${selected.id}`);
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount * 2 + 8;
  const panelHeight = Math.min(contentHeight, Math.floor(height * 0.6));
  const panelWidth = Math.min(72, width - 6);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={Math.max(2, Math.floor((height - panelHeight) / 2))}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Sessions"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search by title, model, id..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.map((row, idx) => {
            const selected = idx === selectedIndex;
            const isCurrent = row.id === currentId;
            return (
              <box
                key={`session-${row.id}`}
                id={`session-${row.id}`}
                width="100%"
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={selected ? t.primary : t.text}>
                    <b>{row.title || "Untitled session"}</b>
                    {isCurrent ? " (current)" : ""}
                  </text>
                  <text fg={t.textMuted}>{formatSessionTime(row.updatedAt)}</text>
                </box>
                <box width="100%">
                  <text fg={t.textMuted}>
                    {row.model} · {row.messageCount} messages · {row.id}
                  </text>
                </box>
              </box>
            );
          })}
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{"No sessions yet"}</text>
            </box>
          ) : null}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"switch · "}</span>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"navigate"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

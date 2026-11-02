import type { Api } from "grammy";

const TYPING_REFRESH_MS = 3500;

export function startTypingRefresh(
  api: Api,
  chatId: number | string,
  messageThreadId: number | undefined,
  enabled: boolean,
): () => void {
  if (!enabled) return () => {};
  const tick = () => void api.sendChatAction(chatId, "typing", { message_thread_id: messageThreadId }).catch(() => {});
  tick();
  const id = setInterval(tick, TYPING_REFRESH_MS);
  return () => clearInterval(id);
}

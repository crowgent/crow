export const TELEGRAM_MAX_MESSAGE = 4096;

export const TELEGRAM_RICH_MAX_MESSAGE = 32768;

export function splitTelegramMessage(text: string, limit: number = TELEGRAM_MAX_MESSAGE): string[] {
  if (!text) return [];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    parts.push(text.slice(i, i + limit));
  }
  return parts;
}

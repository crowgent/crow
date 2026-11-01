import type { Api } from "grammy";
import type { StreamChunk } from "../types/index";
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE, TELEGRAM_RICH_MAX_MESSAGE } from "./limits";
import { editEphemeralMessageText, sendRichMessage, sendRichMessageDraft } from "./rich-api";
import { startTypingRefresh } from "./typing-refresh";

const EDIT_THROTTLE_MS = 350;
const EDIT_MIN_CHARS = 48;

export interface TelegramRichStreamCallbacks {
  onAssistantMessage?: (event: { content: string; done: boolean }) => void;
  onToolCalls?: (toolCalls: NonNullable<StreamChunk["toolCalls"]>) => void;
  onToolResult?: (event: {
    toolCall: NonNullable<StreamChunk["toolCall"]>;
    toolResult: NonNullable<StreamChunk["toolResult"]>;
  }) => void;
  onPreviewError?: (message: string) => void;
}

export interface TelegramRichStreamArgs extends TelegramRichStreamCallbacks {
  api: Api;
  token: string;
  apiRoot?: string;
  chatId: number | string;
  messageThreadId?: number;
  typingIndicator: boolean;
  stream: AsyncIterable<StreamChunk>;
  reply: (text: string) => Promise<unknown>;
}

async function runStream(
  args: TelegramRichStreamArgs,
  preview: (text: string) => Promise<void>,
  finalize: (text: string, previewBroken: boolean) => Promise<void>,
): Promise<void> {
  const stopTyping = startTypingRefresh(args.api, args.chatId, args.messageThreadId, args.typingIndicator);
  let acc = "";
  let lastPreviewAt = 0;
  let lastPreviewLen = 0;
  let previewBroken = false;
  let previewErrorReported = false;
  const maybePreview = async (force: boolean) => {
    if (previewBroken) return;
    const now = Date.now();
    const delta = acc.length - lastPreviewLen;
    if (!force && now - lastPreviewAt < EDIT_THROTTLE_MS && delta < EDIT_MIN_CHARS) return;
    try {
      await preview(acc.slice(0, TELEGRAM_RICH_MAX_MESSAGE));
      lastPreviewAt = Date.now();
      lastPreviewLen = acc.length;
    } catch (err) {
      previewBroken = true;
      if (!previewErrorReported) {
        previewErrorReported = true;
        args.onPreviewError?.(err instanceof Error ? err.message : String(err));
      }
    }
  };
  try {
    try {
      for await (const chunk of args.stream) {
        switch (chunk.type) {
          case "content":
            if (chunk.content) {
              acc += chunk.content;
              args.onAssistantMessage?.({ content: acc, done: false });
              if (acc) await maybePreview(false);
            }
            break;
          case "tool_calls":
            if (chunk.toolCalls) args.onToolCalls?.(chunk.toolCalls);
            break;
          case "tool_result":
            if (chunk.toolCall && chunk.toolResult) {
              args.onToolResult?.({ toolCall: chunk.toolCall, toolResult: chunk.toolResult });
            }
            break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errText = `Error: ${msg.slice(0, TELEGRAM_MAX_MESSAGE)}`;
      args.onAssistantMessage?.({ content: errText, done: true });
      await finalize(errText, previewBroken);
      return;
    }
    const trimmed = acc.trim() || "(no text output)";
    args.onAssistantMessage?.({ content: trimmed, done: true });
    await finalize(trimmed, previewBroken);
  } finally {
    stopTyping();
  }
}

export async function runTelegramRichDraftReply(args: TelegramRichStreamArgs & { draftId: number }): Promise<void> {
  const target = { chatId: args.chatId, messageThreadId: args.messageThreadId };
  let previewErrorReported = false;
  const preview = async (text: string) => {
    try {
      await sendRichMessageDraft(args.token, target, args.draftId, text, args.apiRoot);
    } catch (err) {
      if (!previewErrorReported) {
        previewErrorReported = true;
        args.onPreviewError?.(err instanceof Error ? err.message : String(err));
      }
    }
  };
  const finalize = async (text: string) => {
    if (text.length <= TELEGRAM_RICH_MAX_MESSAGE) {
      try {
        await sendRichMessage(args.token, target, text, undefined, args.apiRoot);
        return;
      } catch {}
    }
    for (const part of splitTelegramMessage(text)) {
      await args.reply(part);
    }
  };
  await runStream(args, preview, finalize);
}

export async function runTelegramEphemeralReply(
  args: TelegramRichStreamArgs & { receiverUserId: number },
): Promise<void> {
  const target = { chatId: args.chatId, messageThreadId: args.messageThreadId };
  let ephemeralMessageId: number | undefined;
  const preview = async (text: string) => {
    if (ephemeralMessageId === undefined) {
      const sent = await sendRichMessage(args.token, target, text, args.receiverUserId, args.apiRoot);
      if (sent.ephemeral_message_id === undefined) {
        throw new Error("Ephemeral message id missing");
      }
      ephemeralMessageId = sent.ephemeral_message_id;
      return;
    }
    await editEphemeralMessageText(
      args.token,
      args.chatId,
      args.receiverUserId,
      ephemeralMessageId,
      text,
      args.apiRoot,
    );
  };
  const finalize = async (text: string, previewBroken: boolean) => {
    if (!previewBroken && ephemeralMessageId !== undefined) {
      try {
        await editEphemeralMessageText(
          args.token,
          args.chatId,
          args.receiverUserId,
          ephemeralMessageId,
          text,
          args.apiRoot,
        );
        return;
      } catch {}
    }
    try {
      if (text.length <= TELEGRAM_RICH_MAX_MESSAGE) {
        await sendRichMessage(args.token, target, text, args.receiverUserId, args.apiRoot);
        return;
      }
      for (const part of splitTelegramMessage(text, TELEGRAM_RICH_MAX_MESSAGE)) {
        await sendRichMessage(args.token, target, part, args.receiverUserId, args.apiRoot);
      }
    } catch {
      for (const part of splitTelegramMessage(text)) {
        await args.reply(part);
      }
    }
  };
  await runStream(args, preview, finalize);
}

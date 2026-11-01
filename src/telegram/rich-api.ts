export interface TelegramBotMessage {
  message_id: number;
  ephemeral_message_id?: number;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: TelegramBotMessage | boolean;
}

async function callBotApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramBotMessage | boolean> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as TelegramApiResponse;
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result as TelegramBotMessage | boolean;
}

export interface RichMessageTarget {
  chatId: number | string;
  messageThreadId?: number;
}

export async function sendRichMessageDraft(
  token: string,
  target: RichMessageTarget,
  draftId: number,
  markdown: string,
): Promise<void> {
  await callBotApi(token, "sendRichMessageDraft", {
    chat_id: target.chatId,
    message_thread_id: target.messageThreadId,
    draft_id: draftId,
    rich_message: { markdown },
  });
}

export async function sendRichMessage(
  token: string,
  target: RichMessageTarget,
  markdown: string,
  ephemeralReceiverUserId?: number,
): Promise<TelegramBotMessage> {
  const body: Record<string, unknown> = {
    chat_id: target.chatId,
    message_thread_id: target.messageThreadId,
    rich_message: { markdown },
  };
  if (ephemeralReceiverUserId !== undefined) {
    body.ephemeral_message_parameters = { receiver_user_id: ephemeralReceiverUserId };
  }
  const result = await callBotApi(token, "sendRichMessage", body);
  return result as TelegramBotMessage;
}

export async function sendEphemeralText(
  token: string,
  target: RichMessageTarget,
  receiverUserId: number,
  text: string,
): Promise<TelegramBotMessage> {
  const result = await callBotApi(token, "sendMessage", {
    chat_id: target.chatId,
    message_thread_id: target.messageThreadId,
    text,
    ephemeral_message_parameters: { receiver_user_id: receiverUserId },
  });
  return result as TelegramBotMessage;
}

export async function editEphemeralMessageText(
  token: string,
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
  markdown: string,
): Promise<void> {
  await callBotApi(token, "editEphemeralMessageText", {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
    rich_message: { markdown },
  });
}

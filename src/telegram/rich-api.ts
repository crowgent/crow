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
  apiRoot = "https://api.telegram.org",
): Promise<TelegramBotMessage | boolean> {
  const response = await fetch(`${apiRoot}/bot${token}/${method}`, {
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
  apiRoot?: string,
): Promise<void> {
  await callBotApi(
    token,
    "sendRichMessageDraft",
    {
      chat_id: target.chatId,
      message_thread_id: target.messageThreadId,
      draft_id: draftId,
      rich_message: { markdown },
    },
    apiRoot,
  );
}

export async function sendRichMessage(
  token: string,
  target: RichMessageTarget,
  markdown: string,
  ephemeralReceiverUserId?: number,
  apiRoot?: string,
): Promise<TelegramBotMessage> {
  const body: Record<string, unknown> = {
    chat_id: target.chatId,
    message_thread_id: target.messageThreadId,
    rich_message: { markdown },
  };
  if (ephemeralReceiverUserId !== undefined) {
    body.ephemeral_message_parameters = { receiver_user_id: ephemeralReceiverUserId };
  }
  const result = await callBotApi(token, "sendRichMessage", body, apiRoot);
  return result as TelegramBotMessage;
}

export async function sendEphemeralText(
  token: string,
  target: RichMessageTarget,
  receiverUserId: number,
  text: string,
  apiRoot?: string,
): Promise<TelegramBotMessage> {
  const result = await callBotApi(
    token,
    "sendMessage",
    {
      chat_id: target.chatId,
      message_thread_id: target.messageThreadId,
      text,
      ephemeral_message_parameters: { receiver_user_id: receiverUserId },
    },
    apiRoot,
  );
  return result as TelegramBotMessage;
}

export async function editEphemeralMessageText(
  token: string,
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
  markdown: string,
  apiRoot?: string,
): Promise<void> {
  await callBotApi(
    token,
    "editEphemeralMessageText",
    {
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
      rich_message: { markdown },
    },
    apiRoot,
  );
}

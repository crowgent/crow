import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editEphemeralMessageText,
  sendEphemeralText,
  sendRichMessage,
  sendRichMessageDraft,
} from "../../src/telegram/rich-api";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function okResult(result: unknown) {
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result }) });
}

function lastBody() {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function lastUrl() {
  return fetchMock.mock.calls.at(-1)?.[0] as string;
}

describe("rich-api", () => {
  it("sends a rich draft with chat, draft id and markdown", async () => {
    okResult(true);
    await sendRichMessageDraft("tok", { chatId: 11, messageThreadId: 3 }, 99, "# hi");
    expect(lastUrl()).toBe("https://api.telegram.org/bottok/sendRichMessageDraft");
    expect(lastBody()).toEqual({
      chat_id: 11,
      message_thread_id: 3,
      draft_id: 99,
      rich_message: { markdown: "# hi" },
    });
  });

  it("sends a rich message and returns the sent message", async () => {
    okResult({ message_id: 5 });
    const sent = await sendRichMessage("tok", { chatId: 11 }, "hello");
    expect(lastUrl()).toBe("https://api.telegram.org/bottok/sendRichMessage");
    expect(lastBody()).toEqual({
      chat_id: 11,
      rich_message: { markdown: "hello" },
    });
    expect(sent).toEqual({ message_id: 5 });
  });

  it("attaches ephemeral parameters to a rich message for group replies", async () => {
    okResult({ message_id: 9, ephemeral_message_id: 42 });
    const sent = await sendRichMessage("tok", { chatId: 11 }, "hello", 77);
    expect(lastBody()).toMatchObject({
      ephemeral_message_parameters: { receiver_user_id: 77 },
    });
    expect(sent.ephemeral_message_id).toBe(42);
  });

  it("sends ephemeral text with receiver parameters", async () => {
    okResult({ message_id: 9, ephemeral_message_id: 42 });
    await sendEphemeralText("tok", { chatId: 11 }, 77, "hello");
    expect(lastUrl()).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(lastBody()).toEqual({
      chat_id: 11,
      text: "hello",
      ephemeral_message_parameters: { receiver_user_id: 77 },
    });
  });

  it("edits an ephemeral message with rich markdown", async () => {
    okResult(true);
    await editEphemeralMessageText("tok", 11, 77, 42, "hello **world**");
    expect(lastUrl()).toBe("https://api.telegram.org/bottok/editEphemeralMessageText");
    expect(lastBody()).toEqual({
      chat_id: 11,
      receiver_user_id: 77,
      ephemeral_message_id: 42,
      rich_message: { markdown: "hello **world**" },
    });
  });

  it("uses a custom api root when given", async () => {
    okResult({ message_id: 5 });
    await sendRichMessage("tok", { chatId: 11 }, "hello", undefined, "http://127.0.0.1:9");
    expect(lastUrl()).toBe("http://127.0.0.1:9/bottok/sendRichMessage");
  });

  it("throws the api description on failure", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, description: "Bad Request: bad markdown" }) });
    await expect(sendRichMessage("tok", { chatId: 11 }, "hi")).rejects.toThrow("Bad Request: bad markdown");
  });
});

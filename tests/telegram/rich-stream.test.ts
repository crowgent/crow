import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelegramEphemeralReply, runTelegramRichDraftReply } from "../../src/telegram/rich-stream";
import type { StreamChunk } from "../../src/types/index";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function calls() {
  return fetchMock.mock.calls.map(([url, init]) => {
    const method = (url as string).split("/").pop();
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    return { method, body };
  });
}

function okResult(result: unknown) {
  return { json: async () => ({ ok: true, result }) };
}

async function* contentStream(parts: string[]): AsyncIterable<StreamChunk> {
  for (const part of parts) {
    yield { type: "content", content: part };
  }
}

const baseArgs = {
  api: {} as unknown as Api,
  token: "tok",
  chatId: 11,
  typingIndicator: false,
  reply: vi.fn().mockResolvedValue(undefined),
};

describe("runTelegramRichDraftReply", () => {
  it("streams drafts then persists with sendRichMessage", async () => {
    fetchMock.mockResolvedValue(okResult({ message_id: 5 }));
    const onAssistantMessage = vi.fn();
    await runTelegramRichDraftReply({
      ...baseArgs,
      draftId: 99,
      stream: contentStream(["a".repeat(100)]),
      reply: vi.fn().mockResolvedValue(undefined),
      onAssistantMessage,
    });
    const made = calls();
    expect(made[0]?.method).toBe("sendRichMessageDraft");
    expect(made[0]?.body).toMatchObject({ chat_id: 11, draft_id: 99 });
    expect(made.at(-1)?.method).toBe("sendRichMessage");
    expect(made.at(-1)?.body).toMatchObject({ rich_message: { markdown: "a".repeat(100) } });
    expect(onAssistantMessage).toHaveBeenLastCalledWith({ content: "a".repeat(100), done: true });
  });

  it("falls back to plain replies when the final rich send fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("sendRichMessage")) {
        return { json: async () => ({ ok: false, description: "Bad Request" }) };
      }
      return okResult(true);
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    await runTelegramRichDraftReply({
      ...baseArgs,
      draftId: 99,
      stream: contentStream(["hello"]),
      reply,
    });
    expect(reply).toHaveBeenCalledWith("hello");
  });
});

describe("runTelegramEphemeralReply", () => {
  it("sends an ephemeral rich message then edits it", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("sendRichMessage")) {
        return okResult({ message_id: 9, ephemeral_message_id: 42 });
      }
      return okResult(true);
    });
    await runTelegramEphemeralReply({
      ...baseArgs,
      receiverUserId: 77,
      stream: contentStream(["hello", " world"]),
    });
    const made = calls();
    expect(made[0]).toMatchObject({
      method: "sendRichMessage",
      body: { ephemeral_message_parameters: { receiver_user_id: 77 } },
    });
    expect(made.at(-1)).toMatchObject({
      method: "editEphemeralMessageText",
      body: { receiver_user_id: 77, ephemeral_message_id: 42 },
    });
  });

  it("sends a fresh ephemeral message when edits break", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("sendRichMessage")) {
        return okResult({ message_id: 9, ephemeral_message_id: 42 });
      }
      if (url.endsWith("editEphemeralMessageText")) {
        return { json: async () => ({ ok: false, description: "gone" }) };
      }
      return okResult(true);
    });
    await runTelegramEphemeralReply({
      ...baseArgs,
      receiverUserId: 77,
      stream: contentStream(["hello world this is a long enough chunk to pass the preview gate........"]),
    });
    const richSends = calls().filter((call) => call.method === "sendRichMessage");
    expect(richSends.length).toBe(2);
  });
});

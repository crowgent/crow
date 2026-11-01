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

  it("sends a 5000 character answer as one rich message, not splits", async () => {
    fetchMock.mockResolvedValue(okResult({ message_id: 5 }));
    const reply = vi.fn().mockResolvedValue(undefined);
    const text = "x".repeat(5000);
    await runTelegramRichDraftReply({
      ...baseArgs,
      draftId: 99,
      stream: contentStream([text]),
      reply,
    });
    expect(calls().at(-1)).toMatchObject({
      method: "sendRichMessage",
      body: { rich_message: { markdown: text } },
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("falls back to plain splits past the rich limit", async () => {
    fetchMock.mockResolvedValue(okResult({ message_id: 5 }));
    const reply = vi.fn().mockResolvedValue(undefined);
    await runTelegramRichDraftReply({
      ...baseArgs,
      draftId: 99,
      stream: contentStream(["x".repeat(33000)]),
      reply,
    });
    expect(reply).toHaveBeenCalledTimes(9);
    expect(calls().some((call) => call.method === "sendRichMessage")).toBe(false);
  });
  it("reports a draft preview failure once but still persists the final message", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("sendRichMessageDraft")) {
        return { json: async () => ({ ok: false, description: "Bad Request: draft rejected" }) };
      }
      return okResult({ message_id: 5 });
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const onPreviewError = vi.fn();
    await runTelegramRichDraftReply({
      ...baseArgs,
      draftId: 99,
      stream: contentStream(["a".repeat(60), "b".repeat(60)]),
      reply,
      onPreviewError,
    });
    expect(onPreviewError).toHaveBeenCalledTimes(1);
    expect(onPreviewError).toHaveBeenCalledWith("Bad Request: draft rejected");
    expect(calls().at(-1)?.method).toBe("sendRichMessage");
    expect(reply).not.toHaveBeenCalled();
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

  it("falls back to a plain visible reply when ephemeral delivery fails entirely", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("sendRichMessage")) {
        return { json: async () => ({ ok: false, description: "Bad Request: ephemeral unavailable" }) };
      }
      return okResult(true);
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const onPreviewError = vi.fn();
    await runTelegramEphemeralReply({
      ...baseArgs,
      receiverUserId: 77,
      stream: contentStream(["hello"]),
      reply,
      onPreviewError,
    });
    expect(reply).toHaveBeenCalledWith("hello");
    expect(onPreviewError).toHaveBeenCalledTimes(1);
    expect(onPreviewError).toHaveBeenCalledWith("Bad Request: ephemeral unavailable");
  });
});

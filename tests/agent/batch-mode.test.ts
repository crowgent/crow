import { afterEach, describe, expect, it, vi } from "vitest";

async function importBatchModuleWithMocks() {
  vi.resetModules();

  const createBatch = vi.fn(async () => ({
    batch_id: "batch-1",
    state: {
      num_requests: 0,
      num_pending: 0,
      num_success: 0,
      num_error: 0,
      num_cancelled: 0,
    },
  }));
  const addBatchRequests = vi.fn(async () => {});
  const pollBatchRequestResult = vi.fn(async () => ({ batch_request_id: "req-1" }));
  const getBatchChatCompletion = vi.fn(() => ({
    choices: [],
    usage: {},
  }));

  vi.doMock("../../src/crow/batch", async () => {
    const actual = await vi.importActual<typeof import("../../src/crow/batch")>("../../src/crow/batch");
    return {
      ...actual,
      createBatch,
      addBatchRequests,
      pollBatchRequestResult,
      getBatchChatCompletion,
    };
  });

  const mod = await import("../../src/agent/batch");
  return {
    ...mod,
    mocks: {
      createBatch,
      addBatchRequests,
      pollBatchRequestResult,
      getBatchChatCompletion,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/crow/batch");
});

describe("Agent batch mode", () => {
  it("throws when a child batch response has no choices", async () => {
    const { runTaskRequestBatch, mocks } = await importBatchModuleWithMocks();

    await expect(
      runTaskRequestBatch(
        {
          apiKey: "test-key",
          baseURL: "https://api.x.ai/v1",
          maxTokens: 16384,
          recordUsage: () => {},
          formatActivity: () => "",
        },
        {
          request: {
            agent: "general",
            description: "Child task",
            prompt: "Do the thing",
          },
          childMessages: [{ role: "user", content: "Do the thing" }],
          childSystem: "system",
          childRuntime: {
            modelId: "grok-4.3",
            modelInfo: {
              supportsClientTools: false,
              supportsMaxOutputTokens: true,
            },
            providerOptions: undefined,
          } as never,
          childTools: {},
          maxSteps: 1,
          initialDetail: "Starting child task",
        },
      ),
    ).rejects.toThrow("Batch response did not contain any choices.");

    expect(mocks.createBatch).toHaveBeenCalled();
    expect(mocks.addBatchRequests).toHaveBeenCalled();
    expect(mocks.pollBatchRequestResult).toHaveBeenCalled();
    expect(mocks.getBatchChatCompletion).toHaveBeenCalled();
  });
});

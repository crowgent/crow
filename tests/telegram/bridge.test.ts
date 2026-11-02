import { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBridge } from "../../src/telegram/bridge";
import type { TurnCoordinator } from "../../src/telegram/turn-coordinator";

let mockSendMessage: ReturnType<typeof vi.fn>;

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    return {
      api: { sendMessage: mockSendMessage },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

const MockedBot = vi.mocked(Bot);

function mockCoordinator(): TurnCoordinator {
  return { run: vi.fn((fn) => fn()) } as unknown as TurnCoordinator;
}

describe("createTelegramBridge", () => {
  describe("sendDm", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: vi.fn(),
        } as never;
      } as never);
    });

    it("sends short messages without splitting", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "Hello, world!");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "Hello, world!");
    });

    it("splits long messages and sends each part", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const longMessage = "a".repeat(5000);
      await bridge.sendDm(123, longMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 123, "a".repeat(4096));
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(904));
    });

    it("handles empty messages", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "");

      expect(mockSendMessage).toHaveBeenCalledTimes(0);
    });

    it("sends multiple parts for message exactly at limit", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const exactLimitMessage = "a".repeat(4096);
      await bridge.sendDm(123, exactLimitMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "a".repeat(4096));
    });
  });

  describe("disconnect command", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: vi.fn(),
        } as never;
      } as never);
    });

    function getDisconnectHandler() {
      const results = MockedBot.mock.results;
      const botInstance = results[results.length - 1].value as unknown as {
        command: ReturnType<typeof vi.fn>;
      };
      const call = botInstance.command.mock.calls.find(([name]) => name === "disconnect");
      expect(call).toBeDefined();
      return call?.[1] as (ctx: { from?: { id?: number }; reply: (text: string) => Promise<unknown> }) => Promise<void>;
    }

    it("replies and calls onDisconnect for an approved user", async () => {
      const onDisconnect = vi.fn();
      createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [123],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
        onDisconnect,
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      await getDisconnectHandler()({ from: { id: 123 }, reply });

      expect(reply).toHaveBeenCalledWith("Telegram bridge disconnected.");
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it("does not call onDisconnect for an unapproved user", async () => {
      const onDisconnect = vi.fn();
      createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [123],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
        onDisconnect,
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      await getDisconnectHandler()({ from: { id: 999 }, reply });

      expect(reply).toHaveBeenCalledWith("Not paired yet. Send /pair to get a code, then approve in Crow.");
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });
});

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { experimental_generateImage, generateText, type ToolSet, tool } from "ai";
import { z } from "zod";
import { executePostToolFailureHooks, executePostToolHooks, executePreToolHooks } from "../hooks/index";
import { isLspToolEnabled, queryLsp } from "../lsp/runtime";
import { LSP_TOOL_OPERATIONS } from "../lsp/types";
import type { BashTool } from "../tools/bash";
import {
  computerClick,
  computerFocusWindow,
  computerGet,
  computerLaunch,
  computerListWindows,
  computerMouseMove,
  computerPress,
  computerScreenshot,
  computerScroll,
  computerSnapshot,
  computerType,
  computerWait,
} from "../tools/computer";
import { editFile, readFile, writeFile } from "../tools/file";
import { executeGrep } from "../tools/grep";
import type { ScheduleDaemonStatus, ScheduleManager, StoredSchedule } from "../tools/schedule";
import { createSnapshot, listSnapshots, revertSnapshot } from "../tools/snapshot";
import { createWorktree, listWorktrees, removeWorktree } from "../tools/worktree";
import type { AgentMode, SubagentRequest, ToolResult } from "../types/index";
import { type AgentDefinition, isDelegatable } from "../utils/agent-files";
import { type CustomSubagentConfig, loadValidSubAgents } from "../utils/settings";
import type { CrowProvider } from "./client";

export interface QuestionItem {
  question: string;
  options: string[];
}

export type QuestionResolver = (questions: QuestionItem[], abortSignal?: AbortSignal) => Promise<string[]>;

export interface TodoStoreItem {
  id: number;
  text: string;
  status: "open" | "done";
  createdAt: string;
}

export interface TodoStore {
  list(sessionId: string): TodoStoreItem[];
  add(sessionId: string, text: string): TodoStoreItem;
  setStatus(sessionId: string, id: number, status: "open" | "done"): boolean;
  remove(sessionId: string, id: number): boolean;
}

interface CreateToolsOptions {
  modelId?: string;
  providerId?: string;
  runSubagent?: (request: SubagentRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (id: string) => Promise<ToolResult>;
  listDelegations?: () => Promise<ToolResult>;
  scheduleManager?: ScheduleManager;
  subagents?: CustomSubagentConfig[];
  agentDefinitions?: AgentDefinition[];
  sendTelegramFile?: (filePath: string) => Promise<ToolResult>;
  sessionId?: string;
  askQuestion?: QuestionResolver;
  todos?: TodoStore;
}

export function createTools(
  bash: BashTool,
  provider: CrowProvider,
  mode: AgentMode = "agent",
  options: CreateToolsOptions = {},
) {
  const cwd = () => bash.getCwd();

  const runResponsesSearch = async (
    query: string,
    abortSignal?: AbortSignal,
  ): Promise<{ success: boolean; output: string }> => {
    try {
      const { text } = await generateText({
        model: provider.responses(options.modelId || "gpt-5"),
        maxOutputTokens: 4096,
        prompt: query,
        abortSignal,
        tools: {
          web_search: provider.tools.webSearch(),
        } as ToolSet,
      });

      return {
        success: true,
        output: text || "No search results found.",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Web search failed: ${msg}` };
    }
  };

  const base = {
    bash: tool({
      description: bash.getToolDescription(),
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe(
            "Timeout in milliseconds (default: 30000). Use higher values for long-running commands. Ignored when background=true.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run the command as a background process. Returns immediately with a process ID. Use process_logs/process_stop/process_list to manage it.",
          ),
      }),
      execute: async ({ command, timeout, background }, { abortSignal }) => {
        const toolInput = { command, timeout, background };
        const preResult = await executePreToolHooks("bash", toolInput, cwd(), options.sessionId, abortSignal);
        if (preResult.blocked) {
          const reason = preResult.blockingErrors.map((e) => e.stderr).join("; ") || "Blocked by hook";
          return { success: false, output: `[Hook blocked] ${reason}` };
        }

        if (background) {
          return bash.startBackground(command);
        }

        const result = await bash.execute(command, timeout, abortSignal);
        const output = {
          success: result.success,
          output: result.success
            ? result.output || "Command executed successfully (no output)"
            : result.error || "Command failed",
        };

        if (result.success) {
          executePostToolHooks("bash", toolInput, output, cwd(), options.sessionId, abortSignal).catch(() => {});
        } else {
          executePostToolFailureHooks(
            "bash",
            toolInput,
            result.error || "Command failed",
            cwd(),
            options.sessionId,
            abortSignal,
          ).catch(() => {});
        }

        return output;
      },
    }),

    process_logs: tool({
      description:
        "View recent output (stdout + stderr) from a background process by its ID. Returns the last N lines of the log.",
      inputSchema: z.object({
        id: z.number().describe("The background process ID"),
        tail: z.number().optional().describe("Number of lines to return from the end (default: 50)"),
      }),
      execute: async ({ id, tail }) => {
        return bash.getProcessLogs(id, tail);
      },
    }),

    process_stop: tool({
      description:
        "Stop a running background process by its ID. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
      inputSchema: z.object({
        id: z.number().describe("The background process ID to stop"),
      }),
      execute: async ({ id }) => {
        return bash.stopProcess(id);
      },
    }),

    process_list: tool({
      description: "List all background processes with their ID, status, PID, age, and command.",
      inputSchema: z.object({}),
      execute: async () => {
        return bash.listProcesses();
      },
    }),

    read_file: tool({
      description:
        "Read the contents of a file. Returns numbered lines with a header showing the range and total line count. Use start_line/end_line to read specific sections of large files iteratively.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        start_line: z.number().optional().describe("First line to read (1-indexed, default: 1)"),
        end_line: z.number().optional().describe("Last line to read (inclusive, default: end of file)"),
      }),
      execute: async ({ path, start_line, end_line }) => {
        return readFile(path, cwd(), start_line, end_line);
      },
    }),

    grep: tool({
      description:
        'Fast content search tool that works with any codebase size. Searches file contents using regular expressions. Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Filter files by pattern with the include parameter (e.g. "*.js", "*.{ts,tsx}"). Returns matching file paths and line numbers sorted by modification time. Use this tool when you need to find files containing specific patterns. If you need to count matches within files, use bash with `rg` directly.',
      inputSchema: z.object({
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z
          .string()
          .optional()
          .describe("The directory or file to search in. Defaults to the current working directory."),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      }),
      execute: async ({ pattern, path, include }) => {
        return executeGrep({ pattern, path, include }, cwd());
      },
    }),

    search_web: tool({
      description:
        "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
      }),
      execute: async ({ query }, { abortSignal }) => {
        return runResponsesSearch(query, abortSignal);
      },
    }),

    todo: tool({
      description:
        "Manage the session todo list. Use for tracking multi-step work: add items, list them, mark done, remove them.",
      inputSchema: z.object({
        operation: z.enum(["add", "list", "done", "remove"]),
        text: z.string().optional().describe("Todo text, required for add"),
        id: z.number().optional().describe("Todo id, required for done and remove"),
      }),
      execute: async ({ operation, text, id }) => {
        if (!options.sessionId || !options.todos) return { success: false, output: "Todos need a persisted session." };
        if (operation === "add") {
          if (!text?.trim()) return { success: false, output: "Todo text is required." };
          const item = options.todos.add(options.sessionId, text.trim());
          return { success: true, output: `Added todo ${item.id}: ${item.text}` };
        }
        if (operation === "list") {
          const items = options.todos.list(options.sessionId);
          if (items.length === 0) return { success: true, output: "Todo list is empty." };
          return {
            success: true,
            output: items.map((item) => `${item.id}. [${item.status === "done" ? "x" : " "}] ${item.text}`).join("\n"),
          };
        }
        if (id == null) return { success: false, output: "Todo id is required." };
        if (operation === "done") {
          return options.todos.setStatus(options.sessionId, id, "done")
            ? { success: true, output: `Todo ${id} marked done.` }
            : { success: false, output: `Todo ${id} was not found.` };
        }
        return options.todos.remove(options.sessionId, id)
          ? { success: true, output: `Todo ${id} removed.` }
          : { success: false, output: `Todo ${id} was not found.` };
      },
    }),

    fetch_url: tool({
      description:
        "Fetch a URL and return its readable text. HTML tags are stripped. Use for reading docs, articles, and pages the model needs.",
      inputSchema: z.object({
        url: z.string().describe("The URL to fetch"),
      }),
      execute: async ({ url }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
            if (!response.ok) return { success: false, output: `Fetch failed: HTTP ${response.status}.` };
            const html = await response.text();
            const text = html
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/gi, " ")
              .replace(/&amp;/gi, "&")
              .replace(/&lt;/gi, "<")
              .replace(/&gt;/gi, ">")
              .replace(/&quot;/gi, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, " ")
              .trim();
            return { success: true, output: text || "(page had no readable text)" };
          } finally {
            clearTimeout(timeout);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `Fetch failed: ${msg}` };
        }
      },
    }),

    question: tool({
      description:
        "Ask the user one or more multiple-choice questions and wait for their answers. Each question must include 2 or more options for the user to pick from. Use when a choice blocks progress. In unattended sessions this tool is unavailable.",
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string(),
              options: z.array(z.string()).min(2),
            }),
          )
          .min(1),
      }),
      execute: async ({ questions }) => {
        if (!options.askQuestion) {
          return {
            success: false,
            output: "Questions cannot be asked in this session (unattended). Proceed with your best judgment.",
          };
        }
        try {
          const answers = await options.askQuestion(questions);
          if (answers.length === 0) return { success: false, output: "The user declined to answer." };
          return {
            success: true,
            output: questions.map((item, i) => `Q: ${item.question}\nA: ${answers[i] ?? "(no answer)"}`).join("\n"),
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `Question failed: ${msg}` };
        }
      },
    }),

    worktree_create: tool({
      description:
        "Create a git worktree at a path, optionally on a new branch. The current directory must be a git repository.",
      inputSchema: z.object({
        path: z.string().describe("The worktree path to create"),
        branch: z.string().optional().describe("A new branch name to create and check out in the worktree"),
      }),
      execute: async ({ path, branch }) => {
        return createWorktree(cwd(), path, branch);
      },
    }),

    worktree_list: tool({
      description: "List git worktrees for the current repository.",
      inputSchema: z.object({}),
      execute: async () => {
        return listWorktrees(cwd());
      },
    }),

    worktree_remove: tool({
      description: "Remove a git worktree by path. This deletes the worktree directory.",
      inputSchema: z.object({
        path: z.string().describe("The worktree path to remove"),
      }),
      execute: async ({ path }) => {
        return removeWorktree(cwd(), path);
      },
    }),

    snapshot_create: tool({
      description:
        "Snapshot the current working directory (excluding .git, node_modules, and snapshots themselves) so it can be restored later.",
      inputSchema: z.object({
        name: z.string().optional().describe("A name for the snapshot"),
      }),
      execute: async ({ name }) => {
        try {
          const meta = await createSnapshot(cwd(), name);
          return { success: true, output: `Snapshot created: ${meta.id} (${meta.name}).` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `Snapshot failed: ${msg}` };
        }
      },
    }),

    snapshot_list: tool({
      description: "List saved workspace snapshots.",
      inputSchema: z.object({}),
      execute: async () => {
        const snapshots = await listSnapshots();
        if (snapshots.length === 0) return { success: true, output: "No snapshots." };
        return {
          success: true,
          output: snapshots
            .map((snapshot) => `${snapshot.id} (${snapshot.name}) from ${snapshot.sourceCwd} at ${snapshot.createdAt}`)
            .join("\n"),
        };
      },
    }),

    snapshot_revert: tool({
      description:
        "Restore a snapshot over its original directory. Files created after the snapshot are left untouched.",
      inputSchema: z.object({
        id: z.string().describe("The snapshot id"),
      }),
      execute: async ({ id }) => {
        return revertSnapshot(id);
      },
    }),

    generate_image: tool({
      description:
        "Generate an image from a text prompt using an image-capable model from the configured provider. The model id must be an image model (for example gpt-image-1 on OpenAI). The image is saved as a PNG file and its path is returned.",
      inputSchema: z.object({
        prompt: z.string().describe("The image prompt"),
        model: z.string().describe("The image model id"),
      }),
      execute: async ({ prompt, model }) => {
        try {
          const { image } = await experimental_generateImage({
            model: provider.image(model),
            prompt,
          });
          const dir = path.join(os.homedir(), ".crow", "images");
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${randomUUID().replace(/-/g, "").slice(0, 12)}.png`);
          await fs.writeFile(file, Buffer.from(image.base64, "base64"));
          return { success: true, output: `Image saved to ${file}` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `Image generation failed: ${msg}` };
        }
      },
    }),
  };

  const tools: ToolSet = { ...base };
  if (options.providerId !== "openai") {
    delete tools.search_web;
  }

  if (isLspToolEnabled(cwd())) {
    tools.lsp = tool({
      description:
        "Experimental Language Server Protocol access for semantic code intelligence. Use for go-to-definition, references, hover, symbols, implementations, and call hierarchy when a matching LSP server is available.",
      inputSchema: z.object({
        operation: z.enum(LSP_TOOL_OPERATIONS).describe("The LSP operation to perform"),
        filePath: z.string().describe("The absolute or cwd-relative path to the target file"),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The 1-based line number. Required for position-based operations (definition, references, hover, implementation, callHierarchy). Not needed for documentSymbol or workspaceSymbol.",
          ),
        character: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The 1-based character offset. Required for position-based operations. Not needed for documentSymbol or workspaceSymbol.",
          ),
        query: z.string().optional().describe("Optional symbol query. Used primarily with workspaceSymbol."),
      }),
      execute: async ({ operation, filePath, line, character, query }) => {
        try {
          return await queryLsp(cwd(), {
            operation,
            filePath,
            line: line ?? 1,
            character: character ?? 1,
            query,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: `LSP query failed: ${msg}`,
          };
        }
      },
    });
  }

  if (options.sendTelegramFile) {
    const sendFile = options.sendTelegramFile;
    tools.telegram_send_file = tool({
      description:
        "Send a local file to the current Telegram chat as an attachment. Use this to deliver generated images, videos, documents, or any other file to the user in Telegram. The file is uploaded directly — the user receives it as a Telegram media message or document.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or cwd-relative path to the local file to send"),
      }),
      execute: async ({ path: filePath }) => {
        const resolved = filePath.startsWith("/") ? filePath : `${cwd()}/${filePath}`;
        return sendFile(resolved);
      },
    });
  }

  if (options.runSubagent) {
    const registryDefinitions = (options.agentDefinitions ?? []).filter(isDelegatable);
    const customNames = (options.subagents ?? loadValidSubAgents()).map((agent) => agent.name);
    const customHint =
      customNames.length > 0
        ? ` You may also use these user-defined sub-agents by exact name: ${customNames.join(", ")}.`
        : "";
    const routingLines = registryDefinitions
      .filter((definition) => definition.description)
      .map((definition) => `- ${definition.name}: ${definition.description}`);
    const routingHint =
      routingLines.length > 0 ? ` Available sub-agents and when to use them:\n${routingLines.join("\n")}` : "";

    tools.subagent = tool({
      description: `Spawns an agent in a child session to work on the specified task. New child sessions start with fresh context, so include all relevant context and instructions in the prompt. Foreground (default) runs the subagent to completion and returns its final response. Background mode (background=true) launches it asynchronously and returns immediately with a sessionID; you will be notified when it completes, do not poll for progress or duplicate its work. To send follow-ups to a running or finished subagent, call subagent again with its sessionID. Prefer this proactively for review, research, investigation, code quality work, verification, and computer-use flows instead of waiting for the user to request a sub-agent. Use \`general\` for multi-step execution, \`explore\` for fast read-only investigation, \`vision\` for image validation, \`verify\` for sandbox-aware build, test, and smoke validation, \`verify-detect\` for read-only verification recipe detection, \`verify-manifest\` to create or update a verification manifest, and \`computer\` for host desktop screenshot/input workflows.${customHint}${routingHint}`,
      inputSchema: z.object({
        agent: z
          .string()
          .describe(
            "The type of specialized agent to use, such as general, explore, vision, verify, verify-detect, verify-manifest, computer, or a Markdown-defined or configured custom sub-agent name",
          ),
        description: z.string().describe("A short 3-5 word label for the task, displayed to the user"),
        prompt: z.string().describe("Detailed instructions for the sub-agent to complete"),
        model: z
          .string()
          .optional()
          .describe(
            'Optional model override as "providerID/modelID" (for example "xai/grok-4.7") or a model id within the current provider. Never set this unless the user explicitly asks for a particular model.',
          ),
        sessionID: z
          .string()
          .optional()
          .describe("Send a follow-up to an existing subagent, running or finished. Omit to start a new one."),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run the subagent in the background and return immediately. You will be notified when it completes. Do not sleep, poll, or proactively check on its progress.",
          ),
      }),
      execute: async ({ agent, description, prompt, model, sessionID, background }, { abortSignal }) => {
        return options.runSubagent!({ agent, description, prompt, model, sessionID, background }, abortSignal);
      },
    });
  }

  if (mode === "agent") {
    tools.computer_snapshot = tool({
      description:
        "Capture a semantic accessibility snapshot of a desktop app using agent-desktop. Prefer this before desktop interaction. It returns stable refs like @e1 that remain valid until the next snapshot.",
      inputSchema: z.object({
        app: z.string().optional().describe("Optional application name to scope the snapshot"),
        window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
        interactive_only: z
          .boolean()
          .optional()
          .describe("If true or omitted, include only interactive elements with refs"),
        include_bounds: z.boolean().optional().describe("Include element bounds in the snapshot"),
        compact: z.boolean().optional().describe("Collapse single-child unnamed nodes to reduce tree depth"),
        max_depth: z.number().int().min(1).max(30).optional().describe("Maximum tree depth"),
        surface: z
          .enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"])
          .optional()
          .describe("Optional UI surface to snapshot"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerSnapshot(input, cwd(), abortSignal);
      },
    });

    tools.computer_screenshot = tool({
      description:
        "Capture a PNG screenshot of a desktop app window using agent-desktop. Use for visual confirmation or when the accessibility snapshot is insufficient.",
      inputSchema: z.object({
        output_path: z
          .string()
          .optional()
          .describe("Optional output path for the screenshot. Defaults to .crow/computer/*.png"),
        app: z.string().optional().describe("Optional application name to capture"),
        window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerScreenshot(input, cwd(), abortSignal);
      },
    });

    tools.computer_click = tool({
      description:
        "Click a desktop element via agent-desktop. Prefer `ref` values from computer_snapshot. Coordinates are a fallback only when accessibility refs are unavailable.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
        x: z.number().optional().describe("Fallback absolute screen X coordinate"),
        y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to click"),
        count: z.number().int().min(1).max(3).optional().describe("Number of clicks"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerClick(input, cwd(), abortSignal);
      },
    });

    tools.computer_mouse_move = tool({
      description: "Hover over a desktop element or coordinates via agent-desktop. Prefer refs from computer_snapshot.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
        x: z.number().optional().describe("Fallback absolute screen X coordinate"),
        y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
        duration_ms: z.number().int().min(0).optional().describe("Optional hover duration in milliseconds"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerMouseMove(input, cwd(), abortSignal);
      },
    });

    tools.computer_type = tool({
      description:
        "Type text into a specific desktop element via agent-desktop. Pass a ref from computer_snapshot. For shortcuts like cmd+k or enter, prefer computer_press.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e5"),
        text: z.string().describe("Text to type"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerType(input, cwd(), abortSignal);
      },
    });

    tools.computer_press = tool({
      description: "Press a key or key chord via agent-desktop, optionally targeting a specific app first.",
      inputSchema: z.object({
        key: z.string().describe("Key or key chord such as enter or cmd+s"),
        app: z.string().optional().describe("Optional application name to focus before pressing"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerPress(input, cwd(), abortSignal);
      },
    });

    tools.computer_scroll = tool({
      description: "Scroll a desktop element via agent-desktop. Pass the element ref from computer_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e8"),
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
        amount: z.number().int().min(1).max(100).optional().describe("Optional scroll amount"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerScroll(input, cwd(), abortSignal);
      },
    });

    tools.computer_launch = tool({
      description: "Launch an application by name or bundle id using agent-desktop and wait for its window to appear.",
      inputSchema: z.object({
        app: z.string().describe("Application name or bundle id"),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(120000)
          .optional()
          .describe("Optional launch timeout in milliseconds"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerLaunch(input, cwd(), abortSignal);
      },
    });

    tools.computer_list_windows = tool({
      description:
        "List visible desktop windows using agent-desktop. Use this to discover window ids before focusing or scoping snapshots.",
      inputSchema: z.object({
        app: z.string().optional().describe("Optional application name to filter windows"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerListWindows(input, cwd(), abortSignal);
      },
    });

    tools.computer_focus_window = tool({
      description: "Bring a desktop window to the front using a window id, app name, or title.",
      inputSchema: z.object({
        window_id: z.string().optional().describe("Window id from computer_list_windows"),
        app: z.string().optional().describe("Application name"),
        title: z.string().optional().describe("Partial window title match"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerFocusWindow(input, cwd(), abortSignal);
      },
    });

    tools.computer_wait = tool({
      description:
        "Wait for time, an element ref, a window title, or text to appear using agent-desktop. Use after launches, dialogs, or UI transitions.",
      inputSchema: z.object({
        milliseconds: z
          .number()
          .int()
          .min(0)
          .max(120000)
          .optional()
          .describe("Optional pause duration in milliseconds"),
        element: z.string().optional().describe("Wait until this element ref appears"),
        window: z.string().optional().describe("Wait until a window title appears"),
        text: z.string().optional().describe("Wait until text appears in the accessibility tree"),
        timeout_ms: z.number().int().min(100).max(120000).optional().describe("Timeout for element/window/text waits"),
        app: z.string().optional().describe("Optional app scope for the wait"),
        menu: z.boolean().optional().describe("Wait until a menu is open"),
        menu_closed: z.boolean().optional().describe("Wait until a menu is dismissed"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerWait(input, cwd(), abortSignal);
      },
    });

    tools.computer_get = tool({
      description: "Read a property like text, value, title, bounds, role, or states from a desktop element ref.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e4"),
        property: z
          .enum(["text", "value", "title", "bounds", "role", "states"])
          .optional()
          .describe("Property to read"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerGet(input, cwd(), abortSignal);
      },
    });

    tools.write_file = tool({
      description:
        "Create or overwrite a file with the given content. Use for creating new files or completely rewriting existing ones. Returns a diff of the changes.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        content: z.string().describe("The full file content to write"),
      }),
      execute: async ({ path, content }) => {
        return writeFile(path, content, cwd());
      },
    });

    tools.edit_file = tool({
      description:
        "Edit a file by replacing a unique string with new content. The old_string must appear exactly once in the file. Include enough surrounding context lines in old_string to make it unique. Returns a diff of the changes.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        old_string: z.string().describe("The exact text to find (must be unique in the file)"),
        new_string: z.string().describe("The replacement text"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        return editFile(path, old_string, new_string, cwd());
      },
    });

    if (options.readDelegation) {
      tools.delegation_read = tool({
        description:
          "Read the saved output of a background delegation by ID. Use this after a completion notice or when revisiting prior research.",
        inputSchema: z.object({
          id: z.string().describe("The delegation ID, such as 'calm-blue-fox'"),
        }),
        execute: async ({ id }) => {
          return options.readDelegation!(id);
        },
      });
    }

    if (options.listDelegations) {
      tools.delegation_list = tool({
        description:
          "List recent background delegations for the current project. Use sparingly to discover IDs or review prior results, not for repeated polling.",
        inputSchema: z.object({}),
        execute: async () => {
          return options.listDelegations!();
        },
      });
    }

    if (options.scheduleManager) {
      const schedules = options.scheduleManager;

      tools.schedule_create = tool({
        description:
          "Create a recurring or one-time scheduled headless Crow run. Provide a name, the instruction to run, and a cron expression for recurring schedules. Omit cron for an immediate one-time run.",
        inputSchema: z.object({
          name: z.string().describe("Human-readable schedule name"),
          instruction: z.string().describe("The prompt/instruction Crow should run headlessly"),
          cron: z.string().optional().describe("Cron expression for recurring schedules, such as '0 9 * * 1-5'"),
          model: z.string().optional().describe("Optional model override; defaults to the current selected model"),
          directory: z.string().optional().describe("Optional working directory; defaults to the current directory"),
          max_tool_rounds: z.number().int().positive().optional().describe("Optional max tool rounds override"),
        }),
        execute: async ({ name, instruction, cron, model, directory, max_tool_rounds }) => {
          try {
            const result = await schedules.create({
              name,
              instruction,
              cron,
              model,
              directory,
              maxToolRounds: max_tool_rounds,
            });

            const lines = [
              `Schedule created: ${result.schedule.name}`,
              `ID: ${result.schedule.id}`,
              `Type: ${result.schedule.cron ? "recurring" : "one-time"}`,
              `Model: ${result.schedule.model}`,
              `Directory: ${result.schedule.directory}`,
            ];
            if (result.schedule.cron) {
              lines.push(`Cron: ${result.schedule.cron}`);
              lines.push(formatDaemonReminder(result.daemonStatus));
            } else {
              lines.push(`Run started in background${result.startedPid ? ` (pid ${result.startedPid})` : ""}.`);
            }

            return { success: true, output: lines.join("\n") };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to create schedule: ${msg}` };
          }
        },
      });

      tools.schedule_list = tool({
        description:
          "List all saved schedules, including one-time and recurring runs, along with daemon status and last run time.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const [items, daemonStatus] = await Promise.all([schedules.list(), schedules.getDaemonStatus()]);
            if (items.length === 0) {
              return {
                success: true,
                output: `No schedules found.\n${formatDaemonReminder(daemonStatus)}`,
              };
            }

            return {
              success: true,
              output: formatScheduleList(items, daemonStatus),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to list schedules: ${msg}` };
          }
        },
      });

      tools.schedule_remove = tool({
        description: "Remove a saved schedule and its run logs by schedule id.",
        inputSchema: z.object({
          id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
        }),
        execute: async ({ id }) => {
          try {
            const removed = await schedules.remove(id);
            if (!removed) {
              return { success: false, output: `Schedule "${id}" not found.` };
            }
            return {
              success: true,
              output: `Removed schedule "${removed.name}" (${removed.id}).`,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to remove schedule: ${msg}` };
          }
        },
      });

      tools.schedule_read_log = tool({
        description: "Read recent log output from a saved schedule.",
        inputSchema: z.object({
          id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
          tail: z.number().int().positive().optional().describe("Number of log lines to return from the end"),
        }),
        execute: async ({ id, tail }) => {
          try {
            return {
              success: true,
              output: await schedules.readLog(id, tail ?? 50),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to read schedule log: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_status = tool({
        description: "Check whether the schedule daemon is currently running.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const status = await schedules.getDaemonStatus();
            return {
              success: true,
              output: formatDaemonReminder(status),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to get schedule daemon status: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_start = tool({
        description:
          "Start the schedule daemon in the background so recurring schedules can run even after the TUI closes.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const result = await schedules.startDaemon();
            return {
              success: true,
              output: result.alreadyRunning
                ? `Schedule daemon already running${result.status.pid ? ` (pid ${result.status.pid})` : ""}.`
                : `Schedule daemon started${result.pid ? ` (pid ${result.pid})` : ""}.`,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to start schedule daemon: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_stop = tool({
        description: "Stop the background schedule daemon.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const result = await schedules.stopDaemon();
            return {
              success: true,
              output: result.wasRunning
                ? `Schedule daemon stopped${result.pid ? ` (pid ${result.pid})` : ""}.`
                : "Schedule daemon is not running.",
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to stop schedule daemon: ${msg}` };
          }
        },
      });
    }
  }

  if (mode !== "plan") return tools;

  tools.generate_plan = tool({
    description:
      "Generate an interactive implementation plan with steps and optional questions for the user. The plan is displayed in a structured UI where the user can review steps and answer questions. Always use this tool when creating plans.",
    inputSchema: z.object({
      title: z.string().describe("Plan title"),
      summary: z.string().describe("Brief summary of what the plan accomplishes"),
      steps: z
        .array(
          z.object({
            title: z.string().describe("Step title"),
            description: z.string().describe("Detailed description of what this step involves"),
            filePaths: z.array(z.string()).optional().describe("Files affected by this step"),
          }),
        )
        .describe("Ordered list of implementation steps"),
      questions: z
        .array(
          z.object({
            id: z.string().describe("Unique question identifier"),
            question: z.string().describe("The question to ask the user"),
            header: z.string().optional().describe("Single-word tab label (e.g. 'Format', 'Storage', 'Testing')"),
            type: z
              .enum(["select", "multiselect", "text"])
              .describe("Question type: select (pick one), multiselect (pick many), or text (free-form)"),
            options: z
              .array(
                z.object({
                  id: z.string().describe("Option identifier"),
                  label: z.string().describe("Option display text"),
                }),
              )
              .optional()
              .describe("Options for select/multiselect questions"),
          }),
        )
        .optional()
        .describe("Questions for the user to answer before proceeding"),
    }),
    execute: async ({ title, summary, steps, questions }) => {
      return {
        success: true,
        output: `Plan "${title}" generated with ${steps.length} steps`,
        plan: { title, summary, steps, questions },
      };
    },
  });

  return tools;
}

function formatScheduleList(schedules: StoredSchedule[], daemonStatus: ScheduleDaemonStatus): string {
  const lines = [
    `Daemon: ${daemonStatus.running ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}` : "not running"}`,
  ];

  for (const schedule of schedules) {
    const scheduleType = schedule.cron ? "recurring" : "one-time";
    lines.push("");
    lines.push(`- ${schedule.name} (\`${schedule.id}\`)`);
    lines.push(`  type: ${scheduleType}`);
    if (schedule.cron) {
      lines.push(`  cron: ${schedule.cron}`);
      lines.push(`  enabled: ${schedule.enabled ? "yes" : "no"}`);
    }
    lines.push(`  model: ${schedule.model}`);
    lines.push(`  directory: ${schedule.directory}`);
    lines.push(`  last run: ${schedule.lastRunAt ?? "never"}`);
  }

  if (!daemonStatus.running) {
    lines.push("");
    lines.push("Start `crow daemon` to run recurring schedules.");
  }

  return lines.join("\n");
}

function formatDaemonReminder(status: ScheduleDaemonStatus): string {
  if (status.running) {
    return `Daemon status: running${status.pid ? ` (pid ${status.pid})` : ""}.`;
  }
  return "Daemon status: not running. Use `schedule_daemon_start` (or `crow daemon`) to run recurring schedules.";
}

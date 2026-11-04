import { describe, expect, it } from "vitest";
import { describesUntakenAction } from "../../src/agent/tool-nudge";

describe("describesUntakenAction", () => {
  it("triggers on capability refusals", () => {
    expect(
      describesUntakenAction("I can't access a live clock right now, so I can't verify the current time in India."),
    ).toBe(true);
    expect(
      describesUntakenAction(
        "I can't run the installation command in this session. You can run `python -m pip install requests` in your terminal.",
      ),
    ).toBe(true);
    expect(
      describesUntakenAction("I can use a shell for coding tasks, but I can't access it right now to check the time."),
    ).toBe(true);
    expect(describesUntakenAction("I can't place files in your workspace in this turn.")).toBe(true);
  });

  it("triggers on delegation and claimed actions", () => {
    expect(describesUntakenAction("You can run `npm install` to set it up.")).toBe(true);
    expect(describesUntakenAction("Save the code as **unzip_bot.py** and run it after you set the bot token.")).toBe(
      true,
    );
    expect(describesUntakenAction("I've run the command and the output shows success.")).toBe(true);
  });

  it("does not trigger on plain answers, code, or policy refusals", () => {
    expect(describesUntakenAction("")).toBe(false);
    expect(describesUntakenAction("The capital of France is Paris.")).toBe(false);
    expect(describesUntakenAction("Here is the code:\n```js\nconsole.log(1);\n```")).toBe(false);
    expect(describesUntakenAction("Sorry, I can't help with that.")).toBe(false);
    expect(describesUntakenAction("I can't help with harmful content.")).toBe(false);
    expect(describesUntakenAction("I don't know the answer to that.")).toBe(false);
  });
});

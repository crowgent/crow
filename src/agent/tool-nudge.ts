export const TOOL_CALL_NUDGE =
  "You replied with text but called no tool, while this task needs an action. Do not describe the action, and do not ask the user to run it. Call the tool that performs it now, with the exact arguments, instead of writing about it.";

const POLICY_REFUSAL =
  /(sorry, i can't help with that|against (my )?policy|i can't help with (harmful|illegal|dangerous)|harmful or illegal|dangerous content)/i;

const CAPABILITY_REFUSAL =
  /\b(can't|cannot|unable to|not able to)\b[^.]{0,80}\b(access|run|execute|install|use|check|reach|place|create|write|modify|edit|delete)\b/i;

const DELEGATION = /(you can (run|install|execute|use)|run\s+`[^`]+`|save (the |this )?code as)/i;

const CLAIMED_ACTION =
  /\bi(?:'ve| have| just)?\s+(run|executed|installed|created|written|checked|verified|deleted|modified)\b/i;

export function describesUntakenAction(text: string): boolean {
  if (!text.trim()) return false;
  if (POLICY_REFUSAL.test(text)) return false;
  if (CLAIMED_ACTION.test(text)) return true;
  if (DELEGATION.test(text)) return true;
  if (CAPABILITY_REFUSAL.test(text)) return true;
  return false;
}

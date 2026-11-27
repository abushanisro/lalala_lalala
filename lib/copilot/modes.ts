// The Manufacturing Copilot's answer modes: what the chat's mode menu offers and what it sends. The instruction each mode stands for
// is the server's own text (backend copilot.prompt.ts); the chat only names the mode. Pure.

export const COPILOT_MODES = [
  { key: "ask", label: "Ask", hint: "A short answer", placeholder: "Ask anything… (Enter to send, Shift+Enter for new line)" },
  { key: "deep_dive", label: "Deep dive", hint: "The full breakdown, with a source for every figure", placeholder: "What should be broken down in full? (Enter to send)" },
  { key: "plan", label: "Plan", hint: "A step-by-step cost reduction plan", placeholder: "What should the plan achieve? (Enter to send)" },
] as const;

export type CopilotMode = (typeof COPILOT_MODES)[number]["key"];

export const DEFAULT_COPILOT_MODE: CopilotMode = "ask";

/** The mode a saved value names; the default for anything else (nothing saved, or a mode that no longer exists). */
export function copilotModeFrom(saved: string | null | undefined): CopilotMode {
  return COPILOT_MODES.find((m) => m.key === saved)?.key ?? DEFAULT_COPILOT_MODE;
}

export function copilotModeOf(mode: CopilotMode): (typeof COPILOT_MODES)[number] {
  return COPILOT_MODES.find((m) => m.key === mode) ?? COPILOT_MODES[0];
}

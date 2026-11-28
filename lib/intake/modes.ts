// What the New page's prompt does with what it is given: the mode menu's choices. Pure.

export const INTAKE_MODES = [
  { key: "build", label: "Build", hint: "Create the project and cost the parts at once" },
  { key: "plan", label: "Plan", hint: "Show the plan first; nothing is created until you say so" },
  { key: "ask", label: "Ask", hint: "Ask about a drawing or about making a part; nothing is created" },
] as const;

export type IntakeMode = (typeof INTAKE_MODES)[number]["key"];

/** The plan first, as the prompt worked before it had modes: creating without a look is something a person chooses. */
export const DEFAULT_INTAKE_MODE: IntakeMode = "plan";

/** The mode a saved value names; the default for anything else (nothing saved, or a mode that no longer exists). */
export function intakeModeFrom(saved: string | null | undefined): IntakeMode {
  return INTAKE_MODES.find((m) => m.key === saved)?.key ?? DEFAULT_INTAKE_MODE;
}

export function intakeModeOf(mode: IntakeMode): (typeof INTAKE_MODES)[number] {
  return INTAKE_MODES.find((m) => m.key === mode) ?? INTAKE_MODES[1];
}

/** What the send button does in each mode, for its label; and what the box is asking for. */
export const INTAKE_SEND: Record<IntakeMode, string> = { build: "Read the files and create", plan: "Read the files", ask: "Ask" };
export const INTAKE_BOX: Record<IntakeMode, string> = { build: "What the job is", plan: "What the job is", ask: "Your question" };
export const ASK_PLACEHOLDER = "Ask about the drawing, or about making a part";

// The New page's conversation in Build mode: what is said and done, as a list of entries, and the questions the build asks the person
// when a cost needs something only they can say. A question is a small form with one answer (an option, or their own words) that
// the person submits or skips. Everything here is pure: lib/intake/build.ts carries the conversation out.
import type { DrawingReading, DrawingShape, ProcessFamily } from "@/lib/api/drawing-readings";

import { gradeFor, processGroupFor, shapeSummary, type IntakePlan, type PlanPart } from "./plan";

import type { IntakeResult, StepState } from "./run";

export type NeedKind = "process" | "size" | "grade" | "location";
/** Something a cost needs that only the person can say: about one part (its drawing's file name), or about the whole job (null). */
export interface Need { kind: NeedKind; part: string | null }
export const needKey = (need: Need): string => `${need.kind}:${need.part ?? ""}`;

export interface Option { value: string; why?: string }
export interface Question {
  need: Need;
  text: string;
  hint: string;
  /** What is offered at once: a few likely answers. */
  options: Option[];
  /** The offered answer the drawing itself supports, if any. */
  pick: string | null;
  /** Every answer there is, for the person's own words to be matched against; empty when the answer is free (a size). */
  choices: string[];
}
export type Answer = { action: "accept"; value: string } | { action: "skip" };

export type Entry =
  | { kind: "user"; id: number; text: string; files: File[] }
  | { kind: "step"; id: number; key: string; title: string; state: StepState; detail: string }
  | { kind: "say"; id: number; text: string }
  | { kind: "question"; id: number; question: Question; answer: Answer | null }
  | { kind: "result"; id: number; result: IntakeResult };

/**
 * The next thing to ask, in the order a cost needs them: for each part its process, its size when the drawing gives none, and its
 * material grade; then where the parts are made. A part the person skipped a question for is created without a cost, so nothing more
 * is asked about it. Null: nothing left to ask.
 */
export function nextNeed(plan: IntakePlan, skipped: readonly string[]): Need | null {
  for (const part of plan.parts) {
    if (skipped.some(key => key.endsWith(`:${part.file}`))) continue;
    if (!part.processGroup) return { kind: "process", part: part.file };
    if (!part.shape) return { kind: "size", part: part.file };
    if (!part.grade) return { kind: "grade", part: part.file };
  }
  const location: Need = { kind: "location", part: null };
  const anyCostable = plan.parts.some(p => p.shape && p.processGroup && p.grade);
  return anyCostable && !plan.location && !skipped.includes(needKey(location)) ? location : null;
}

const FAMILY_GROUPS: Partial<Record<ProcessFamily, RegExp>> = {
  machining: /machining/i, sheet_metal: /^sheet metal/i, casting: /casting/i, forging: /forging/i, plastic_molding: /mold/i,
};
const COMMON_GROUPS = ["Machining", "Sheet Metal", "Plastic Molding", "Die Casting", "Sand Casting", "Forging"];
const OFFERED = 6;

export interface Lists { groups: readonly string[]; grades: readonly string[]; locations: readonly string[] }

/** The question for a need, with the answers to offer. `family` and `reason` are what the drawing itself indicated for the part. */
export function questionFor(need: Need, plan: IntakePlan, lists: Lists, read?: { family: ProcessFamily; reason: string } | null): Question {
  const part = plan.parts.find(p => p.file === need.part);
  const named = part?.name.trim() ?? "";
  const name = named !== "" ? named : need.part ?? "the part";
  if (need.kind === "process") {
    const pattern = read?.family ? FAMILY_GROUPS[read.family] : undefined;
    const likely = pattern ? lists.groups.filter(g => pattern.test(g)) : [];
    const offered = (likely.length > 0 ? likely : COMMON_GROUPS.filter(g => lists.groups.includes(g))).slice(0, OFFERED);
    const pick = processGroupFor(read?.family, lists.groups);
    return {
      need, text: `Which process makes ${name}?`,
      hint: likely.length > 1 ? "The drawing points to this family of processes. Choose the one that is used." : "Choose one, or type another process.",
      options: offered.map(value => ({ value, ...(value === pick && read?.reason ? { why: read.reason } : {}) })),
      pick: pick && offered.includes(pick) ? pick : null, choices: [...lists.groups],
    };
  }
  if (need.kind === "grade") {
    const pick = gradeFor(part?.materialRead ?? null, lists.grades);
    const words = (part?.materialRead ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const near = words.length > 0 ? lists.grades.filter(g => words.some(w => g.toLowerCase().includes(w))) : [];
    const offered = [...new Set([...(pick ? [pick] : []), ...near])].slice(0, OFFERED);
    return {
      need, text: `Which material is ${name} made of?`,
      hint: part?.materialRead ? `The drawing says "${part.materialRead}". Choose the grade it means, or type one to search.` : `The drawing names no material. Type a grade to search the ${part?.processGroup ?? "process"} materials.`,
      options: offered.map(value => ({ value, ...(value === pick ? { why: `The drawing says "${part?.materialRead ?? ""}".` } : {}) })),
      pick, choices: [...lists.grades],
    };
  }
  if (need.kind === "size") {
    return {
      need, text: `What is the overall size of ${name}?`,
      hint: "The drawing gives no overall size. Type length × width × height in mm, for example 250 × 120 × 90; for a round part, ⌀40 × 120. It is costed as a solid of that size, which overstates a hollow part.",
      options: [], pick: null, choices: [],
    };
  }
  return {
    need, text: "Where are the parts made?", hint: "The cost uses this place's machine and labour rates.",
    options: lists.locations.slice(0, OFFERED).map(value => ({ value })), pick: null, choices: [...lists.locations],
  };
}

/**
 * The one of `choices` the person's words name: the same text whatever its case, else the only choice that holds every word typed.
 * When none or several do, why not (the first few are named, so the next try can be exact).
 */
export function matchChoice(typed: string, choices: readonly string[]): { value: string } | { error: string } {
  const text = typed.trim().toLowerCase();
  if (text === "") return { error: "Choose an answer, or type one." };
  const exact = choices.find(c => c.toLowerCase() === text);
  if (exact) return { value: exact };
  const words = text.split(/\s+/);
  const holding = choices.filter(c => words.every(w => c.toLowerCase().includes(w)));
  if (holding.length === 1 && holding[0]) return { value: holding[0] };
  if (holding.length === 0) return { error: `Nothing here is called "${typed.trim()}".` };
  return { error: `Several match "${typed.trim()}": ${holding.slice(0, 4).join("; ")}${holding.length > 4 ? "; and more" : ""}. Type more of the name.` };
}

// A unit counts only when it is written straight after a number ("25 cm"), so the word "in" in a sentence is not read as inches.
const UNIT_MM: [RegExp, number][] = [[/\d\s*(?:inch(?:es)?|in)\b|\d\s*"/i, 25.4], [/\d\s*cm\b/i, 10], [/\d\s*m\b/i, 1000]];
const MAX_MM = 20_000;

/**
 * An overall size from the person's own words, in millimetres: three numbers are a block (a sheet when the process is sheet metal,
 * its thinnest side the thickness); two numbers with a diameter mark are a round part. Null when the words hold no such size.
 */
export function sizeFrom(typed: string, processGroup: string | null): DrawingShape | null {
  const scale = UNIT_MM.find(([unit]) => unit.test(typed))?.[1] ?? 1;
  const numbers = (typed.match(/\d+(?:\.\d+)?/g) ?? []).map(n => Number(n) * scale);
  if (numbers.some(n => !(n > 0) || n > MAX_MM)) return null;
  if (numbers.length === 2 && /[⌀Øø]|\bdia(meter)?\b|\bround\b/i.test(typed)) {
    const [diameterMm, lengthMm] = numbers as [number, number];
    return { kind: "turned", segments: [{ diameterMm, lengthMm }], boreDiameterMm: null };
  }
  if (numbers.length !== 3) return null;
  const [a, b, c] = [...numbers].sort((x, y) => y - x) as [number, number, number];
  return /^sheet metal/i.test(processGroup ?? "") ? { kind: "sheet", lengthMm: a, widthMm: b, thicknessMm: c } : { kind: "block", lengthMm: a, widthMm: b, heightMm: c };
}

/** The plan with the person's answer in it, or why the answer cannot be used. */
export function applyAnswer(plan: IntakePlan, question: Question, value: string): { plan: IntakePlan; said: string } | { error: string } {
  const { need } = question;
  const setPart = (change: Partial<PlanPart>): IntakePlan => ({ ...plan, parts: plan.parts.map(p => (p.file === need.part ? { ...p, ...change } : p)) });
  if (need.kind === "size") {
    const shape = sizeFrom(value, plan.parts.find(p => p.file === need.part)?.processGroup ?? null);
    if (!shape) return { error: "That does not read as a size. Type three numbers in mm, like 250 × 120 × 90, or ⌀40 × 120 for a round part." };
    return { plan: setPart({ shape, holes: [] }), said: shapeSummary(shape, []) };
  }
  const matched = matchChoice(value, question.choices);
  if ("error" in matched) return matched;
  if (need.kind === "process") return { plan: setPart({ processGroup: matched.value, grade: null }), said: matched.value };
  if (need.kind === "grade") return { plan: setPart({ grade: matched.value }), said: matched.value };
  return { plan: { ...plan, location: matched.value }, said: matched.value };
}

/** What was seen on one drawing, in a sentence or two, from the reading's own findings. */
export function narrative(reading: DrawingReading, file: string): string {
  if (!reading.isDrawing) return `${file} is not a drawing or a picture of a manufactured part, so it is left out.`;
  const what = reading.partName ? `This is ${reading.partName}${reading.partNumber ? ` (${reading.partNumber})` : ""}.` : "This is a picture of a part.";
  const made = reading.process ? ` ${reading.process.reason}` : "";
  const material = reading.material ? ` Material on the drawing: ${reading.material}.` : " It names no material.";
  const size = reading.shape ? ` Overall: ${shapeSummary(reading.shape, reading.holes)}.` : " It gives no overall size.";
  const unsure = reading.unsure.length > 0 ? ` Not clear to me: ${reading.unsure.join(" ")}` : "";
  return `${what}${made}${material}${size}${unsure}`;
}

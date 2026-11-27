// What the prompt's placeholder shows while it waits: its examples typed out one after another. Pure: the page only supplies the clock.

/** What comes before every example. */
export const PROMPT_LEAD = 'Say what this is, for example: ';

/**
 * The examples: each says what a job is, as a person would. Short, so the lead and an example stay within two lines on a phone
 * (the prompt is two lines tall there).
 */
export const PROMPT_EXAMPLES: readonly string[] = [
  'brackets for the pump frame',
  'a gearbox housing, rev B',
  'sheet metal cabinet covers',
  'conveyor drive shafts',
  'cooling line flanges',
];

/** The placeholder when nothing moves: the first example in full. */
export const STILL_PLACEHOLDER = `${PROMPT_LEAD}${PROMPT_EXAMPLES[0] ?? ''}`;

/**
 * The typing, in ticks of the page's clock: a letter typed per tick, the whole example held to be read, then taken back two letters a
 * tick, then a short pause before the next.
 */
export const TYPING = { tickMs: 55, hold: 36, gap: 8, deletedPerTick: 2 } as const;

/** The caret shown while an example is being typed or taken back (the mark the brand's site types with). */
const CARET = '_';

/**
 * The placeholder at `tick` (0, 1, 2, ...): the lead, then as much of the current example as is typed, with the caret while it is
 * being typed or taken back. It runs through the examples and starts again. With no examples it is the lead alone.
 */
export function placeholderAt(tick: number, examples: readonly string[] = PROMPT_EXAMPLES, lead: string = PROMPT_LEAD): string {
  const ticksOf = (example: string) => example.length + TYPING.hold + Math.ceil(example.length / TYPING.deletedPerTick) + TYPING.gap;
  const cycle = examples.reduce((sum, example) => sum + ticksOf(example), 0);
  if (cycle === 0) return lead;
  let t = ((Math.floor(tick) % cycle) + cycle) % cycle;
  for (const example of examples) {
    const ticks = ticksOf(example);
    if (t >= ticks) { t -= ticks; continue; }
    if (t < example.length) return `${lead}${example.slice(0, t + 1)}${CARET}`;
    if (t < example.length + TYPING.hold) return `${lead}${example}`;
    const taken = (t - example.length - TYPING.hold + 1) * TYPING.deletedPerTick;
    return taken < example.length ? `${lead}${example.slice(0, example.length - taken)}${CARET}` : lead;
  }
  return lead;
}

/** The tick at which the first example stands in full, so a page that showed the still placeholder starts moving from what it shows. */
export const FIRST_HELD_TICK = (PROMPT_EXAMPLES[0] ?? '').length;

import { describe, expect, it } from 'vitest';

import { FIRST_HELD_TICK, placeholderAt, PROMPT_EXAMPLES, PROMPT_LEAD, STILL_PLACEHOLDER, TYPING } from '@/lib/intake/placeholder';

const LEAD = 'For example: ';
const at = (tick: number) => placeholderAt(tick, ['abcd', 'xy'], LEAD);
// 'abcd': 4 ticks typed, held, 2 ticks taken back, pause. 'xy': 2 typed, held, 1 taken back, pause.
const FIRST = 4 + TYPING.hold + 2 + TYPING.gap;
const SECOND = 2 + TYPING.hold + 1 + TYPING.gap;

describe('the prompt\'s typed placeholder', () => {
  it('types an example a letter a tick, with the caret', () => {
    expect([0, 1, 2, 3].map(at)).toEqual(['For example: a_', 'For example: ab_', 'For example: abc_', 'For example: abcd_']);
  });

  it('holds the whole example, without the caret, long enough to read', () => {
    expect(at(4)).toBe('For example: abcd');
    expect(at(4 + TYPING.hold - 1)).toBe('For example: abcd');
    expect(TYPING.hold * TYPING.tickMs).toBeGreaterThanOrEqual(1500);
  });

  it('takes it back two letters a tick, then shows the lead alone before the next', () => {
    expect(at(4 + TYPING.hold)).toBe('For example: ab_');
    expect(at(4 + TYPING.hold + 1)).toBe('For example: ');
    expect(at(FIRST - 1)).toBe('For example: ');
  });

  it('goes on to the next example, and after the last starts again', () => {
    expect(at(FIRST)).toBe('For example: x_');
    expect(at(FIRST + 1)).toBe('For example: xy_');
    expect(at(FIRST + SECOND)).toBe('For example: a_');
    expect(at(3 * (FIRST + SECOND) + 2)).toBe(at(2));
  });

  it('is the lead alone with no examples, and does not fail on a tick it is not given as a whole number', () => {
    expect(placeholderAt(12, [], LEAD)).toBe(LEAD);
    expect(at(1.7)).toBe('For example: ab_');
    expect(at(-1)).toBe('For example: ');
  });

  it('starts from what the still page shows: the first example in full', () => {
    expect(STILL_PLACEHOLDER).toBe(PROMPT_LEAD + (PROMPT_EXAMPLES[0] ?? ''));
    expect(placeholderAt(FIRST_HELD_TICK)).toBe(STILL_PLACEHOLDER);
  });

  it('keeps every example short enough for the prompt on a phone, and says each once', () => {
    expect(PROMPT_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(PROMPT_EXAMPLES).size).toBe(PROMPT_EXAMPLES.length);
    for (const example of PROMPT_EXAMPLES) expect(example.length).toBeLessThanOrEqual(28);
  });
});

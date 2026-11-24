import { describe, it, expect } from 'vitest';

import { stepRowLabel } from '@/lib/features/process-tree';

describe('stepRowLabel: a row under a step names only what the step acts on', () => {
  it('drops the step\'s own operation from the row', () => {
    expect(stepRowLabel('Obround Slot Milling // Keyway', 'Obround Slot Milling')).toBe('Keyway');
    expect(stepRowLabel('Rough Turning // Ring Ø10 x 3.84 mm', 'Rough Turning')).toBe('Ring Ø10 x 3.84 mm');
    expect(stepRowLabel('Drilling // Hole Ø1.6 mm ×2', 'Drilling')).toBe('Hole Ø1.6 mm ×2');
  });

  it('keeps a row of another operation, and a row with nothing after the operation, as it is', () => {
    expect(stepRowLabel('Piercing // 3 hole(s), in the same stroke', 'Hydroform')).toBe('Piercing // 3 hole(s), in the same stroke');
    expect(stepRowLabel('M2 tapped ×2', 'Tapping')).toBe('M2 tapped ×2');
    expect(stepRowLabel('Drilling // ', 'Drilling')).toBe('Drilling // ');
  });
});

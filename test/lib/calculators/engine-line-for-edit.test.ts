import { describe, expect, it } from 'vitest';

import { engineLineForEdit } from '@/lib/calculators/engine-line-for-edit';

// FusionComponent's live lines in the Inspection category, in the order the engine builds them.
const INSPECTION = { machineClass: 'machining_inspection', process: 'Inspection', machine: 'Default' };
const XRF = { machineClass: 'xrf_analyzer', process: 'RM Composition Analysis', machine: 'Handheld XRF Alloy Analyzer' };
const lines = [INSPECTION, XRF];

describe('engineLineForEdit: the live line an edited row picks its machine from', () => {
  it('an XRF row saved with no machine opens on the XRF analyzer, not the category\'s first line (the inspection station)', () => {
    expect(engineLineForEdit(lines, 'xrf_analyzer', 'RM Composition Analysis: no cycle time was resolved for this operation, so it cannot be costed or persisted')).toBe(XRF);
    expect(engineLineForEdit(lines, 'xrf_analyzer', null)).toBe(XRF);
  });

  it('within the row\'s class, the line of the chosen operation', () => {
    const second = { ...INSPECTION, process: 'Final Inspection', machine: 'CMM 2' };
    expect(engineLineForEdit([INSPECTION, second], 'machining_inspection', 'Final Inspection')).toBe(second);
  });

  it('a row with no saved class, or a class with no live line, falls back to the operation, then the category\'s first line', () => {
    expect(engineLineForEdit(lines, null, 'RM Composition Analysis')).toBe(XRF);
    expect(engineLineForEdit(lines, 'gun_drill', null)).toBe(INSPECTION);
    expect(engineLineForEdit([], 'xrf_analyzer', null)).toBeUndefined();
  });
});

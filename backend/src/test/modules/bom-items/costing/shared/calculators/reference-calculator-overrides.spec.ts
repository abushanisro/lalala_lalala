import { forPart, runReferenceCalculator, withFieldOverrides, type ReferenceCalculators } from '../../../../../../modules/bom-items/costing/shared/calculators/reference-calculator';

// A part's own value for one field of a stored calculator (migration 1011): an engineer who knows better sets it, with the reason. An input's value replaces
// the seeded one; a calculated field's value replaces the formula's result, and every later formula uses it. The trace keeps what the calculator would
// have used and why it was changed. The stored calculator is never edited.
const CALC: ReferenceCalculators = {
  Cycle: {
    calculatorId: 'c1', name: 'Injection Molding - Cycle Time', version: 3,
    fields: [
      { field_name: 'Wall', field_type: 'number', unit: 'mm', display_order: 1 },
      { field_name: 'Dry Cycle', field_type: 'number', unit: 's', display_order: 2 },
      { field_name: 'Cooling Time', field_type: 'calculated', unit: 's', default_value: '{Wall} * {Wall}', display_order: 3 },
      { field_name: 'Pack Time', field_type: 'calculated', unit: 's', default_value: '{Cooling Time} * 0.5', display_order: 4 },
      { field_name: 'Cycle Time', field_type: 'calculated', unit: 's', default_value: '{Cooling Time} + {Pack Time} + {Dry Cycle}', display_order: 5 },
    ],
  },
};
const seeds = { Wall: { value: 2, source: 'CAD nominal wall' }, 'Dry Cycle': { value: 1.2, source: 'Press record' } };
const step = (r: ReturnType<typeof runReferenceCalculator>, name: string) => r.trace.find((t) => t.fieldName === name)!;

describe('a part\'s own value for a calculator field', () => {
  it('without overrides, the calculator runs as stored', () => {
    expect(runReferenceCalculator(CALC, 'Cycle', seeds).value).toBe(4 + 2 + 1.2);
  });

  it('an input: replaces the seeded value, and the trace says what it replaced and why', () => {
    const r = runReferenceCalculator(withFieldOverrides(CALC, { 'Injection Molding - Cycle Time': { 'Dry Cycle': { value: 2, reason: 'press runs slow' } } }), 'Cycle', seeds);
    expect(r.value).toBe(4 + 2 + 2);
    expect(step(r, 'Dry Cycle')).toMatchObject({ value: 2, override: { original: 1.2, reason: 'press runs slow' } });
    expect(step(r, 'Dry Cycle').source).toMatch(/Engineer's value for this part.*press runs slow.*Press record/);
  });

  it('a calculated field: replaces the formula result, and later formulas use it', () => {
    const r = runReferenceCalculator(withFieldOverrides(CALC, { 'Injection Molding - Cycle Time': { 'Cooling Time': { value: 6, reason: 'measured on the tool' } } }), 'Cycle', seeds);
    expect(step(r, 'Cooling Time')).toMatchObject({ kind: 'calculated', value: 6, override: { original: 4, reason: 'measured on the tool' } });
    expect(step(r, 'Pack Time').value).toBe(3);
    expect(r.value).toBe(6 + 3 + 1.2);
    expect(r.outputs['Cooling Time']).toBe(6);
  });

  it('an override of another calculator, or of a field the calculator does not have, changes nothing', () => {
    expect(runReferenceCalculator(withFieldOverrides(CALC, { 'Other Calculator': { Wall: { value: 9, reason: 'x' } } }), 'Cycle', seeds).value).toBe(7.2);
    expect(runReferenceCalculator(withFieldOverrides(CALC, { 'Injection Molding - Cycle Time': { Nope: { value: 9, reason: 'x' } } }), 'Cycle', seeds).value).toBe(7.2);
  });

  it('never edits the stored calculators it is given', () => {
    const before = JSON.stringify(CALC);
    withFieldOverrides(CALC, { 'Injection Molding - Cycle Time': { Wall: { value: 9, reason: 'x' } } });
    expect(JSON.stringify(CALC)).toBe(before);
    expect(withFieldOverrides(CALC, null)).toBe(CALC);
  });
});

// Where the costing lays a part's values over the calculators (forPart), every run says which of its steps the part can set: a parameter (the
// calculator's own value, a reference-table row, a variable, a machine or material record), never a measurement of the part or a result worked
// out from other values. The Cost panel offers the pencil on exactly those steps.
const MILL: ReferenceCalculators = {
  'Rough Milling': {
    calculatorId: 'm1', name: 'Machining - Rough Milling', version: 2,
    fields: [
      { field_name: 'Cut Depth', field_type: 'number', unit: 'mm', display_order: 1 },
      { field_name: 'Cutter Diameter', field_type: 'number', unit: 'mm', display_order: 2 },
      { field_name: 'Max Spindle Speed', field_type: 'number', unit: 'rpm', display_order: 3 },
      { field_name: 'Operations Time', field_type: 'number', unit: 's', display_order: 4 },
      { field_name: 'Depth of Cut', field_type: 'number', unit: 'mm', default_value: 2, note: 'End Milling sheet: 2 mm', display_order: 5 },
      { field_name: 'Allowance', field_type: 'calculated', unit: 's', default_value: '1.5', display_order: 6 },
      { field_name: 'Depth Passes', field_type: 'calculated', default_value: 'ceil({Cut Depth} / {Depth of Cut})', display_order: 7 },
      { field_name: 'Cycle Time', field_type: 'calculated', unit: 's', default_value: '{Depth Passes} * 3 + {Allowance} + {Operations Time}', display_order: 8 },
    ],
  },
};
const millSeeds = {
  'Cut Depth': { value: 19, source: 'CAD: depth', ref: { kind: 'features' as const, label: 'Pocket', features: [{ featureId: 'PocketV2-1' }] } },
  'Cutter Diameter': { value: 10, source: 'tblMillingFinishing: mild_steel ToolDiameterMm', lookup: true },
  'Max Spindle Speed': { value: 8000, source: 'Machine: test mill', ref: { kind: 'machine' as const, machineId: 'mhr-1', machineName: 'Test mill', column: 'specs.spindle_speed_rpm' } },
  'Operations Time': { value: 4, source: 'CAD features: Drilling (operation sequence)', sumOf: [{ operation: 0, name: 'Drilling', seconds: 4, count: 2 }] },
};
const SET = { calculator: 'Machining - Rough Milling' };

describe('the steps a part can set, where the costing lays its values over the calculators', () => {
  const r = runReferenceCalculator(forPart(MILL, null), 'Rough Milling', millSeeds);

  it('a parameter can be set: a table row, a machine value, the calculator\'s own value, a constant it states', () => {
    expect(step(r, 'Cutter Diameter').settable).toEqual({ ...SET, field: 'Cutter Diameter' });
    expect(step(r, 'Max Spindle Speed').settable).toEqual({ ...SET, field: 'Max Spindle Speed' });
    expect(step(r, 'Depth of Cut').settable).toEqual({ ...SET, field: 'Depth of Cut' });
    expect(step(r, 'Allowance').settable).toEqual({ ...SET, field: 'Allowance' });
  });

  it('a measurement of the part, a sum of other operations and a result cannot', () => {
    expect(step(r, 'Cut Depth').settable).toBeUndefined();
    expect(step(r, 'Operations Time').settable).toBeUndefined();
    expect(step(r, 'Depth Passes').settable).toBeUndefined();
    expect(step(r, 'Cycle Time').settable).toBeUndefined();
  });

  it('an input that adds up other operations keeps their list', () => {
    expect(step(r, 'Operations Time').sumOf).toEqual([{ operation: 0, name: 'Drilling', seconds: 4, count: 2 }]);
  });

  it('the part\'s own value is used, and the step it replaced can be set back', () => {
    const own = runReferenceCalculator(forPart(MILL, { 'Machining - Rough Milling': { 'Depth of Cut': { value: 4, reason: 'rigid setup' } } }), 'Rough Milling', millSeeds);
    // 19 mm in 4 mm passes: 5 passes (10 at the calculator's 2 mm).
    expect(step(own, 'Depth Passes').value).toBe(5);
    expect(step(r, 'Depth Passes').value).toBe(10);
    expect(step(own, 'Depth of Cut')).toMatchObject({ value: 4, override: { original: 2, reason: 'rigid setup' }, settable: { ...SET, field: 'Depth of Cut' } });
  });

  it('calculators the costing does not lay a part\'s values over name no step as settable', () => {
    expect(runReferenceCalculator(MILL, 'Rough Milling', millSeeds).trace.some((s) => s.settable)).toBe(false);
    expect(runReferenceCalculator(withFieldOverrides(MILL, { 'Machining - Rough Milling': { 'Depth of Cut': { value: 4, reason: 'x' } } }), 'Rough Milling', millSeeds).trace.some((s) => s.settable)).toBe(false);
  });

  it('never edits the stored calculators it is given', () => {
    const before = JSON.stringify(MILL);
    forPart(MILL, { 'Machining - Rough Milling': { 'Depth of Cut': { value: 4, reason: 'x' } } });
    expect(JSON.stringify(MILL)).toBe(before);
    expect(forPart(null, null)).toBeNull();
  });
});

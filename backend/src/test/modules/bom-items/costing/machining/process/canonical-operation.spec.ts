import {
  machiningRouteFamilyOf,
  resolveCanonicalOperation,
} from '../../../../../../modules/bom-items/costing/machining/process/canonical-operation';
import { KEYWAY_MILLING } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { isReferenceOperation } from '../../../../../../modules/bom-items/costing/shared/reference-features.generated';

// canonical-operation.ts verifies every pairing against the generated
// reference catalog at import time; these tests pin the resolved labels and
// the catalog check itself.
describe('resolveCanonicalOperation', () => {
  it('labels plain, cross and patterned holes as Drilling // SimpleHole', () => {
    for (const variant of ['through', 'blind', 'cross', 'pcd_pattern']) {
      expect(resolveCanonicalOperation('SimpleHole', variant, 'milling')).toBe('Drilling // SimpleHole');
    }
  });

  it('labels a threaded hole as Tapping // SimpleHole', () => {
    expect(resolveCanonicalOperation('SimpleHole', 'threaded', 'milling')).toBe('Tapping // SimpleHole');
  });

  it('labels a counterbore by the operation the catalog attaches to its MultiStepHole', () => {
    expect(resolveCanonicalOperation('MultiStepHole', 'counterbore', 'milling')).toBe('Multistep Holemaking // MultiStepHole');
  });

  it('uses the lathe-specific chamfer operation on turning routes', () => {
    expect(resolveCanonicalOperation('Edge', 'chamfer', 'milling')).toBe('Chamfering // Edge');
    expect(resolveCanonicalOperation('Edge', 'chamfer', 'turning')).toBe('Mill Chamfering // Edge');
  });

  it('labels a keyway by the operation the cost engine mills it by, so the feature and its cost row carry one name', () => {
    for (const family of ['milling', 'turning'] as const) {
      expect(resolveCanonicalOperation('Keyway', 'default', family)).toBe('Obround Slot Milling // Keyway');
      expect(resolveCanonicalOperation('Keyway', 'default', family)).toBe(`${KEYWAY_MILLING} // Keyway`);
    }
  });

  it('labels a flat on a turned diameter by the operation the cost engine mills it by, Rough Milling', () => {
    for (const family of ['milling', 'turning'] as const) {
      expect(resolveCanonicalOperation('Flat', 'default', family)).toBe('Rough Milling // Flat');
    }
    // The catalog gives it only as a step of the machine's setup ("3 Axis Lathe:Setup:Rough Milling//Flat"): the vocabulary's name for the
    // operation carries the step, the label does not.
    expect(isReferenceOperation('machining', 'Flat', 'Setup:Rough Milling')).toBe(true);
    expect(isReferenceOperation('machining', 'Flat', 'Rough Milling')).toBe(false);
  });

  it('treats a missing variant as "default"', () => {
    expect(resolveCanonicalOperation('PocketV2', undefined, 'milling')).toBe('Rough Milling // PocketV2');
  });

  it('returns null for an unmapped feature instead of a fabricated label', () => {
    expect(resolveCanonicalOperation('AxiGroove', 'default', 'milling')).toBeNull();
    expect(resolveCanonicalOperation('SimpleHole', 'made_up', 'milling')).toBeNull();
  });

  it('maps the backend-normalized cad families onto route families', () => {
    expect(machiningRouteFamilyOf('turned')).toBe('turning');
    expect(machiningRouteFamilyOf('mill_turn')).toBe('turning');
    expect(machiningRouteFamilyOf('milled')).toBe('milling');
  });
});

describe('isReferenceOperation (generated from the reference catalog)', () => {
  it('accepts a real catalog pairing and rejects an invented one', () => {
    expect(isReferenceOperation('machining', 'SimpleHole', 'Drilling')).toBe(true);
    expect(isReferenceOperation('machining', 'SimpleHole', 'Laser Drilling')).toBe(false);
    expect(isReferenceOperation('sheet_metal', 'StraightBend', 'Bending')).toBe(true);
  });
});

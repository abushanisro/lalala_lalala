import { describe, expect, it } from 'vitest';

import { featureOperations, operationsLabel } from '@/lib/features/feature-operations';

describe('a feature\'s operations, in order', () => {
  it('a tapped hole is drilled, then tapped: "Drilling → Tapping // SimpleHole"', () => {
    // R_M-0230-031 CANNULA: the M3 holes, stamped "Tapping // SimpleHole".
    const threaded = { feature_type: 'SimpleHole', canonical_operation: 'Tapping // SimpleHole', occurrences: [{ tapped: true }] };
    expect(featureOperations(threaded)).toEqual(['Drilling // SimpleHole', 'Tapping // SimpleHole']);
    expect(operationsLabel(featureOperations(threaded))).toBe('Drilling → Tapping // SimpleHole');
    // FusionComponent's tapped cross holes are stamped "Drilling // SimpleHole" (variant cross): tapped too.
    const cross = { feature_type: 'SimpleHole', canonical_operation: 'Drilling // SimpleHole', occurrences: [{ tapped: true }, { tapped: false }] };
    expect(operationsLabel(featureOperations(cross))).toBe('Drilling → Tapping // SimpleHole');
    // One occurrence at a time: the untapped one is drilled only.
    expect(operationsLabel(featureOperations(cross, false))).toBe('Drilling // SimpleHole');
  });

  it('any other feature is its one operation; a feature with none has none', () => {
    expect(featureOperations({ feature_type: 'Edge', canonical_operation: 'Countersinking // Edge', occurrences: [{ tapped: false }] })).toEqual(['Countersinking // Edge']);
    expect(featureOperations({ feature_type: 'SimpleHole', canonical_operation: 'Drilling // SimpleHole', occurrences: [] })).toEqual(['Drilling // SimpleHole']);
    expect(featureOperations({ feature_type: 'Bend', occurrences: [] })).toEqual([]);
    expect(operationsLabel([])).toBe('');
  });
});

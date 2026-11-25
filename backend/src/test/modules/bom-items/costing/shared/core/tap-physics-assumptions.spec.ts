import { resolveTapPhysicsInputs } from '../../../../../../modules/bom-items/costing/shared/core/default-rates.constants';

// Tap physics feeds cycle time: feed = RPM x pitch, RPM from diameter. Two of
// its three inputs used to be fabricated in silence when the real value was
// missing, while the calculator's provenance line reported them as measured:
//
//   diameter  an unparseable size string became M4, labelled
//             'Parsed from thread size "<size>"'.
//   pitch     a nominal outside the ISO 261 coarse series got 1.0mm, labelled
//             'Standard pitch for this nominal diameter'.
//
// Depth already carried a depthIsAssumed flag and disclosed itself correctly;
// these tests hold the other two to the same standard. The assumed VALUES are
// unchanged — only whether the system admits to using them.

describe('tap physics reports which of its inputs were assumed', () => {
  it('flags an unparseable thread size instead of quietly tapping M4', () => {
    const r = resolveTapPhysicsInputs('1/4-20 UNC', null, 5, 5, 'SECC');
    expect(r.diameterIsAssumed).toBe(true);
    expect(r.diameterMm).toBe(4);
  });

  it('does not flag a size it really parsed', () => {
    const r = resolveTapPhysicsInputs('M6', null, 5, 5, 'SECC');
    expect(r.diameterIsAssumed).toBe(false);
    expect(r.diameterMm).toBe(6);
  });

  it('uses the real ISO 261 coarse pitch without flagging an assumption', () => {
    // M4 coarse really is 0.7 — reference data, not a guess.
    const r = resolveTapPhysicsInputs('M4', null, 5, 5, 'SECC');
    expect(r.pitchMm).toBeCloseTo(0.7, 10);
    expect(r.pitchIsAssumed).toBe(false);
  });

  it('flags a nominal that is not in the coarse series', () => {
    // M13 is not an ISO 261 coarse-series diameter: the assumed tap's pitch, M4's ISO 262 coarse 0.7 (it was 1.0, no M4 thread).
    const r = resolveTapPhysicsInputs('M13', null, 5, 5, 'SECC');
    expect(r.pitchIsAssumed).toBe(true);
    expect(r.pitchMm).toBe(0.7);
  });

  it('taps a hole with no measured depth in solid stock for its thread engagement: 1 x D in steel, 2 x D in aluminium (Nord-Lock)', () => {
    expect(resolveTapPhysicsInputs('M6', null, null, null, 'SECC')).toMatchObject({ depthMm: 6, depthIsAssumed: true });
    expect(resolveTapPhysicsInputs('M6', null, null, null, 'AL6061')).toMatchObject({ depthMm: 12, depthIsAssumed: true });
    // A sheet tapped through: its thickness, as before.
    expect(resolveTapPhysicsInputs('M6', null, null, 2, 'AL6061')).toMatchObject({ depthMm: 2, depthIsAssumed: true });
  });

  it('taps at the workbook\'s HSS tapping speeds (Tapping sheet D39, D47, D51: the middle of each range)', () => {
    expect(resolveTapPhysicsInputs('M6', null, 5, 5, 'SECC').surfaceSpeedMMin).toBe(11.5);
    expect(resolveTapPhysicsInputs('M6', null, 5, 5, 'SS304').surfaceSpeedMMin).toBe(8.5);
    expect(resolveTapPhysicsInputs('M6', null, 5, 5, 'AL6061').surfaceSpeedMMin).toBe(16);
  });

  it('never flags a pitch the drawing actually stated', () => {
    const r = resolveTapPhysicsInputs('M7', 1.25, 5, 5, 'SECC');
    expect(r.pitchIsAssumed).toBe(false);
    expect(r.pitchMm).toBe(1.25);
  });
});

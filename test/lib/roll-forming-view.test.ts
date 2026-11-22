import { describe, expect, it } from 'vitest';

import { coilLine, isRollFormingItem, lineSpeedLine, rollFormingOverridesOf, stationsLine, tubeLine } from '@/lib/costing/roll-forming-view';
import { rollFormingRouteKeyOf } from '@/lib/routing/roll-forming-route-id';

describe('the Sheet Metal Roll Forming Cost Guide', () => {
  it('is the panel of a part whose Process is Sheet Metal Roll Forming, not of a plain or hydroformed sheet-metal part', () => {
    expect(isRollFormingItem({ scenarioOverrides: { processGroup: 'Sheet Metal Roll Forming' } })).toBe(true);
    expect(isRollFormingItem({ scenarioOverrides: { processGroup: 'Sheet Metal - Hydroforming' } })).toBe(false);
    expect(isRollFormingItem(null)).toBe(false);
  });

  it('reads the settings as the engine does: a known cut-off and welder, whole stations of at least 1, a positive multiplier', () => {
    expect(rollFormingOverridesOf({ rollFormCutOff: 'Blade', rollFormWelding: 'tig', rollFormStations: '7.4', rollFormToolingMultiplier: 12.5 }))
      .toEqual({ cutOff: 'blade', welding: 'tig', stations: 7, toolingMultiplier: 12.5 });
    expect(rollFormingOverridesOf({ rollFormCutOff: 'laser', rollFormWelding: 'mig', rollFormStations: 0, rollFormToolingMultiplier: -1 }))
      .toEqual({ cutOff: null, welding: null, stations: null, toolingMultiplier: null });
    expect(rollFormingOverridesOf(undefined)).toEqual({ cutOff: null, welding: null, stations: null, toolingMultiplier: null });
  });

  it('states the stations, the line speed and the coil as an engineer reads them', () => {
    expect(stationsLine({
      forming: 6, leadIn: 0, finishing: 1, rule: 7, total: 7, override: null, panel: false, levelSource: 'the cad-engine',
      levels: [{ level: 1, bends: 2, maxAngleDeg: 90, passes: 6 }],
    })).toBe('level 1: 2 bends to 90° → 6 · finishing 1 = 7');
    // A long flange limits the angle a pass forms (the engine's breakdown names it).
    expect(stationsLine({
      forming: 11, leadIn: 0, finishing: 1, rule: 12, total: 12, override: null, panel: false, levelSource: 'the cad-engine', standSpacingMm: 508,
      levels: [{ level: 1, bends: 2, maxAngleDeg: 90, passes: 11, flangeCarriedMm: 100, degreesPerPass: 8.32, governedBy: 'flange length' }],
    })).toBe('level 1: 2 bends to 90° at 8.3°/pass (100 mm flange) → 11 · finishing 1 = 12');
    expect(tubeLine({ outerDiameterMm: 50, wallMm: 2, majorMm: null, minorMm: null })).toBe('Ø50 x 2 mm wall');
    expect(tubeLine({ outerDiameterMm: null, wallMm: 2, majorMm: 92, minorMm: 32 })).toBe('oval 92 x 32 x 2 mm wall');
    expect(lineSpeedLine({ mmPerS: 660.4, limiting: 'the part-length tolerance', multiplier: 1, caps: [] })).toBe('660 mm/s, set by the part-length tolerance');
    expect(coilLine({ massKg: 1234.4, partsPerCoil: 540, changeTimeS: 960, perPartS: 1.78, method: 'threading' }))
      .toBe('1,234 kg coil · 540 parts · change 960 s (threading) → 1.8 s a part');
  });

  it('reads a roll forming route id as its cut-off key, any other route as none', () => {
    expect(rollFormingRouteKeyOf('roll-forming-scissor')).toBe('scissor');
    expect(rollFormingRouteKeyOf('roll-forming-')).toBeUndefined();
    expect(rollFormingRouteKeyOf('hydroform-deep-draw')).toBeUndefined();
  });
});

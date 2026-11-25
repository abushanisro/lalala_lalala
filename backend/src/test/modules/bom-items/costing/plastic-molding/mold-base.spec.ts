import { selectMoldBase } from '../../../../../modules/bom-items/costing/plastic-molding/process/mold-base';
import { realPlasticReference } from './real-plastic-reference';

// The mold base a part needs, from memory/Plastic Modeling: the cavity layout (layoutNumCav), the steel between and beside the cavities
// (betweenPartsMoldBorder, tblEdgeMoldBorderX/Y by the press force), and the smallest standard base that holds it (tblStandardMoldBaseSizes, metric).
const MB = realPlasticReference().moldBase;

describe('the mold base reference', () => {
  it('is the metric standard bases, the borders by press force, and the default tool steel AISI P20', () => {
    expect(MB.system).toBe('Metric');
    expect(MB.bases.length).toBeGreaterThan(50);
    expect(MB.steel).toEqual({ name: 'AISI P20', densityKgM3: 7850, priceUsdPerKg: 1.86, moldBaseCostFactor: 1 });
    expect(MB.cavityDepthBorderByKn[0]).toEqual({ maxKn: 498.2, mm: 3 * 25.4 });
    expect(MB.betweenPartsMm).toBe(76.2);
  });
});

describe('selectMoldBase', () => {
  it('one cavity: the part plus the edge borders, in the smallest standard base that holds it', () => {
    const r = selectMoldBase({ partLengthMm: 170.5, partWidthMm: 93.6, cavities: 1, clampKn: 350, ref: MB });
    if ('missing' in r) throw new Error(r.missing.join());
    // 350 kN: edge X 140 mm (rows up to 1,494.6 kN), edge Y 152 mm (90 mm is only up to 298.92 kN)
    expect(r.requiredWidthMm).toBeCloseTo(170.5 + 2 * 140, 6);
    expect(r.requiredLengthMm).toBeCloseTo(93.6 + 2 * 152, 6);
    const fits = (b: { widthMm: number; lengthMm: number }) =>
      (b.widthMm >= r.requiredWidthMm && b.lengthMm >= r.requiredLengthMm) || (b.lengthMm >= r.requiredWidthMm && b.widthMm >= r.requiredLengthMm);
    expect(fits(r.base)).toBe(true);
    // no smaller base fits
    for (const b of MB.bases.filter((x) => x.widthMm * x.lengthMm < r.base.widthMm * r.base.lengthMm)) expect(fits(b)).toBe(false);
    expect(r.cavityDepthBorderMm).toBeCloseTo(3 * 25.4, 6);
  });

  it('several cavities: laid out as layoutNumCav says, with the steel between the parts', () => {
    const r = selectMoldBase({ partLengthMm: 50, partWidthMm: 30, cavities: 4, clampKn: 1000, ref: MB });
    if ('missing' in r) throw new Error(r.missing.join());
    const { layout } = r;
    expect(MB.layouts).toContainEqual({ cavities: 4, ...layout });
    expect(r.regionWidthMm).toBeCloseTo((layout.widthWise * 50 + (layout.widthWise - 1) * 76.2) * layout.runnerCoefficient, 6);
    expect(r.regionLengthMm).toBeCloseTo(layout.lengthWise * 30 + (layout.lengthWise - 1) * 76.2, 6);
  });

  it('of the layouts layoutNumCav gives a count (4: 1 x 4, 2 x 2, 4 x 1), the one with the smallest standard base is the mold', () => {
    const r = selectMoldBase({ partLengthMm: 150, partWidthMm: 97, cavities: 4, clampKn: 1400, ref: MB });
    if ('missing' in r) throw new Error(r.missing.join());
    expect(r.layout).toMatchObject({ widthWise: 2, lengthWise: 2 });
    for (const l of MB.layouts.filter((x) => x.cavities === 4)) {
      const other = selectMoldBase({ partLengthMm: 150, partWidthMm: 97, cavities: 4, clampKn: 1400, ref: { ...MB, layouts: [l] } });
      if (!('missing' in other)) expect(other.base.widthMm * other.base.lengthMm).toBeGreaterThanOrEqual(r.base.widthMm * r.base.lengthMm);
    }
  });

  it('names what is missing: no layout for the cavity count, no press force, no standard base big enough', () => {
    const miss = (r: ReturnType<typeof selectMoldBase>) => ('missing' in r ? r.missing.join(' ') : '');
    expect(miss(selectMoldBase({ partLengthMm: 50, partWidthMm: 30, cavities: 3, clampKn: 350, ref: MB }))).toMatch(/layoutNumCav has no layout for 3 cavities/);
    expect(miss(selectMoldBase({ partLengthMm: 50, partWidthMm: 30, cavities: 1, clampKn: null, ref: MB }))).toMatch(/press clamp force/);
    expect(miss(selectMoldBase({ partLengthMm: 5000, partWidthMm: 3000, cavities: 1, clampKn: 350, ref: MB }))).toMatch(/no standard mold base.*custom base is not modelled/);
  });
});

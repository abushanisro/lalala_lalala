import { NOT_A_SHEET_RATIO, SHEET_WARN_RATIO, sheetShare } from '../../../../../../modules/bom-items/costing/shared/physics/sheet-share';

describe('sheetShare: how much of a part is the sheet the cad-engine measured', () => {
  it('is the volume over the sheet (area x thickness), with what it reads', () => {
    expect(sheetShare(3000, 1000, 3, 'flat')).toEqual({ ratio: 1, found: "the cad-engine found 100 % of the part's 3,000 mm³ as a 3 mm sheet (1,000 mm² flat, 1x)" });
    const housing = sheetShare(5506.91, 756.8, 1, 'developed');
    expect(housing?.ratio).toBeGreaterThan(NOT_A_SHEET_RATIO);
    expect(housing?.found).toBe("the cad-engine found 14 % of the part's 5,507 mm³ as a 1 mm sheet (757 mm² developed, 7.28x)");
    expect(SHEET_WARN_RATIO).toBeLessThan(NOT_A_SHEET_RATIO);
  });

  it('is null when the volume, the area or the thickness is not known', () => {
    expect(sheetShare(null, 1000, 3, 'flat')).toBeNull();
    expect(sheetShare(3000, 0, 3, 'flat')).toBeNull();
    expect(sheetShare(3000, 1000, null, 'flat')).toBeNull();
    expect(sheetShare(3000, 1000, -1, 'flat')).toBeNull();
  });
});

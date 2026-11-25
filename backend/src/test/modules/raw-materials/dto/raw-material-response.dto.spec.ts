import { RawMaterialResponseDto } from '../../../../modules/raw-materials/dto/raw-material-response.dto';

describe('RawMaterialResponseDto.fromDatabase — currency labeling', () => {
  // cost_india and cost hold USD per kg (material-location-price.ts): India's price of Aluminum AA 7003 is 2.72 dollars, not rupees.
  it('labels a cost_india-sourced value as USD, the currency the column holds', () => {
    const row = { id: '1', material: 'Generic Aluminum, AA 7003', cost_india: '2.72', cost: null, currency: null };
    const dto = RawMaterialResponseDto.fromDatabase(row);
    expect(dto.unitCost).toBe(2.72);
    expect(dto.currency).toBe('USD');
  });

  it('labels a cost-only value as USD when currency is null', () => {
    const row = { id: '2', material: 'Mild Steel', cost_india: null, cost: '0.62', currency: null };
    const dto = RawMaterialResponseDto.fromDatabase(row);
    expect(dto.unitCost).toBe(0.62);
    expect(dto.currency).toBe('USD');
  });

  it('respects a currency the row records instead of overriding it', () => {
    const row = { id: '3', material: 'Imported Alloy', cost_india: null, cost: '5', currency: 'EUR' };
    const dto = RawMaterialResponseDto.fromDatabase(row);
    expect(dto.currency).toBe('EUR');
  });

  it('leaves currency undefined (not a guessed default) when there is no cost value at all', () => {
    const row = { id: '4', material: 'Unpriced Material', cost_india: null, cost: null, currency: null };
    const dto = RawMaterialResponseDto.fromDatabase(row);
    expect(dto.unitCost).toBeUndefined();
    expect(dto.currency).toBeUndefined();
  });
});

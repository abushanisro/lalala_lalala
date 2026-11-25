// The drawing analyser's response is validated with the whitelist on (auto-fill.service.ts analyzeDrawing): a field the DTO does not
// decorate is stripped before the row is stored. countStated (PR #818) was never stored for that reason. These are the fields the cost
// engine reads to tell an external thread from a tapped one and to knurl a diameter.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DrawingIntelligenceDto } from '../../../../modules/bom-items/dto/drawing-intelligence.dto';

const response = (over: Record<string, unknown> = {}) => ({
  material: 'Not specified', material_confidence: 0, process: 'CNC Turning', dimensions_mm: { L: 0, W: 0, H: 0 },
  tightest_tolerance_mm: 0, tolerance_confidence: 0, surface_finish_ra: 0, surface_finish_confidence: 0,
  sheet_thickness_mm: 0, sheet_thickness_confidence: 0, bend_count: 0, heat_treatment: 'None', coating: 'None', complexity: 'medium',
  threads: [], gdt_callouts: [], clearanceHoles: [], general_tolerances: '', drawing_revision: '', drawing_number: '', drawing_notes: '',
  drawing_intelligence_confidence: 0, analyzedAt: '2026-11-25T00:00:00Z', parserVersion: 'v2',
  ...over,
});

async function stored(data: Record<string, unknown>) {
  const instance = plainToInstance(DrawingIntelligenceDto, data);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: false });
  return { instance: JSON.parse(JSON.stringify(instance)), errors };
}

describe('the drawing intelligence a parsed drawing stores', () => {
  it('keeps what a thread callout states of its count, pitch, class, kind and length', async () => {
    const { instance, errors } = await stored(response({
      threads: [
        { size: 'M12', pitch: 1.75, count: 1, countStated: false, pitchStated: true, toleranceClass: '6g', threadKind: 'external', lengthMm: 15,
          standard: 'metric', extractionConfidence: 0.85, extractionSource: 'drawing_text', unknownField: 'dropped' },
        { size: '1/4-20', tpi: 20, count: 2, countStated: true, toleranceClass: '2B', threadKind: 'internal', lengthMm: null,
          standard: 'imperial', extractionConfidence: 0.85, extractionSource: 'drawing_text' },
      ],
    }));
    expect(errors).toEqual([]);
    expect(instance.threads[0]).toEqual({
      size: 'M12', pitch: 1.75, count: 1, countStated: false, pitchStated: true, toleranceClass: '6g', threadKind: 'external', lengthMm: 15,
      standard: 'metric', extractionConfidence: 0.85, extractionSource: 'drawing_text',
    });
    expect(instance.threads[1]).toMatchObject({ countStated: true, toleranceClass: '2B', threadKind: 'internal', lengthMm: null });
  });

  it('keeps the knurl callouts', async () => {
    const knurl = { pattern: 'diamond', grade: 'medium', pitchMm: 0.8, tpi: null, diameterMm: 20, lengthMm: 10, text: 'Ø20 MEDIUM DIAMOND KNURL 0.8 P 10 LG', extractionSource: 'drawing_text' };
    const { instance, errors } = await stored(response({ knurls: [knurl] }));
    expect(errors).toEqual([]);
    expect(instance.knurls).toEqual([knurl]);
  });

  it('a drawing analysed before these fields existed is still valid', async () => {
    const { errors, instance } = await stored(response({
      threads: [{ size: 'M3', pitch: 0.5, count: 1, standard: 'metric', extractionConfidence: 0.85, extractionSource: 'drawing_text' }],
    }));
    expect(errors).toEqual([]);
    expect(instance.knurls).toBeUndefined();
  });

  it('refuses a thread kind or a knurl pattern it does not know', async () => {
    const thread = { size: 'M3', count: 1, standard: 'metric', extractionConfidence: 0.85, extractionSource: 'drawing_text', threadKind: 'sideways' };
    expect((await stored(response({ threads: [thread] }))).errors).not.toEqual([]);
    expect((await stored(response({ knurls: [{ pattern: 'wavy', text: 'KNURL', extractionSource: 'drawing_text' }] }))).errors).not.toEqual([]);
  });
});

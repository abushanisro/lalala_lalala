import { BadGatewayException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';

import {
  DRAWING_READING_SCHEMA, DrawingReadingError, drawingFileKind, readingFromAi,
} from '../../../modules/drawing-readings/drawing-reading';
import { DRAWING_READING_MODEL, DrawingReadingsService } from '../../../modules/drawing-readings/drawing-readings.service';

import type { AiBudgetService } from '../../../common/ai/ai-budget.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7 ...');

/** A bracket as the model would report it. */
const bracket = (over: Record<string, unknown> = {}) => ({
  isDrawing: true, partName: ' Mounting bracket ', partNumber: 'TEST-100', revision: 'B', material: 'AL 6061-T6', units: 'mm', quantity: 2,
  process: { family: 'machining', reason: 'The title block says MACHINED FROM BILLET.' },
  shape: { kind: 'block', lengthMm: 120, widthMm: 60, heightMm: 12 },
  holes: [{ diameterMm: 6.6, depthMm: null, count: 4, thread: null }, { diameterMm: 5, depthMm: 10, count: 2, thread: 'M6x1' }],
  tightestToleranceMm: 0.1, surfaceFinishRaUm: 3.2, notes: ['ANODISE CLEAR'], unsure: [], ...over,
});

describe('the schema the model answers in', () => {
  it('is one structured outputs can take: every object closed, every property required, no numeric or length limits', () => {
    const banned = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];
    let objects = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object' || node === null) return;
      const schema = node as Record<string, unknown>;
      for (const key of banned) expect(schema).not.toHaveProperty(key);
      if (schema.type === 'object') {
        objects++;
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties as object));
      }
      Object.values(schema).forEach(walk);
    };
    walk(DRAWING_READING_SCHEMA);
    expect(objects).toBe(7);          // the reading, the process, three shapes, a turned segment, a hole
  });
});

describe('drawingFileKind', () => {
  it('knows a drawing file by its first bytes, whatever it is called', () => {
    expect(drawingFileKind(PNG)).toBe('png');
    expect(drawingFileKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(drawingFileKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(drawingFileKind(Buffer.from('GIF89a'))).toBe('gif');
    expect(drawingFileKind(PDF)).toBe('pdf');
    expect(drawingFileKind(Buffer.from('ISO-10303-21;'))).toBeNull();           // a STEP file goes to the CAD import, not here
    expect(drawingFileKind(Buffer.from(''))).toBeNull();
  });
});

describe('readingFromAi', () => {
  it('takes a reading as given, trimmed', () => {
    const reading = readingFromAi(bracket());
    expect(reading).toMatchObject({
      isDrawing: true, partName: 'Mounting bracket', partNumber: 'TEST-100', material: 'AL 6061-T6', units: 'mm', quantity: 2,
      process: { family: 'machining' }, shape: { kind: 'block', lengthMm: 120, widthMm: 60, heightMm: 12 },
      tightestToleranceMm: 0.1, surfaceFinishRaUm: 3.2, notes: ['ANODISE CLEAR'], unsure: [],
    });
    expect(reading.holes).toEqual([{ diameterMm: 6.6, depthMm: null, count: 4, thread: null }, { diameterMm: 5, depthMm: 10, count: 2, thread: 'M6x1' }]);
  });

  it('leaves out a size that cannot be a size, and says so, so no number nobody read reaches the part', () => {
    const reading = readingFromAi(bracket({ shape: { kind: 'block', lengthMm: 120, widthMm: -60, heightMm: 12 } }));
    expect(reading.shape).toBeNull();
    expect(reading.unsure).toEqual(['The overall size read from the drawing was not usable, so it is left out.']);
  });

  it('leaves out hole callouts that cannot be holes, and counts them', () => {
    const reading = readingFromAi(bracket({ holes: [{ diameterMm: 6, depthMm: null, count: 4, thread: null }, { diameterMm: 0, depthMm: null, count: 1, thread: null },
      { diameterMm: 5, depthMm: null, count: 2.5, thread: null }, 'four holes'] }));
    expect(reading.holes).toEqual([{ diameterMm: 6, depthMm: null, count: 4, thread: null }]);
    expect(reading.unsure).toEqual(['3 hole callouts were not usable, so they are left out.']);
  });

  it('reads a turned part as its diameter steps, and keeps a bore only when it fits inside the smallest of them', () => {
    const turned = (bore: number | null) => readingFromAi(bracket({ shape: { kind: 'turned', segments: [{ diameterMm: 40, lengthMm: 25 }, { diameterMm: 25, lengthMm: 60 }], boreDiameterMm: bore } })).shape;
    expect(turned(10)).toEqual({ kind: 'turned', segments: [{ diameterMm: 40, lengthMm: 25 }, { diameterMm: 25, lengthMm: 60 }], boreDiameterMm: 10 });
    expect(turned(30)).toMatchObject({ boreDiameterMm: null });
    expect(readingFromAi(bracket({ shape: { kind: 'turned', segments: [], boreDiameterMm: null } })).shape).toBeNull();
  });

  it('takes a sheet part, and a process only from the families the app costs', () => {
    expect(readingFromAi(bracket({ shape: { kind: 'sheet', lengthMm: 300, widthMm: 200, thicknessMm: 2 } })).shape).toEqual({ kind: 'sheet', lengthMm: 300, widthMm: 200, thicknessMm: 2 });
    expect(readingFromAi(bracket({ process: { family: 'wizardry', reason: 'x' } })).process).toBeNull();
    expect(readingFromAi(bracket({ process: null, quantity: 0, units: 'furlong' }))).toMatchObject({ process: null, quantity: null, units: null });
  });

  it('reads nothing off a file that is not a drawing', () => {
    expect(readingFromAi(bracket({ isDrawing: false, unsure: ['A photograph of a cat.'] }))).toEqual({
      isDrawing: false, partName: null, partNumber: null, revision: null, material: null, units: null, quantity: null, process: null, shape: null,
      holes: [], tightestToleranceMm: null, surfaceFinishRaUm: null, notes: [], unsure: ['A photograph of a cat.'],
    });
  });

  it('refuses an answer that is not a reading at all', () => {
    expect(() => readingFromAi('a bracket')).toThrow(DrawingReadingError);
    expect(() => readingFromAi({ partName: 'x' })).toThrow(DrawingReadingError);
  });
});

describe('DrawingReadingsService', () => {
  const caller = { userId: 'u', organizationId: 'o', accessToken: 't' };
  /** What the service sent the model: the first argument of its one call. */
  interface Sent { model: string; output_config: unknown; messages: { content: [unknown, { text: string }] }[] }
  const sent = (create: jest.Mock): [Sent, unknown] => create.mock.calls[0] as [Sent, unknown];
  function service(answer: { stop_reason?: string; text?: string }) {
    const create = jest.fn().mockResolvedValue({ stop_reason: answer.stop_reason ?? 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: answer.text ?? JSON.stringify(bracket()) }] });
    const close = jest.fn();
    const open = jest.fn().mockResolvedValue({ create, close });
    return { readings: new DrawingReadingsService({ open } as unknown as AiBudgetService), open, create, close };
  }

  it('sends the drawing to the strongest reader with the reading schema, and gives back the checked reading', async () => {
    const { readings, open, create, close } = service({});
    const result = await readings.read({ buffer: PNG, originalname: 'bracket.png' }, caller, '  500 a year  ');
    expect(result).toMatchObject({ fileName: 'bracket.png', model: 'claude-opus-5-5', reading: { partName: 'Mounting bracket' } });
    expect(open).toHaveBeenCalledWith(caller, 'drawing_extraction');
    const [params, options] = sent(create);
    expect(params.model).toBe(DRAWING_READING_MODEL);
    expect(params.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: DRAWING_READING_SCHEMA } });
    expect(params.messages[0]?.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    expect(params.messages[0]?.content[1].text).toBe('Read this drawing.\nThe person who uploaded it wrote: "500 a year"');
    expect(options).toEqual({ timeout: 180_000, maxRetries: 1 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sends a PDF as a document', async () => {
    const { readings, create } = service({});
    await readings.read({ buffer: PDF, originalname: 'shaft.pdf' }, caller);
    const [params] = sent(create);
    expect(params.messages[0]?.content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } });
    expect(params.messages[0]?.content[1].text).toBe('Read this drawing.');
  });

  it('refuses a file that is not a drawing file, or is too large, before any AI budget is spent', async () => {
    const { readings, open } = service({});
    await expect(readings.read({ buffer: Buffer.from('ISO-10303-21;'), originalname: 'part.step' }, caller)).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(readings.read({ buffer: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), originalname: 'big.png' }, caller)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal', { stop_reason: 'refusal' }],
    ['an answer cut off at the token limit', { stop_reason: 'max_tokens' }],
    ['an answer that is not JSON', { text: 'I could not read it.' }],
    ['JSON that is not a reading', { text: '{"partName":"x"}' }],
  ])('answers %s with a bad gateway, and frees the session', async (_name, answer) => {
    const { readings, close } = service(answer);
    await expect(readings.read({ buffer: PNG, originalname: 'x.png' }, caller)).rejects.toBeInstanceOf(BadGatewayException);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

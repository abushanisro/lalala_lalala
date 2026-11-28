import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

import { DrawingSolidsService, engineSolidRequest, solidFileName } from '../../../modules/drawing-readings/drawing-solids.service';

const mockPost = jest.fn();
jest.mock('../../../common/resilience/engine-http', () => ({ cadEngineHttp: { post: (...args: unknown[]): unknown => mockPost(...args) } }));
const post = mockPost;

const block = { kind: 'block', lengthMm: 120, widthMm: 60, heightMm: 12 };
const holes = [{ diameterMm: 6.6, depthMm: null, count: 4, thread: null }, { diameterMm: 6, depthMm: 10, count: 2, thread: 'M6x1' }];
const built = { step_base64: 'SVNP', volume_mm3: 84192.34, surface_area_mm2: 19818.55, bounding_box: { length: 120, width: 60, height: 12, diagonal: 134.7 }, holes_placed: 6, holes_left_out: 0 };

describe('engineSolidRequest', () => {
  it('gives the CAD engine each form in its own words, and holes without their thread callout', () => {
    expect(engineSolidRequest({ kind: 'block', lengthMm: 120, widthMm: 60, heightMm: 12 }, holes)).toEqual({
      shape: { kind: 'block', length_mm: 120, width_mm: 60, height_mm: 12 },
      holes: [{ diameter_mm: 6.6, depth_mm: null, count: 4 }, { diameter_mm: 6, depth_mm: 10, count: 2 }],
    });
    expect(engineSolidRequest({ kind: 'sheet', lengthMm: 300, widthMm: 200, thicknessMm: 2 }, []).shape).toEqual({ kind: 'sheet', length_mm: 300, width_mm: 200, thickness_mm: 2 });
    expect(engineSolidRequest({ kind: 'turned', segments: [{ diameterMm: 80, lengthMm: 15 }], boreDiameterMm: 20 }, []).shape)
      .toEqual({ kind: 'turned', segments: [{ diameter_mm: 80, length_mm: 15 }], bore_diameter_mm: 20 });
    expect(engineSolidRequest({ kind: 'shell', lengthMm: 250, widthMm: 120, heightMm: 90, wallMm: 2.5 }, []).shape)
      .toEqual({ kind: 'shell', length_mm: 250, width_mm: 120, height_mm: 90, wall_mm: 2.5 });
  });
});

describe('solidFileName', () => {
  it('names the file after the part and says where the model came from', () => {
    expect(solidFileName('TEST-BRKT-100')).toBe('TEST-BRKT-100 (from drawing).step');
    expect(solidFileName('Bracket/../../etc "x"')).toBe('Bracket .. .. etc x (from drawing).step');
    expect(solidFileName(undefined)).toBe('part (from drawing).step');
  });
});

describe('DrawingSolidsService', () => {
  const solids = new DrawingSolidsService();
  beforeEach(() => { post.mockReset(); });

  it('asks the CAD engine for the solid and hands back the STEP with what was built', async () => {
    post.mockResolvedValue({ data: built });
    await expect(solids.build({ shape: block, holes, name: 'TEST-BRKT-100' })).resolves.toEqual({
      fileName: 'TEST-BRKT-100 (from drawing).step', stepBase64: 'SVNP', volumeMm3: 84192.34, surfaceAreaMm2: 19818.55,
      boundingBox: { length: 120, width: 60, height: 12, diagonal: 134.7 }, holesPlaced: 6, holesLeftOut: 0,
    });
    const [url, body] = post.mock.calls[0] as [string, unknown];
    expect(url).toMatch(/\/build\/drawing-solid$/);
    expect(body).toEqual(engineSolidRequest({ kind: 'block', lengthMm: 120, widthMm: 60, heightMm: 12 }, holes));
  });

  it('refuses a form with a size missing, or holes that are not holes, before the engine is asked', async () => {
    await expect(solids.build({ shape: { kind: 'block', lengthMm: 120, widthMm: 60 }, holes: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(solids.build({ shape: null })).rejects.toBeInstanceOf(BadRequestException);
    await expect(solids.build({ shape: block, holes: [{ diameterMm: 0, count: 1 }] })).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('answers an engine that refuses the sizes with 422, and one that is down or busy with 503', async () => {
    post.mockRejectedValueOnce({ response: { status: 422, data: { detail: 'The bore is not smaller than the smallest diameter of the turned part.' } }, message: 'x' });
    await expect(solids.build({ shape: block })).rejects.toBeInstanceOf(UnprocessableEntityException);
    for (const failure of [{ message: 'ECONNREFUSED' }, { response: { status: 429, data: {} }, message: 'busy' }, { response: { status: 500, data: {} }, message: 'boom' }]) {
      post.mockRejectedValueOnce(failure);
      await expect(solids.build({ shape: block })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });
});

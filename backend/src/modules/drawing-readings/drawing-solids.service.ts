import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

import { holesFrom, shapeFrom, type DrawingHole, type DrawingShape } from './drawing-reading';
import { DEFAULT_CAD_ENGINE_URL } from '../../common/engine-urls';
import { cadEngineHttp } from '../../common/resilience/engine-http';

export interface DrawingSolid {
  fileName: string;
  /** The solid as a STEP file, to upload as the part's 3D model like any other. */
  stepBase64: string;
  volumeMm3: number;
  surfaceAreaMm2: number;
  boundingBox: { length: number; width: number; height: number; diagonal: number };
  holesPlaced: number;
  /** Holes the form has no room for: they are not in the model, so not in its cost. */
  holesLeftOut: number;
}

/** What the CAD engine's /build/drawing-solid takes (cad-engine/shared/drawing_solid.py). */
export function engineSolidRequest(shape: DrawingShape, holes: readonly DrawingHole[]) {
  const form = shape.kind === 'turned'
    ? { kind: 'turned', segments: shape.segments.map(s => ({ diameter_mm: s.diameterMm, length_mm: s.lengthMm })), bore_diameter_mm: shape.boreDiameterMm }
    : shape.kind === 'block'
      ? { kind: 'block', length_mm: shape.lengthMm, width_mm: shape.widthMm, height_mm: shape.heightMm }
      : shape.kind === 'shell'
        ? { kind: 'shell', length_mm: shape.lengthMm, width_mm: shape.widthMm, height_mm: shape.heightMm, wall_mm: shape.wallMm }
        : { kind: 'sheet', length_mm: shape.lengthMm, width_mm: shape.widthMm, thickness_mm: shape.thicknessMm };
  return { shape: form, holes: holes.map(h => ({ diameter_mm: h.diameterMm, depth_mm: h.depthMm, count: h.count })) };
}

/** What the CAD engine answers. */
interface EngineSolid {
  step_base64: string; volume_mm3: number; surface_area_mm2: number; holes_placed: number; holes_left_out: number;
  bounding_box: DrawingSolid['boundingBox'];
}

/** An environment setting, or its default when it is unset or empty. */
const fromEnv = (name: string, fallback: string): string => { const value = process.env[name]; return value === undefined || value === '' ? fallback : value; };

/** The HTTP status and the engine's own words of a failed engine call (no status: the engine did not answer). */
function engineFailure(error: unknown): { status: number | undefined; detail: string } {
  const failure = error as { message?: unknown; response?: { status?: unknown; data?: { detail?: unknown } } };
  const detail = failure.response?.data?.detail;
  return {
    status: typeof failure.response?.status === 'number' ? failure.response.status : undefined,
    detail: typeof detail === 'string' ? detail : typeof failure.message === 'string' ? failure.message : 'no answer',
  };
}

/** A file name the part's 3D model is stored under: it says where the model came from. */
export const solidFileName = (name: unknown): string =>
  `${(typeof name === 'string' ? name : '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'part'} (from drawing).step`;

/**
 * The simple solid of a part that has a drawing and no model: built by the CAD engine from the form and holes a drawing reading
 * gives. Nothing is saved here; the caller uploads the STEP as the part's 3D model, and analysis and costing take it from there.
 */
@Injectable()
export class DrawingSolidsService {
  private readonly logger = new Logger(DrawingSolidsService.name);
  private readonly cadEngineUrl = fromEnv('CAD_ENGINE_URL', DEFAULT_CAD_ENGINE_URL);
  private readonly cadEngineApiKey = fromEnv('CAD_ENGINE_API_KEY', '');

  async build(body: { shape?: unknown; holes?: unknown; name?: unknown }): Promise<DrawingSolid> {
    const shape = shapeFrom(body.shape);
    if (!shape) throw new BadRequestException({ code: 'no_shape', message: 'A solid needs the overall form of the part: a block, a sheet, a turned part or a shell, with every size given.' });
    const { holes, dropped } = holesFrom(body.holes);
    if (dropped > 0) throw new BadRequestException({ code: 'bad_holes', message: `${dropped} of the holes are not holes: each needs a diameter and a whole count.` });
    try {
      const { data } = await cadEngineHttp.post<EngineSolid>(`${this.cadEngineUrl}/build/drawing-solid`, engineSolidRequest(shape, holes), {
        headers: this.cadEngineApiKey ? { 'X-API-Key': this.cadEngineApiKey } : {},
        timeout: 60_000,
      });
      return {
        fileName: solidFileName(body.name), stepBase64: data.step_base64, volumeMm3: data.volume_mm3, surfaceAreaMm2: data.surface_area_mm2,
        boundingBox: data.bounding_box, holesPlaced: data.holes_placed, holesLeftOut: data.holes_left_out,
      };
    } catch (error) {
      const { status, detail } = engineFailure(error);
      if (!status || status === 404 || status === 429 || status >= 500) {
        this.logger.warn(`drawing solid not built: ${detail}`);
        throw new ServiceUnavailableException('The CAD engine did not answer, so the model was not built. Try again in a moment.');
      }
      throw new UnprocessableEntityException(`The model could not be built from these sizes: ${detail}`);
    }
  }
}

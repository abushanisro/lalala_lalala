import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

import { DEFAULT_CAD_ENGINE_URL } from '../../../common/engine-urls';
import { cadEngineHttp } from '../../../common/resilience/engine-http';
import { BOMItemsService } from '../bom-items.service';
import { requiredClampForce } from '../costing/plastic-molding/clamp-force';
import { PlasticReferenceService } from '../costing/plastic-molding/lookup/plastic-reference.service';
import { type RunFillSimulationDto } from '../dto/fill-simulation.dto';
import { FileStorageService } from './file-storage.service';
import { MaterialResolutionService } from './material-resolution.service';

const PULL_VECTOR = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;
// The engine keeps a run to about 10 s by capping the mesh; reading a large STEP file comes on top of that.
const ENGINE_TIMEOUT_MS = 240_000;
// The cost family whose materials and reference a molded part is priced with.
const MOLDED_FAMILY = 'plastic_molded';

/**
 * What the reference data recommends for a fill simulation of this part. Every value is the reference's own or null: a grade the
 * reference does not cover gets no numbers, and `notes` says what is missing.
 */
export interface FillSimulationInputs {
  /** The part's material as entered, and the reference record it was matched to. */
  materialGrade: string | null;
  referenceMaterial: string | null;
  meltTempC: number | null;
  moldTempC: number | null;
  /** The grade's maximum injection pressure, and its maximum flow length over wall thickness. */
  injectionPressureMaxMpa: number | null;
  flowLengthRatio: number | null;
  /** Pressure left at the cavity after the runner (the cost engine's clamp model), by runner system. */
  availablePressureMpa: { cold: number | null; hot: number | null };
  notes: string[];
}

/**
 * Injection fill simulation of a part's stored 3D model, run by the CAD engine (cad-engine/injection_molding/FILL_SIMULATION.md).
 * Nothing is stored: the inputs are the engineer's (the gate, and the process values the reference data recommends or their own) and
 * the answer is returned as the engine gives it.
 */
@Injectable()
export class FillSimulationService {
  private readonly logger = new Logger(FillSimulationService.name);
  private readonly cadEngineUrl = process.env.CAD_ENGINE_URL || DEFAULT_CAD_ENGINE_URL;
  private readonly cadEngineApiKey = process.env.CAD_ENGINE_API_KEY || '';

  constructor(
    private readonly bomItemsService: BOMItemsService,
    private readonly fileStorageService: FileStorageService,
    private readonly materials: MaterialResolutionService,
    private readonly plasticReference: PlasticReferenceService,
  ) {}

  /** The inputs the reference data gives for this part's grade: read from the same material record and clamp model the cost engine uses. */
  async recommendedInputs(id: string, userId: string, token: string): Promise<FillSimulationInputs> {
    const item = await this.bomItemsService.findOne(id, userId, token);
    const grade = item.materialGrade?.trim() || item.material?.trim() || null;
    const material = await this.materials.resolveMoldingReference(token, grade, MOLDED_FAMILY);
    const { reference } = await this.plasticReference.getReference();
    // The pressure left after the runner is a step of the cost engine's clamp calculation: it is read from that calculation itself (run on a
    // unit area), so there is one implementation of it and the engine's code is not touched.
    const available = (runner: 'cold' | 'hot') => {
      if (!reference) return null;
      const clamp = requiredClampForce({
        model: reference.clampModel, materialLabel: material.materialName ?? '', projectedAreaMm2: 1, cavityCount: 1, runner,
        material: { injectionPressureMaxMpa: material.injectionPressureMaxMpa, flowLengthRatio: material.flowLengthRatio, referenceMaterial: null },
      });
      return clamp.derivable ? clamp.adjustedInjectionPressureMpa : null;
    };
    const notes: string[] = [];
    if (!grade) notes.push('This part has no material: set one to get the recommended values.');
    else if (!material.materialName) notes.push(`"${grade}" matches no material record, so nothing can be recommended for it.`);
    else {
      const absent = [
        material.meltingTempC == null && 'melt temperature',
        material.injectionPressureMaxMpa == null && 'maximum injection pressure',
        material.flowLengthRatio == null && 'flow length ratio',
      ].filter((x): x is string => typeof x === 'string');
      if (absent.length > 0) notes.push(`The record of ${material.materialName} has no ${absent.join(', ')}.`);
      if (material.injectionPressureMaxMpa != null && !reference) notes.push('The plastic reference data is not loaded, so the pressure after the runner is not known.');
    }
    return {
      materialGrade: grade,
      referenceMaterial: material.materialName,
      meltTempC: material.meltingTempC,
      moldTempC: material.moldTempC,
      injectionPressureMaxMpa: material.injectionPressureMaxMpa,
      flowLengthRatio: material.flowLengthRatio,
      availablePressureMpa: { cold: available('cold'), hot: available('hot') },
      notes,
    };
  }

  async run(id: string, userId: string, token: string, input: RunFillSimulationDto): Promise<unknown> {
    const item = await this.bomItemsService.findOne(id, userId, token); // read as the user: the file store itself checks nothing
    const path = item.fileStepPath ?? item.file3dPath;
    if (!path) throw new BadRequestException('This part has no 3D model. Upload a STEP file first.');

    let bytes: Buffer | null;
    try {
      bytes = await this.fileStorageService.download(path);
    } catch (err: unknown) {
      this.logger.error(`could not read ${path} from storage: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException("The file storage could not be reached to read this part's 3D model. Try again in a moment.");
    }
    if (bytes === null) throw new NotFoundException("This part's 3D model is not in file storage. Upload the file again on the part.");

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', bytes, { filename: path.split('/').pop() ?? 'model.step', contentType: 'application/octet-stream' });
    form.append('params', JSON.stringify(engineParams(input)));
    try {
      const response = await cadEngineHttp.post(`${this.cadEngineUrl}/simulate/fill`, form, {
        headers: { ...form.getHeaders(), ...(this.cadEngineApiKey && { 'X-API-Key': this.cadEngineApiKey }) },
        timeout: ENGINE_TIMEOUT_MS,
        maxContentLength: 150 * 1024 * 1024,
      });
      return response.data;
    } catch (e) {
      const status = e.response?.status as number | undefined;
      const detail = typeof e.response?.data?.detail === 'string' ? (e.response.data.detail as string) : (e.message as string);
      // No answer, busy, or switched off on this server (the engine says 404 for that): not something the inputs can fix.
      if (!status || status === 404 || status === 429 || status >= 500) {
        this.logger.warn(`fill simulation not run for item ${id}: ${detail}`);
        throw new ServiceUnavailableException(status === 404 || status === 429 ? detail : `The CAD engine did not answer, so the fill simulation was not run (${detail}).`);
      }
      throw new UnprocessableEntityException(`The fill simulation could not be run: ${detail}`);
    }
  }
}

/** The request in the engine's own names (FillRequest in cad-engine/injection_molding/fill_simulation.py). */
export function engineParams(input: RunFillSimulationDto): Record<string, unknown> {
  const r = input.rheology;
  return {
    ...(input.gateMm && { gate_mm: input.gateMm }),
    ...(input.gateRadiusMm !== undefined && { gate_radius_mm: input.gateRadiusMm }),
    ...(input.fillTimeS !== undefined && { fill_time_s: input.fillTimeS }),
    ...(input.meltTempC !== undefined && { melt_temp_c: input.meltTempC }),
    ...(r && { rheology: { n: r.n, tau_pa: r.tauPa, d1_pa_s: r.d1PaS, d2_k: r.d2K, a1: r.a1, a2_k: r.a2K } }),
    ...(input.flowLengthRatio !== undefined && { flow_length_ratio: input.flowLengthRatio }),
    ...(input.pullAxis && { pull: PULL_VECTOR[input.pullAxis] }),
    ...(input.maxInjectionPressureMpa !== undefined && { max_injection_pressure_mpa: input.maxInjectionPressureMpa }),
  };
}

// The fill simulation relay: which file goes to the CAD engine, the request in the engine's names, and what each failure tells the user.
import { BadRequestException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

import { cadEngineHttp } from '../../../common/resilience/engine-http';
import { type RunFillSimulationDto } from '../../../modules/bom-items/dto/fill-simulation.dto';
import { engineParams, FillSimulationService } from '../../../modules/bom-items/services/fill-simulation.service';

const RHEOLOGY = { n: 0.3, tauPa: 25000, d1PaS: 1e12, d2K: 263.15, a1: 25, a2K: 51.6 };
const RUN: RunFillSimulationDto = { gateMm: [1, 2, 3], fillTimeS: 1.2, meltTempC: 230, rheology: RHEOLOGY, pullAxis: 'z', maxInjectionPressureMpa: 120 };

const CLAMP_MODEL = {
  clampForceSafetyFactor: 1.1, easyFlowRatio: 200, mediumFlowRatio: 100, percentClampForce: { easy: 12, medium: 34, hard: 59 },
  runnerPressureReduction: { cold: 0.15, hot: 0.3 }, minInjectionPressureMpa: 27.58,
};
const ABS = { materialName: 'ABS', meltingTempC: 240, moldTempC: 70, injectionPressureMaxMpa: 150, flowLengthRatio: 175 };

function service(item: Record<string, unknown>, stored: Buffer | null | Error = Buffer.from('ISO-10303-21;'), material: Record<string, unknown> = ABS, reference: unknown = { clampModel: CLAMP_MODEL }) {
  const findOne = jest.fn().mockResolvedValue(item);
  const download = jest.fn().mockImplementation(() => (stored instanceof Error ? Promise.reject(stored) : Promise.resolve(stored)));
  const resolveMoldingReference = jest.fn().mockResolvedValue(material);
  const getReference = jest.fn().mockResolvedValue({ reference, missing: [] });
  const svc = new FillSimulationService({ findOne } as never, { download } as never, { resolveMoldingReference } as never, { getReference } as never);
  return { svc, findOne, download, resolveMoldingReference };
}

const engineError = (status: number | undefined, detail: unknown) => Object.assign(new Error('Request failed'), status ? { response: { status, data: { detail } } } : {});

describe('FillSimulationService', () => {
  const post = jest.spyOn(cadEngineHttp, 'post');
  afterEach(() => post.mockReset());

  it('sends the STEP file (not the viewer STL) with the request in the engine names, read as the user', async () => {
    post.mockResolvedValue({ data: { version: 'fill_sim_v1' } });
    const { svc, findOne, download } = service({ fileStepPath: 'org/part.step', file3dPath: 'org/part.stl' });
    await expect(svc.run('item-1', 'user-1', 'token-1', RUN)).resolves.toEqual({ version: 'fill_sim_v1' });
    expect(findOne).toHaveBeenCalledWith('item-1', 'user-1', 'token-1');
    expect(download).toHaveBeenCalledWith('org/part.step');
    const [url, form] = post.mock.calls[0] as [string, { getBuffer(): Buffer }];
    expect(url).toMatch(/\/simulate\/fill$/);
    const body = form.getBuffer().toString();
    expect(body).toContain('filename="part.step"');
    expect(body).toContain(JSON.stringify(engineParams(RUN)));
  });

  it('names the engine fields, turns the pull axis into a vector and leaves out what was not given', () => {
    expect(engineParams(RUN)).toEqual({
      gate_mm: [1, 2, 3], fill_time_s: 1.2, melt_temp_c: 230, pull: [0, 0, 1], max_injection_pressure_mpa: 120,
      rheology: { n: 0.3, tau_pa: 25000, d1_pa_s: 1e12, d2_k: 263.15, a1: 25, a2_k: 51.6 },
    });
    expect(engineParams({})).toEqual({}); // no gate: the engine answers with the mesh alone
    expect(engineParams({ gateRadiusMm: 0 })).toEqual({ gate_radius_mm: 0 });
    // no Cross-WLF constants: the grade's flow length ratio and the pressure available give the engine an estimate to work from
    expect(engineParams({ gateMm: [0, 0, 0], fillTimeS: 1, flowLengthRatio: 175, maxInjectionPressureMpa: 127.5 })).toEqual({
      gate_mm: [0, 0, 0], fill_time_s: 1, flow_length_ratio: 175, max_injection_pressure_mpa: 127.5,
    });
  });

  it("recommends the grade's reference values and the pressure left after each runner system, read as the user", async () => {
    const { svc, findOne, resolveMoldingReference } = service({ materialGrade: ' ABS ', material: 'Plastic' });
    await expect(svc.recommendedInputs('item-1', 'user-1', 'token-1')).resolves.toEqual({
      materialGrade: 'ABS', referenceMaterial: 'ABS', meltTempC: 240, moldTempC: 70, injectionPressureMaxMpa: 150, flowLengthRatio: 175,
      availablePressureMpa: { cold: 127.5, hot: 105 }, // 150 MPa less 15 % (cold runner) or 30 % (hot runner): the cost engine's clamp model
      notes: [],
    });
    expect(findOne).toHaveBeenCalledWith('item-1', 'user-1', 'token-1');
    expect(resolveMoldingReference).toHaveBeenCalledWith('token-1', 'ABS', 'plastic_molded');
  });

  it('never fills a gap with a number: it says what is missing and why', async () => {
    const none = { materialName: null, meltingTempC: null, moldTempC: null, injectionPressureMaxMpa: null, flowLengthRatio: null };
    const noMaterial = await service({}, undefined, none).svc.recommendedInputs('i', 'u', 't');
    expect(noMaterial).toMatchObject({ materialGrade: null, meltTempC: null, availablePressureMpa: { cold: null, hot: null } });
    expect(noMaterial.notes).toEqual(['This part has no material: set one to get the recommended values.']);
    const unknown = await service({ materialGrade: 'Unobtainium' }, undefined, none).svc.recommendedInputs('i', 'u', 't');
    expect(unknown.notes).toEqual(['"Unobtainium" matches no material record, so nothing can be recommended for it.']);
    const partial = await service({ materialGrade: 'PEEK' }, undefined, { ...none, materialName: 'PEEK', meltingTempC: 380 }).svc.recommendedInputs('i', 'u', 't');
    expect(partial).toMatchObject({ meltTempC: 380, flowLengthRatio: null, availablePressureMpa: { cold: null, hot: null } });
    // a pressure without a flow length ratio: the clamp model derives nothing from half its inputs, and neither does this
    const half = await service({ materialGrade: 'PMMA' }, undefined, { ...ABS, materialName: 'PMMA', flowLengthRatio: null }).svc.recommendedInputs('i', 'u', 't');
    expect(half).toMatchObject({ injectionPressureMaxMpa: 150, availablePressureMpa: { cold: null, hot: null } });
    expect(half.notes).toEqual(['The record of PMMA has no flow length ratio.']);
    expect(partial.notes).toEqual(['The record of PEEK has no maximum injection pressure, flow length ratio.']);
    const noReference = await service({ materialGrade: 'ABS' }, undefined, ABS, null).svc.recommendedInputs('i', 'u', 't');
    expect(noReference.availablePressureMpa).toEqual({ cold: null, hot: null });
    expect(noReference.notes).toEqual(['The plastic reference data is not loaded, so the pressure after the runner is not known.']);
    // the floor of the clamp model: a grade rated below it still has the model's minimum pressure
    const soft = await service({ materialGrade: 'TPE' }, undefined, { ...ABS, materialName: 'TPE', injectionPressureMaxMpa: 20 }).svc.recommendedInputs('i', 'u', 't');
    expect(soft.availablePressureMpa).toEqual({ cold: 27.58, hot: 27.58 });
  });

  it('says what the user can do when the part has no model or its file is gone, and reports a storage outage as one', async () => {
    await expect(service({}).svc.run('i', 'u', 't', {})).rejects.toThrow(BadRequestException);
    await expect(service({ file3dPath: 'a.step' }, null).svc.run('i', 'u', 't', {})).rejects.toThrow(NotFoundException);
    await expect(service({ file3dPath: 'a.step' }, new Error('bucket down')).svc.run('i', 'u', 't', {})).rejects.toThrow(ServiceUnavailableException);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [422, 'fill_time_s: Input should be greater than 0', UnprocessableEntityException, /could not be run: fill_time_s/],
    [400, 'Unsupported file type .stl', UnprocessableEntityException, /Unsupported file type/],
    [404, 'Fill simulation is switched off on this server', ServiceUnavailableException, /^Fill simulation is switched off on this server$/],
    [429, 'CAD engine busy, retry shortly', ServiceUnavailableException, /^CAD engine busy, retry shortly$/],
    [500, 'Fill simulation failed (error abc).', ServiceUnavailableException, /did not answer/],
    [undefined, undefined, ServiceUnavailableException, /did not answer/],
  ])('an engine answer of %s becomes the right error for the user', async (status, detail, kind, message) => {
    post.mockRejectedValue(engineError(status, detail));
    const run = service({ fileStepPath: 'a.step' }).svc.run('i', 'u', 't', RUN);
    await expect(run).rejects.toThrow(kind);
    await expect(run).rejects.toThrow(message);
  });
});

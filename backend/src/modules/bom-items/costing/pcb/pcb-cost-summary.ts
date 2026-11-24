// Cost Summary of a printed circuit board, from its route (pcb-route.ts) in the location's currency. Pure. A board that could not be priced is
// one named, uncosted line saying why; never priced as another process.
import type { CostSummaryDto, PcbBreakdown, ProcessLineCost } from '../../dto/cost-breakdown.dto';
import { runView } from '../casting/casting-calculator-seeds';
import { computeSustainability } from '../shared/core/cost-engine';
import type { PcbCostResult } from './pcb-cost.service';
import { PCB_FINISH_LABEL, type PcbFact } from './pcb-part';
import { PCB_HELPER, PCB_PROCESS_GROUP } from './pcb-route';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The sentence a summary that could not be costed starts its warning with (the route comparison reads it). */
export const PCB_NOT_COSTED = `${PCB_PROCESS_GROUP} cannot be costed`;

function uncosted(reason: string): ProcessLineCost {
  return {
    process: PCB_PROCESS_GROUP, processGroup: PCB_PROCESS_GROUP, processRoute: PCB_PROCESS_GROUP, operation: PCB_PROCESS_GROUP,
    setupCost: 0, runCost: 0, totalCost: 0, cycleTimeMin: 0, hourlyRate: 0, rateSource: 'no_db_rate',
    machineClass: 'pcb', machineName: null, commodityCode: null, labourRate: null,
    physicsGap: { gapType: 'unsupported_operation', process: PCB_PROCESS_GROUP, machineClass: 'pcb', reason },
  };
}

const fact = <T>(f: PcbFact<T>) => ({ value: f.value, basis: f.basis, source: f.source });

export function buildPcbCostSummary(input: { pcb: PcbCostResult; batchSize: number; warnings: string[]; ratesSource: string }): CostSummaryDto {
  const { route, part, stackup, nest } = input.pcb;
  const why = input.pcb.missing.join('; ') || 'no route could be built';
  const warnings = [...(input.pcb.note ? [input.pcb.note] : []), ...input.warnings, ...input.pcb.warnings];
  if (!route) warnings.push(`${PCB_NOT_COSTED}: ${why}`);
  const processLines = route ? route.lines : [uncosted(`${PCB_NOT_COSTED}: ${why}`)];
  if (route && !route.complete) warnings.push('The PCB route is incomplete: a step no machine can do is shown as a named gap, and the total excludes it.');
  // The laminate is the route's Material Stock line (written by Apply with the other lines): no separate material record, none counted twice.
  const materialCost = 0;
  const totalProcessCost = processLines.reduce((s, l) => s + l.totalCost, 0);
  const run = route?.material.run;
  const breakdown: PcbBreakdown | null = part ? {
    route: route?.key ?? null, routeLabel: route?.label ?? null,
    board: {
      lengthMm: fact(part.lengthMm), widthMm: fact(part.widthMm), areaMm2: fact(part.areaMm2), thicknessMm: fact(part.thicknessMm), layers: fact(part.layers),
      outerCopperOz: fact(part.outerCopperOz), innerCopperOz: part.innerCopperOz ? fact(part.innerCopperOz) : null, finish: fact(part.finish),
      soldermaskSides: fact(part.soldermaskSides), silkscreenSides: fact(part.silkscreenSides), testPoints: part.testPoints ? fact(part.testPoints) : null,
      holes: part.holes.value.map((h) => ({ diameterMm: h.diameterMm, plated: h.plated, count: h.count })), holesSource: part.holes.source,
    },
    finishLabel: PCB_FINISH_LABEL[part.finish.value],
    stackup: stackup ? {
      sequence: stackup.sequence, cores: stackup.doubleCores + stackup.singleCores, foils: stackup.foils, innerCores: stackup.innerCores,
      prepregSpaces: stackup.prepregSpaces, coreDielectricMm: stackup.coreDielectricMm, laminated: stackup.laminated,
    } : null,
    nest: nest ? { boardsPerPanel: nest.boardsPerPanel, arraysPerPanel: nest.arraysPerPanel, boardsPerArray: nest.boardsPerArray, panelMm: [r2(nest.panel.lengthMm), r2(nest.panel.widthMm)], utilization: r3(nest.utilization), note: nest.note } : null,
    materials: route?.material.uses.map((u) => ({ name: u.name, count: u.count, usdPerM2: u.usdPerM2, detail: u.detail })) ?? [],
    finishOptions: input.pcb.finishOptions.map((f) => ({ finish: f.finish, label: f.label, totalCost: f.totalUsd, reason: f.reason })),
    complete: route?.complete ?? false,
    options: [
      ...input.pcb.routes.map((r) => ({
        route: r.key, label: r.label, complete: r.complete, totalCost: r.totalUsd,
        reason: r.complete ? null : r.lines.filter((l) => l.physicsGap).map((l) => `${l.process}: ${(l.physicsGap as { reason?: string }).reason ?? 'not costed'}`).join('; ') || 'the material',
      })),
      ...input.pcb.gaps.map((g) => ({ route: g.key, label: g.label, complete: false, totalCost: null, reason: g.reason })),
    ],
  } : null;
  return {
    materialCost: r2(materialCost),
    materialGrade: 'PCB laminate (stack-up)',
    grossWeightKg: 0,
    materialCostPerKg: 0,
    materialSource: 'db',
    processLines,
    totalProcessCost: r2(totalProcessCost),
    totalCost: r2(materialCost + totalProcessCost),
    cycleTimes: { laserMin: 0, pressBrakeMin: 0, tappingMin: 0, deburrMin: 0, totalMin: r3(processLines.reduce((s, l) => s + l.cycleTimeMin, 0)) },
    batchSize: input.batchSize,
    family: 'pcb',
    sustainability: computeSustainability(null, 0, 0, 0, input.batchSize, processLines),
    warnings: warnings.filter(Boolean),
    ratesSource: input.ratesSource,
    ...(route && run ? { calculatorRuns: { 'PCB board material': runView(PCB_HELPER.material, 'Material Cost', run) } } : {}),
    // The stamping die, the bed-of-nails fixture or the flying-probe program (USD): listed in the Cost Guide's tooling and written on Apply, not in the piece cost.
    ...(route && route.tooling.length ? { pcbTooling: route.tooling } : {}),
    ...(breakdown ? { pcb: breakdown } : {}),
  };
}

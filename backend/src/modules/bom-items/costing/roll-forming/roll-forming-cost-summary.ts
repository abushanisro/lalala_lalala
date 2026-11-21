// Cost Summary of a roll formed part, from its route (roll-forming-route.ts) in the location's currency. Pure. A part that could not be priced
// is one named, uncosted line saying why; never priced as plain sheet metal in its place.
import { RF_CALC, ROLL_FORMING_PROCESS_GROUP } from './roll-forming-route';
import { runView } from '../casting/casting-calculator-seeds';
import { computeSustainability } from '../shared/core/cost-engine';

import type { RollFormingCostResult } from './roll-forming-cost.service';
import type { CostSummaryDto, ProcessLineCost } from '../../dto/cost-breakdown.dto';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The sentence a summary that could not be costed starts its warning with (the route comparison reads it). */
export const ROLL_FORMING_NOT_COSTED = `${ROLL_FORMING_PROCESS_GROUP} cannot be costed`;

function uncosted(reason: string): ProcessLineCost {
  return {
    process: 'Roll Forming Mill', processGroup: ROLL_FORMING_PROCESS_GROUP, processRoute: 'Roll Forming Mill', operation: 'Roll Forming Mill',
    setupCost: 0, runCost: 0, totalCost: 0, cycleTimeMin: 0, hourlyRate: 0, rateSource: 'no_db_rate',
    machineClass: 'sheet_roll_forming_roll_forming_mill', machineName: null, commodityCode: null, labourRate: null,
    physicsGap: { gapType: 'unsupported_operation', process: 'Roll Forming Mill', machineClass: 'sheet_roll_forming_roll_forming_mill', reason },
  };
}

export function buildRollFormingCostSummary(input: {
  rollForming: RollFormingCostResult;
  materialGrade: string | null;
  materialCostPerKg: number;
  materialSource: 'db' | 'default';
  batchSize: number;
  warnings: string[];
  ratesSource: string;
}): CostSummaryDto {
  const { route, part, rule } = input.rollForming;
  const why = input.rollForming.missing.join('; ') || 'no route could be built';
  const warnings = [...(input.rollForming.note ? [input.rollForming.note] : []), ...input.warnings, ...input.rollForming.warnings];
  if (!route) warnings.push(`${ROLL_FORMING_NOT_COSTED}: ${why}`);
  const processLines = route ? route.lines : [uncosted(`${ROLL_FORMING_NOT_COSTED}: ${why}`)];
  if (route && !route.feasible) warnings.push(`${ROLL_FORMING_PROCESS_GROUP} is not feasible for this part: ${route.infeasible.join('; ')}. Its lines are No Cost Feature lines saying why.`);
  else if (route && !route.complete) warnings.push(`The ${ROLL_FORMING_PROCESS_GROUP} route is incomplete: a step no machine can do is shown as a named gap, and the total excludes it.`);
  const materialCost = route?.material.costUsd ?? 0;
  const totalProcessCost = processLines.reduce((s, l) => s + l.totalCost, 0);
  const grossKg = route?.material.stripKg ?? 0;
  const partKg = route?.material.partKg ?? 0;
  const perKg = grossKg > 0 ? materialCost / grossKg : input.materialCostPerKg;
  const calculatorRuns: Record<string, ReturnType<typeof runView>> = {};
  if (route?.material.run) calculatorRuns['Roll forming material'] = runView(RF_CALC.material, 'Material Cost', route.material.run);
  if (route?.material.stripRun) calculatorRuns['Roll forming strip'] = runView(RF_CALC.strip, 'Strip Mass', route.material.stripRun);
  if (route?.stations.run) calculatorRuns['Roll forming stations'] = runView(RF_CALC.stations, 'Roll Stations', route.stations.run);
  if (route?.lineSpeed) calculatorRuns['Roll forming line speed'] = runView(RF_CALC.lineSpeed, 'Line Speed', route.lineSpeed.run);
  if (route?.coil) calculatorRuns['Roll forming coil change'] = runView(RF_CALC.coilChange, 'Coil Change per Part', route.coil.run);
  return {
    materialCost: r2(materialCost),
    materialGrade: input.rollForming.material?.name ?? input.materialGrade ?? 'Unknown',
    grossWeightKg: r3(grossKg),
    materialCostPerKg: perKg,
    // The route priced the material from the roll forming material's own raw_materials row.
    materialSource: route ? 'db' : input.materialSource,
    processLines,
    totalProcessCost: r2(totalProcessCost),
    totalCost: r2(materialCost + totalProcessCost),
    cycleTimes: { laserMin: 0, pressBrakeMin: 0, tappingMin: 0, deburrMin: 0, totalMin: r3(processLines.reduce((s, l) => s + l.cycleTimeMin, 0)) },
    batchSize: input.batchSize,
    family: 'sheet_metal',
    sustainability: computeSustainability(input.materialGrade, perKg, partKg, grossKg, input.batchSize, processLines),
    warnings: warnings.filter(Boolean),
    ratesSource: input.ratesSource,
    ...(Object.keys(calculatorRuns).length ? { calculatorRuns } : {}),
    // The strip a part uses off the coil: what Apply's material record holds (gross: the strip with its slug; net: the part, its punched holes out).
    ...(route && part ? {
      blankSpec: {
        form: 'sheet' as const,
        sizeLabel: `${r2(part.stripWidthMm)} mm x ${r2(route.material.feedLengthMm)} mm strip, ${r2(part.thicknessMm)} mm coil`,
        grossWeightKg: r3(grossKg), netWeightKg: r3(partKg), utilizationPct: grossKg > 0 ? r2((100 * partKg) / grossKg) : 0,
        wasteKg: r3(route.material.scrapKg), wasteCost: r2(route.material.scrapKg * perKg),
        sheetSource: `coil strip ${r2(part.stripWidthMm)} mm wide (the section's stretch-out)${route.material.slugMm > 0 ? `, ${r2(route.material.slugMm)} mm slug a part (slugDieCutOffLength)` : ''}`,
      },
    } : {}),
    // The mill's rolls and the press dies (USD): listed in the Cost Guide's tooling and written on Apply, not in the piece cost.
    ...(route?.tooling.length ? {
      rollFormingTooling: route.tooling.map((t) => ({
        key: t.key, description: t.description, detail: t.detail, costUsd: t.investmentUsd, toolCostUsd: t.costUsd, perPartUsd: t.perPartUsd, amortizationParts: t.amortizationParts,
      })),
    } : {}),
    ...(route && part && rule ? {
      rollForming: {
        route: route.key, routeLabel: route.label,
        rule: { route: rule.route, closed: rule.closed, basis: rule.basis },
        section: {
          heightMm: r2(part.section.heightMm), widthMm: r2(part.section.widthMm), closed: part.section.closed, bends: part.bends.length,
          curveRadiusMm: part.curve ? r2(part.curve.radiusMm) : null,
        },
        strip: {
          widthMm: r2(part.stripWidthMm), thicknessMm: r2(part.thicknessMm), lengthMm: r2(part.lengthMm), feedLengthMm: r2(route.material.feedLengthMm),
          slugMm: r2(route.material.slugMm), massKg: r3(route.material.stripKg), partMassKg: r3(route.material.partKg),
        },
        stations: {
          forming: route.stations.forming, leadIn: route.stations.leadIn, finishing: route.stations.finishing, rule: route.stations.rule,
          total: route.stations.total, override: route.stations.override, panel: route.stations.panel, levelSource: route.stations.levelSource,
          levels: route.stations.levels.map((l) => ({ level: l.level, bends: l.bends, maxAngleDeg: r2(l.maxAngleDeg), passes: l.passes })),
        },
        mill: route.mill ? { ...route.mill, requiredShaftMm: route.requiredShaftMm } : null,
        lineSpeed: route.lineSpeed ? {
          mmPerS: r2(route.lineSpeed.mmPerS), limiting: route.lineSpeed.limiting, multiplier: route.lineSpeed.multiplier,
          caps: route.lineSpeed.caps.map((c) => ({ name: c.name, mmPerS: r2(c.mmPerS) })),
        } : null,
        coil: route.coil ? {
          massKg: r2(route.coil.massKg), partsPerCoil: route.coil.partsPerCoil, changeTimeS: r2(route.coil.changeTimeS), perPartS: r3(route.coil.perPartS), method: route.coil.method,
        } : null,
        dieSharpeningPerPartS: r3(route.dieSharpeningPerPartS),
        flattener: route.flattener,
        punching: route.punching,
        welding: route.welding,
        forcesKn: { punch: route.forcesKn.punch != null ? r2(route.forcesKn.punch) : null, cutOff: route.forcesKn.cutOff != null ? r2(route.forcesKn.cutOff) : null },
        feasible: route.feasible,
        complete: route.complete,
        options: input.rollForming.routes.map((r) => ({
          route: r.key, label: r.label, complete: r.complete, totalCost: r.totalUsd,
          reason: r.complete ? null : !r.feasible ? r.infeasible.join('; ')
            : r.lines.filter((l) => l.physicsGap).map((l) => `${l.process}: ${(l.physicsGap as { reason?: string }).reason ?? 'not costed'}`).join('; ') || null,
        })),
      },
    } : {}),
  };
}

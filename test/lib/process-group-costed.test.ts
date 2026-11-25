import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MACHINED_FAMILY_HINT, familyToProcessGroupLabel, isCostedProcessGroup, processGroupOptionLabel, processGroupToFamilyHint, routingFamilyOf } from '@/lib/features/process-group';

// A Process with no cost model is not costed (the backend's familiesOfProcessGroup), so the Process fields mark it instead of offering it blind:
// a part whose Process had none was priced as whatever it was last analysed as.
describe('process groups with a cost model', () => {
  it.each(['Sheet Metal', 'Machining', 'Plastic Molding', 'Die Casting', 'Sand Casting', 'Casting Investment', 'Sheet Metal - Hydroforming', 'Sheet Metal Roll Forming', 'Casting', 'Forging', 'Powder Metal', 'Additive Manufacturing', 'Bar and Tube Fabrication', 'Assembly', 'Assembly Molding', 'Part Assembly', 'PCB', 'Rapid Prototyping', 'Roto & Blow Molding'])('%s is costed', (group) => {
    expect(isCostedProcessGroup(group)).toBe(true);
    expect(processGroupOptionLabel(group)).toBe(group);
  });

  it.each(['Sheet Plastic'])('%s is not, and its option says so', (group) => {
    expect(isCostedProcessGroup(group)).toBe(false);
    expect(processGroupOptionLabel(group)).toBe(`${group} (not costed yet)`);
  });

  it('no process chosen is not a costed one', () => {
    expect(isCostedProcessGroup(null)).toBe(false);
    expect(isCostedProcessGroup('')).toBe(false);
  });

  it('a Casting part is analysed as a die casting, a hydroformed one as sheet metal; a process with no cost model as nothing', () => {
    expect(processGroupToFamilyHint('Casting')).toBe('die_cast');
    expect(processGroupToFamilyHint('Sheet Metal - Hydroforming')).toBe('sheet_metal');
    expect(processGroupToFamilyHint('Sheet Metal Roll Forming')).toBe('sheet_metal');
    expect(processGroupToFamilyHint('Sand Casting')).toBe('sand_cast');
    expect(processGroupToFamilyHint('Forging')).toBe('forged');
    expect(processGroupToFamilyHint('Powder Metal')).toBe('powder_metal');
    expect(processGroupToFamilyHint('Composites')).toBe('composite');
    expect(processGroupToFamilyHint('Additive Manufacturing')).toBe('additive');
    expect(processGroupToFamilyHint('Bar and Tube Fabrication')).toBe('bar_tube');
    // Rapid Prototyping is analysed for its build as an additive part.
    expect(processGroupToFamilyHint('Rapid Prototyping')).toBe('additive');
    // A blow or roto molded part is measured as a hollow shell.
    expect(processGroupToFamilyHint('Roto & Blow Molding')).toBe('roto_blow');
    expect(processGroupToFamilyHint('Sheet Plastic')).toBeUndefined();
    // An assembly and a weldment are costed from their children and the Cost Guide: there is no CAD extractor to force for them.
    expect(processGroupToFamilyHint('Assembly')).toBeUndefined();
    expect(processGroupToFamilyHint('Part Assembly')).toBeUndefined();
    // A PCB's 3D model is measured as a board (cad-engine pcb/feature_extractor.py) when it has no board files.
    expect(processGroupToFamilyHint('PCB')).toBe('pcb');
    // Insert molding is analysed as the molded plastic part it is.
    expect(processGroupToFamilyHint('Assembly Molding')).toBe('plastic_molded');
  });

  // Lead Screw side shaft: uploaded with Process Machining it was analysed with the hint "milled" (the group's first family) and forced
  // to a milled part, while the backend's Refresh analysis knows the geometry picks the machining family.
  it('a Machining part is analysed as a machined part, the geometry picking the family; a process of one family still names it', () => {
    expect(processGroupToFamilyHint('Machining')).toBe('machined');
    // Stock Machining is costed as the three machining families: its upload is analysed the same way, never forced to milled.
    expect(processGroupToFamilyHint('Stock Machining')).toBe('machined');
    expect(isCostedProcessGroup('Stock Machining')).toBe(true);
    expect(processGroupOptionLabel('Stock Machining')).toBe('Stock Machining');
    expect(processGroupToFamilyHint('2-Model Machining')).toBe('two_model');
    expect(processGroupToFamilyHint('Multi-Spindle Machining')).toBe('turned');
    expect(processGroupToFamilyHint('Sheet Metal')).toBe('sheet_metal');
    // The hint is no family: nothing is classified as it, and it has no process group of its own.
    expect(familyToProcessGroupLabel(MACHINED_FAMILY_HINT)).toBeNull();
  });

  it('the hint is the one the backend sends on Refresh analysis (no drift between upload and refresh)', () => {
    const backend = readFileSync(
      resolve(__dirname, '../../backend/src/modules/bom-items/costing/shared/core/part-family-process-group.ts'), 'utf-8',
    );
    expect(backend).toContain(`export const MACHINED_FAMILY_HINT = '${MACHINED_FAMILY_HINT}';`);
    const engine = readFileSync(resolve(__dirname, '../../cad-engine/shared/part_family.py'), 'utf-8');
    expect(engine).toContain(`MACHINED_HINT = "${MACHINED_FAMILY_HINT}"`);
  });

  it('the Workflow Builder lists an assembly\'s or a weldment\'s routes by the family it is costed as, any other part\'s by its CAD family', () => {
    // A part analysed as milled whose Process is now Part Assembly; an assembly with no model at all.
    expect(routingFamilyOf('milled', 'part_assembly')).toBe('part_assembly');
    expect(routingFamilyOf(null, 'assembly')).toBe('assembly');
    // A PCB analysed as sheet metal from its 3D model lists its board routes.
    expect(routingFamilyOf('sheet_metal', 'pcb')).toBe('pcb');
    // Every other part keeps its CAD family, as before (and none while its cost is loading).
    expect(routingFamilyOf('die_cast', 'sand_cast')).toBe('die_cast');
    expect(routingFamilyOf('milled', undefined)).toBe('milled');
    expect(routingFamilyOf(undefined, undefined)).toBeNull();
  });

  it('a hydroformed part (analysed as sheet metal) lists its Process\'s complete routes, not the sheet-metal cut-then-form builder', () => {
    expect(routingFamilyOf('sheet_metal', 'sheet_metal', 'Sheet Metal - Hydroforming')).toBe('hydroforming');
    expect(routingFamilyOf('sheet_metal', 'sheet_metal', 'Sheet Metal Roll Forming')).toBe('roll_forming');
    expect(routingFamilyOf('sheet_metal', 'sheet_metal', 'Sheet Metal')).toBe('sheet_metal');
    expect(routingFamilyOf('sheet_metal', 'sheet_metal', null)).toBe('sheet_metal');
  });
});

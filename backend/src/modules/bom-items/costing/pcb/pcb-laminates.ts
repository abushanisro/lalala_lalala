// A PCB laminate as raw_materials holds it (memory/PCBA/raw_materials.csv, migration 855): its kind and copper weight read from its name, its
// price per square metre (base_cost_per_unit_usd: the reference prices laminates by area, "Cost per Sq Meter"). Pure.
import type { PcbLaminate } from './pcb-route';

/** "2Ply-1ozCu-FR4" -> a double-clad core of 1 oz copper; "0.5ozCu" -> a 0.5 oz copper foil; "Panel" -> the panel stock. */
export function laminateOf(row: { id: string; name: string; usdPerM2: number | null; dielectricMm: number | null }): PcbLaminate {
  const name = row.name.trim();
  const core = /^(\d)Ply-([0-9.]+)ozCu-FR4$/i.exec(name);
  const foil = /^([0-9.]+)ozCu$/i.exec(name);
  const usd = row.usdPerM2 != null && Number.isFinite(row.usdPerM2) && row.usdPerM2 > 0 ? row.usdPerM2 : null;
  if (core) return { id: row.id, name, kind: core[1] === '1' ? 'single_core' : 'double_core', copperOz: Number(core[2]), usdPerM2: usd, dielectricMm: row.dielectricMm };
  if (foil) return { id: row.id, name, kind: 'foil', copperOz: Number(foil[1]), usdPerM2: usd, dielectricMm: null };
  return { id: row.id, name, kind: 'panel', copperOz: null, usdPerM2: usd, dielectricMm: null };
}

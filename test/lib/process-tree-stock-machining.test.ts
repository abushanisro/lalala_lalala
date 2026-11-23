import { describe, expect, it } from 'vitest';

import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';
import { computeFeatureNodeVisual } from '@/lib/features/operation-highlight';
import { buildProcessTree, findNode, type ProcessTreeNode } from '@/lib/features/process-tree';
import type { FeatureGraph, FeatureGraphSummary } from '@/lib/types/manufacturing';

import { SHAFT_INDIA, SHAFT_USA_AS_SUPPLIED, STIFFNER_PERIMETER_MILLED, STIFFNER_PLATE_CUT } from '../fixtures/stock-machining-quotes';

// A Stock Machining part in the process tree: the catalog's Material Stock step (the stock, and the faces left as it supplies them), the Band
// Saw with its StockTrim on the two end faces, then the Machining route. Each face row highlights its own faces in the 3D view.
const item = { id: 'i1', name: 'Side shaft', partNumber: 'P-1', material: 'Aluminium', materialGrade: '6061', quantity: 1, scenarioOverrides: { processGroup: 'Stock Machining' } } as unknown as BOMItem;
const summary = {} as FeatureGraphSummary;
const hole = { id: 'SimpleHole:1', feature_type: 'SimpleHole', occurrences: [{ centroid: [0, 0, 0], face_ids: [12] }] };
const fg = { classification: { family: 'mill_turn' }, feature_graph_v2: { features: [hole] } } as unknown as FeatureGraph;
const line = (o: Record<string, unknown>) => ({ cycleTimeMin: 0.1, machineName: 'Haas ST-20', ...o });
const bandSaw = line({
  process: 'Band Saw', processGroup: 'Stock Machining', processRoute: 'Band Saw', machineName: 'DoAll 3613-1 Vert',
  featureBreakdown: [{ name: 'Band Saw // StockTrim', timeSec: 7.08, featureType: 'StockTrim', count: 1, faceIds: [5, 22] }],
});
const turning = line({ process: 'Rough Turning', processGroup: 'Machining', processRoute: '2 Axis Lathe' });
const cost = (stockMachining: CostSummaryDto['stockMachining'], lines: unknown[]) => ({ stockMachining, processLines: lines }) as unknown as CostSummaryDto;

const node = (tree: ProcessTreeNode, id: string): ProcessTreeNode => {
  const found = findNode(tree, id);
  if (!found) throw new Error(`the tree has no node ${id}`);
  return found;
};
const steps = (tree: ProcessTreeNode) => (tree.children ?? []).map((g) => `${g.label}: ${(g.children ?? []).map((o) => o.label).join(', ')}`);

describe('buildProcessTree: a Stock Machining part', () => {
  it('lists Material Stock first, then the Band Saw, in the part\'s group; the machining steps under Machining and their machine', () => {
    const tree = buildProcessTree(item, fg, summary, 'India', undefined, cost(SHAFT_INDIA, [bandSaw, turning]));
    expect(steps(tree)).toEqual(['Stock Machining: Material Stock, Band Saw', 'Machining: 2 Axis Lathe']);
    const stock = node(tree, 'op_material_stock');
    expect(stock.machine).toBe('16 mm round bar');
    expect(stock.attrs).toEqual([
      { name: 'Stock', value: '16 mm round bar' },
      { name: 'Allowance', value: '0.79 mm a side · 0.79 mm each end' },
      { name: 'Piece', value: '33.59 mm long' },
      { name: 'Yield', value: '172 pieces per 6096 mm bar' },
      { name: 'Cost', value: "In the part's material cost" },
    ]);
  });

  it('says so when every side carries allowance, so no face is as supplied', () => {
    const tree = buildProcessTree(item, fg, summary, 'India', undefined, cost(SHAFT_INDIA, [bandSaw, turning]));
    expect(node(tree, 'op_material_stock').children?.map((c) => c.label)).toEqual(['No as-supplied faces']);
  });

  it('lists the faces left as the stock supplies them, each row highlighting its faces', () => {
    const tree = buildProcessTree(item, fg, summary, 'USA', undefined, cost(SHAFT_USA_AS_SUPPLIED, [turning]));
    const row = node(tree, 'material_stock_curved');
    expect(row.label).toBe('As Supplied // CurvedWall');
    expect(row.attrs).toEqual([{ name: 'Faces', value: '1' }, { name: 'Machined', value: 'No: as supplied' }]);
    expect(computeFeatureNodeVisual(row, [], [])?.highlight.occurrences).toEqual([{ centroid: [0, 0, 0], face_ids: [9] }]);
    // A bar-fed lathe parts the piece off: the quote has no Band Saw line, and the tree has no Band Saw step.
    expect(steps(tree)).toEqual(['Stock Machining: Material Stock', 'Machining: 2 Axis Lathe']);
  });

  it('highlights the two end faces from the Band Saw\'s StockTrim row', () => {
    const tree = buildProcessTree(item, fg, summary, 'India', undefined, cost(SHAFT_INDIA, [bandSaw, turning]));
    const trim = node(tree, 'machining_occ_0_0');
    expect(trim.label).toBe('Band Saw // StockTrim');
    expect(computeFeatureNodeVisual(trim, [], [])?.highlight).toMatchObject({ occurrences: [{ face_ids: [5, 22] }], centroidFromFaces: true });
  });

  it('keeps the features no step claims on the first machining step, never on the Band Saw', () => {
    const sawNoFaces = { ...bandSaw, featureBreakdown: [{ name: 'Band Saw // StockTrim', timeSec: 7.08, featureType: 'StockTrim', count: 1 }] };
    const tree = buildProcessTree(item, fg, summary, 'India', undefined, cost(SHAFT_INDIA, [sawNoFaces, turning]));
    const labels = (id: string) => (findNode(tree, id)?.children ?? []).map((c) => c.label);
    expect(labels('op_0')).not.toContain('SimpleHole ×1');
    expect(labels('op_1')).toEqual(['SimpleHole ×1']);
  });

  it('a Machining part is cut from the same stock: Material Stock first, with its stock details, and no Band Saw step', () => {
    const plain = { ...item, scenarioOverrides: { processGroup: 'Machining' } } as unknown as BOMItem;
    const tree = buildProcessTree(plain, fg, summary, 'India', undefined, cost({ ...SHAFT_INDIA, saw: null, sawMissing: 'Sawing the stock to pieces is not costed' }, [turning]));
    const stepLabels = steps(tree);
    expect(stepLabels).toHaveLength(1);
    expect(stepLabels[0]).toMatch(/^Machining: Material Stock, /);
    expect(stepLabels[0]).not.toContain('Band Saw');
    expect(node(tree, 'op_material_stock').attrs).toEqual(node(buildProcessTree(item, fg, summary, 'India', undefined, cost(SHAFT_INDIA, [bandSaw, turning])), 'op_material_stock').attrs);
    // The features no step claims stay on the machining step.
    expect((findNode(tree, 'op_0')?.children ?? []).map((c) => c.label)).toEqual(['SimpleHole ×1']);
  });

  it('a plate part cut out by a cutting process: the cutting line is its own step, a step of the stock, and the features stay on the mill', () => {
    const milled = { ...fg, classification: { family: 'milled' } } as unknown as FeatureGraph;
    const cutting = line({ process: 'Waterjet Cutting', processGroup: 'Sheet Metal', processRoute: 'Cutting', machineName: 'OMAX 55100', machineClass: 'waterjet', stockStep: true });
    const mill = line({ process: '3 Axis Mill', processGroup: 'Machining', processRoute: '3 Axis Mill', machineName: 'Makino V22', machineClass: '3_axis_mill' });
    const tree = buildProcessTree(item, milled, summary, 'USA', undefined, cost(STIFFNER_PLATE_CUT, [cutting, mill]));
    // A step of another process group than the part's own sits under its catalog route, as the machining after a casting does:
    // Sheet Metal > Cutting > Waterjet Cutting.
    expect(steps(tree)).toEqual(['Stock Machining: Material Stock', 'Sheet Metal: Cutting', 'Machining: 3 Axis Mill']);
    expect(node(tree, 'op_0').label).toBe('Waterjet Cutting');
    const labels = (id: string) => (findNode(tree, id)?.children ?? []).map((c) => c.label);
    // The features no step claims are the mill's, never the cutting process's: it cuts the blank out of the plate and makes none of them.
    expect(labels('op_0')).not.toContain('SimpleHole ×1');
    expect(labels('op_1')).toEqual(['SimpleHole ×1']);
    expect(node(tree, 'op_0').machine).toBe('OMAX 55100');
    expect(node(tree, 'op_material_stock').attrs).toContainEqual({ name: 'Yield', value: '45 cut blanks per 914.4 × 457.2 mm plate' });
    // Without the engine's mark the cutting line would have been taken for the part's first machine.
    const unmarked = buildProcessTree(item, milled, summary, 'USA', undefined, cost(STIFFNER_PLATE_CUT, [{ ...cutting, stockStep: undefined }, mill]));
    expect((findNode(unmarked, 'op_0')?.children ?? []).map((c) => c.label)).toEqual(['SimpleHole ×1']);
  });

  it('a plate part the mill cuts out itself: Perimeter Milling is a row of the mill\'s step, on the part\'s Perimeter, and the plate makes outlines', () => {
    const milled = { ...fg, classification: { family: 'milled' } } as unknown as FeatureGraph;
    const mill = line({
      process: '3 Axis Mill', processGroup: 'Machining', processRoute: '3 Axis Mill', machineName: 'Makino V22', machineClass: '3_axis_mill',
      featureBreakdown: [
        { name: 'Facing', timeSec: 45, featureType: '', count: 1 },
        { name: 'Bulk Milling', timeSec: 32, featureType: '', count: 1 },
        { name: 'Perimeter Milling', timeSec: 123, featureType: 'Perimeter', count: 1 },
        { name: 'Drilling Ø3.0mm', timeSec: 4, featureType: 'SimpleHole', count: 1, featureIds: ['SimpleHole:1'] },
      ],
    });
    const tree = buildProcessTree(item, milled, summary, 'USA', undefined, cost(STIFFNER_PERIMETER_MILLED, [mill]));
    // No Band Saw step: the mill's step follows the stock.
    expect(steps(tree)).toEqual(['Stock Machining: Material Stock', 'Machining: 3 Axis Mill']);
    const rows = (findNode(tree, 'op_0')?.children ?? []).map((c) => c.label);
    expect(rows).toEqual(['Facing', 'Bulk Milling', 'Perimeter Milling', 'Drilling Ø3.0mm']);
    const cut = (findNode(tree, 'op_0')?.children ?? []).find((c) => c.label === 'Perimeter Milling');
    expect(cut?.attrs?.map((a) => a.name)).toEqual(['Count', 'Time']);
    expect(cut?.attrs?.[0]?.value).toBe('1');
    // It is on no recognised feature: nothing to light, and no child rows.
    expect(cut?.v2FeatureIds).toBeUndefined();
    expect(cut?.children).toBeUndefined();
    expect(node(tree, 'op_material_stock').attrs).toContainEqual({ name: 'Yield', value: '40 outlines per 914.4 × 457.2 mm plate' });
  });

  it('adds no Material Stock step to a part whose cost summary has no stock (a part of another family, or a stock that could not be chosen)', () => {
    const plain = { ...item, scenarioOverrides: { processGroup: 'Machining' } } as unknown as BOMItem;
    const tree = buildProcessTree(plain, fg, summary, 'India', undefined, cost(undefined, [turning]));
    expect(findNode(tree, 'op_material_stock')).toBeNull();
    expect((findNode(tree, 'op_0')?.children ?? []).map((c) => c.label)).toEqual(['SimpleHole ×1']);
  });
});

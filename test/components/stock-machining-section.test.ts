import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StockMachiningSection } from '@/components/costing/StockMachiningSection';
import type { StockMachiningSummary } from '@/lib/costing/stock-machining-view';

import {
  SHAFT_INDIA, SHAFT_USA_AS_SUPPLIED, STIFFNER_NO_OUTLINE, STIFFNER_PERIMETER_MILLED, STIFFNER_PLATE, STIFFNER_PLATE_CUT, STIFFNER_PLATE_ROUGHING, STIFFNER_ROUGHING,
  STIFFNER_TUBE_ASKED,
} from '../fixtures/stock-machining-quotes';

const panel = (s: StockMachiningSummary | null, overrides: Record<string, unknown> = {}, highlight = true, sawCosted = true) =>
  renderToStaticMarkup(createElement(StockMachiningSection, {
    stockMachining: s, sawCosted, currencySymbol: '$', overrides, onChange: () => undefined, ...(highlight ? { onSelectHighlight: () => undefined } : {}),
  }));

// The same shaft as a part whose Process is Machining: the same stock, no band saw on its quote, and the engine's reason for that.
const SAW_NOT_COSTED = "Sawing the stock to pieces is not costed: the machine is loaded with a piece cut to length. Set the part's Process to Stock Machining to cost the band saw.";
const SHAFT_INDIA_MACHINING: StockMachiningSummary = {
  ...SHAFT_INDIA, saw: null, sawMissing: SAW_NOT_COSTED, options: SHAFT_INDIA.options.map((o) => ({ ...o, sawCost: null })),
};

describe('the Stock Machining section of the Cost Guide', () => {
  it('shows the stock and why that form, its allowance, the piece, the yield, the saw and every other form with its cost', () => {
    const out = panel(SHAFT_INDIA);
    expect(out).toContain('16 mm round bar</span> · needs Ø15.59 mm');
    expect(out).toContain('Auto: a turned part, 14 mm at its largest diameter');
    expect(out).toContain('Metric sizes');
    expect(out).toContain('0.79 mm a side · 0.79 mm each end');
    expect(out).toContain('33.59 mm long');
    expect(out).toContain('0.89 mm saw kerf between pieces · 152.4 mm bar end');
    expect(out).toContain('172 pieces per 6096 mm bar');
    expect(out).toContain('1 bar for the batch · 37.1% of the stock ends in the part');
    expect(out).toContain('0.019 kg bought · 0.018 kg piece · 0.007 kg part');
    expect(out).toContain('DoAll 3613-1 Vert');
    expect(out).toContain('1 bar a cut · 8064.5 mm²/min');
    expect(out).toContain('cut 1.5 s · feed 0.46 s · load 0.12 s · unload 5 s = 7.07 s a piece');
    expect(out).toContain('14 mm A/F hex bar · $0.05 + $0.02 saw');
    expect(out).toContain('Quoted');
    expect(out).toContain('No scrap credit is taken for the chips.');
    expect(out).toContain('Bar end that makes no part');
  });

  it('offers every other form that holds the part, and the way back to Auto only when a form is set here', () => {
    const auto = panel(SHAFT_INDIA);
    expect(auto.match(/>Use</g)).toHaveLength(6);
    expect(auto).not.toContain('Back to Auto');
    const set = panel(STIFFNER_PLATE, { stockForm: 'plate' });
    expect(set).toContain('Set here. Auto would take rectangular bar: its section is 42 x 8 mm');
    expect(set).toContain('Back to Auto (rectangular bar)');
    // The form that cannot hold the part is listed with its reason and no pick.
    expect(set).toContain('Round tube');
    expect(set).toContain('a tube is stock for a part with a bore through its whole length');
    expect(set.match(/>Use</g)).toHaveLength(3);
  });

  it('states plate by its blank and plates, with no bar end to set, and the scrap credit when it is on', () => {
    const out = panel(STIFFNER_PLATE, { stockForm: 'plate', stockScrapCredit: true });
    expect(out).toContain('needs 12.2 mm thick');
    expect(out).toContain('Inch sizes (USA)');
    expect(out).toContain('163.7 × 46.2 × 12.7 mm');
    expect(out).toContain('45 blanks per 914.4 × 457.2 mm plate');
    expect(out).toContain('3 plates for the batch');
    expect(out).toContain('one plate at a time · 8064.5 mm²/min');
    expect(out).not.toContain('Bar end mm');
    expect(out).toContain('Scrap credit $0.19 a part (9% of the material price on the chips)');
    expect(out).toContain('<option value="on" selected="">Chips sold back</option>');
  });

  it('says why a form set here was not used', () => {
    expect(panel(STIFFNER_TUBE_ASKED, { stockForm: 'round_tube' })).toContain('The Cost Guide&#x27;s round tube is not available');
  });

  it('shows the faces left as supplied and the trimmed ends as links into the 3D view, and why a bar-fed lathe has no saw', () => {
    const out = panel(SHAFT_USA_AS_SUPPLIED, { stockAllowanceMm: 0, stockSnap: false });
    expect(out).toContain('needs Ø14 mm, bought at that size');
    expect(out).toContain('title="Click to highlight in the 3D view">1 curved face</button>');
    expect(out).toContain('title="Click to highlight in the 3D view">2 end faces</button>');
    expect(out).toContain('A bar-fed lathe takes the whole bar and parts each piece off');
    expect(out).toContain('2.5 mm parting cut between pieces');
    expect(out).toContain('<option value="off" selected="">Exactly what is needed</option>');
    expect(out).toContain('value="0"');
    // Without a 3D view to show them in, the counts are plain text.
    expect(panel(SHAFT_USA_AS_SUPPLIED, {}, false)).not.toContain('Click to highlight in the 3D view');
  });

  it('a Machining part: the same stock and settings, and in place of the saw the engine\'s reason, as a note', () => {
    const out = panel(SHAFT_INDIA_MACHINING, {}, true, false);
    expect(out).toContain('16 mm round bar</span> · needs Ø15.59 mm');
    expect(out).toContain('172 pieces per 6096 mm bar');
    expect(out).toContain('0.89 mm saw kerf between pieces · 152.4 mm bar end');
    expect(out).toContain('<span class="text-muted-foreground">Sawing the stock to pieces is not costed');
    expect(out).not.toContain('DoAll 3613-1 Vert');
    // Each form is priced by its stock alone: no saw cost beside it.
    expect(out).toContain('14 mm A/F hex bar · $0.05<');
    expect(out).not.toContain(' saw<');
    // The stock rules are set here as on a Stock Machining part.
    for (const control of ['Allowance mm', 'Stock size', 'Bar end mm', 'Scrap credit']) expect(out).toContain(control);
    expect(out.match(/>Use</g)).toHaveLength(6);
  });

  it('a saw that should be costed and is not is shown as missing; a lathe that parts the piece off is a note', () => {
    const missing = panel({ ...SHAFT_INDIA, saw: null, sawMissing: 'HR Rates has no band saws' });
    expect(missing).toContain('<span class="text-amber-600 dark:text-amber-400">HR Rates has no band saws');
    expect(panel(SHAFT_USA_AS_SUPPLIED)).toContain('<span class="text-muted-foreground">A bar-fed lathe takes the whole bar');
  });

  it('bar stock has one roughing technique: no Roughing row', () => {
    expect(panel(SHAFT_INDIA)).not.toContain('Roughing');
    expect(panel(STIFFNER_PLATE, { stockForm: 'plate' })).not.toContain('Roughing');
  });

  it('plate stock lists the three roughing techniques, each with its cost, its yield and the bulk it leaves, and a pick', () => {
    const out = panel(STIFFNER_PLATE_ROUGHING, { stockForm: 'plate' });
    expect(out).toContain('>Roughing<');
    expect(out).toContain('All Bulk Milling · $2.37 plate + $0.44 Band Saw');
    expect(out).toContain('45 per plate · 56,074.51 mm³ left for the mill');
    expect(out).toContain('Perimeter Milling with Drop-off · $2.67 plate + $2.85 Perimeter Milling');
    expect(out).toContain('40 per plate · 24,268.95 mm³ left for the mill');
    expect(out).toContain('Plate Cutting with Drop-off · $2.37 plate + $1.46 Waterjet Cut');
    // Every cutting process: the priced ones with their nest and cost, the others with why.
    expect(out).toContain('Laser Cut · 35 per plate · $3.05 plate + $1.64 cut');
    expect(out).toContain('Waterjet Cut (quoted) · 45 per plate · $2.37 plate + $1.46 cut');
    expect(out).toContain('Plasma Cut: sm_reference_data nestingCutRate PlasmaCut holds no feed data');
    // Three other stock forms and two other techniques can be picked; the quoted form and the quoted technique are marked.
    expect(out.match(/>Use</g)).toHaveLength(5);
    expect(out.match(/>Quoted</g)).toHaveLength(2);
    expect(out).toContain('title="Quote the part with Perimeter Milling with Drop-off"');
    // Auto is the data's default: there is no way back to offer.
    expect(out).not.toContain('Back to Auto (All Bulk Milling)');
  });

  it('a technique set here is quoted, with the way back to Auto; the plate then makes outlines and nothing is sawn', () => {
    const out = panel(STIFFNER_PERIMETER_MILLED, { stockForm: 'plate', stockRoughingTechnique: 'perimeter_milling_dropoff' });
    expect(out).toContain('1/2&quot; plate, 159.5 x 42 mm outline</span>');
    expect(out).toContain('159.5 × 42 × 12.7 mm');
    expect(out).toContain('10 mm cutter width between parts and to the plate&#x27;s edge');
    expect(out).toContain('40 outlines per 914.4 × 457.2 mm plate');
    expect(out).toContain('Back to Auto (All Bulk Milling)');
    // The saw's absence is a note, not something missing, also for a Stock Machining part.
    expect(out).toContain('<span class="text-muted-foreground">The plate is loaded on the mill whole and the mill cuts each part out of it: no band saw cuts it.');
    expect(out).not.toContain('text-amber-600 dark:text-amber-400">The plate is loaded');
    const cut = panel(STIFFNER_PLATE_CUT, { stockForm: 'plate', stockRoughingTechnique: 'plate_cutting_dropoff' });
    expect(cut).toContain('45 cut blanks per 914.4 × 457.2 mm plate');
    expect(cut).toContain('5.08 mm between cut parts');
    expect(cut).toContain('<span class="text-muted-foreground">A plate cutting process cuts each part out of the plate: no band saw cuts it.');
  });

  it('a technique that cannot be used is listed with why and no pick, and the quote says what it priced instead', () => {
    const out = panel(STIFFNER_NO_OUTLINE, { stockForm: 'plate', stockRoughingTechnique: 'perimeter_milling_dropoff' });
    expect(out.match(/press Refresh analysis to measure the plate outline</g)).toHaveLength(2);
    expect(out).toContain('text-amber-600 dark:text-amber-400 leading-snug">The Cost Guide&#x27;s roughing technique, Perimeter Milling with Drop-off, is not available');
    // Only the three other stock forms can be picked: neither drop-off technique.
    expect(out.match(/>Use</g)).toHaveLength(3);
    expect(out).toContain('Back to Auto (All Bulk Milling)');
  });

  it('a Machining part\'s sawn blank is priced by its plate alone: the saw is not costed', () => {
    const machining = {
      ...STIFFNER_PLATE_ROUGHING, saw: null, sawMissing: SAW_NOT_COSTED,
      roughing: { ...STIFFNER_ROUGHING, options: STIFFNER_ROUGHING.options.map((o) => (o.technique === 'all_bulk_milling'
        ? { ...o, separation: { process: 'Band Saw', machineClass: 'band_saw', machineName: null, cost: null, timeSec: null } } : o)) },
    };
    const out = panel(machining, { stockForm: 'plate' }, true, false);
    expect(out).toContain('All Bulk Milling · $2.37 plate<');
    expect(out).toContain('Perimeter Milling with Drop-off · $2.67 plate + $2.85 Perimeter Milling');
  });

  it('says so when no side is as supplied, when the envelope is the bounding box, and when the stock is not chosen', () => {
    expect(panel(SHAFT_INDIA)).toContain('None as supplied: every side carries allowance');
    expect(panel({ ...SHAFT_INDIA, partSource: 'bounding box' })).toContain('Press Refresh analysis to measure its stock envelope');
    expect(panel({ ...SHAFT_INDIA, stock: null, saw: null, sawMissing: 'no stock form holds the part' })).toContain('No stock form holds the part');
    expect(panel(null)).toContain('The stock is not chosen yet');
  });
});

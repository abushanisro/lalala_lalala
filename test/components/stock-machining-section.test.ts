import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StockMachiningSection } from '@/components/costing/StockMachiningSection';
import type { StockMachiningSummary } from '@/lib/costing/stock-machining-view';

import { SHAFT_INDIA, SHAFT_USA_AS_SUPPLIED, STIFFNER_PLATE, STIFFNER_TUBE_ASKED } from '../fixtures/stock-machining-quotes';

const panel = (s: StockMachiningSummary | null, overrides: Record<string, unknown> = {}, highlight = true) =>
  renderToStaticMarkup(createElement(StockMachiningSection, {
    stockMachining: s, currencySymbol: '$', overrides, onChange: () => undefined, ...(highlight ? { onSelectHighlight: () => undefined } : {}),
  }));

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

  it('says so when no side is as supplied, when the envelope is the bounding box, and when the stock is not chosen', () => {
    expect(panel(SHAFT_INDIA)).toContain('None as supplied: every side carries allowance');
    expect(panel({ ...SHAFT_INDIA, partSource: 'bounding box' })).toContain('Press Refresh analysis to measure its stock envelope');
    expect(panel({ ...SHAFT_INDIA, stock: null, saw: null, sawMissing: 'no stock form holds the part' })).toContain('No stock form holds the part');
    expect(panel(null)).toContain('The stock is not chosen yet');
  });
});

'use client';

import { NumberField } from '@/components/costing/NumberField';
import {
  STOCK_MACHINING_SCENARIO_KEYS, allowanceLine, batchLine, bundleLine, facesHighlight, flagOf, flagValue, isPlateStock, lossLine, neededLine, optionCostLine,
  parseNonNegative, pieceLine, sawTimesLine, stockFormLabel, stockMachiningOverridesOf, yieldLine, type StockMachiningSummary,
} from '@/lib/costing/stock-machining-view';
import type { FeatureNodeV2 } from '@/lib/types/manufacturing';

import type { ReactNode } from 'react';

interface Props {
  stockMachining: StockMachiningSummary | null | undefined;
  /** The summary's currency, for what each stock form costs a part. */
  currencySymbol: string;
  /** The part's scenario overrides (unset keys: the data's rule decides). */
  overrides: Record<string, unknown> | null | undefined;
  /** Writes one scenario key; null clears it. */
  onChange: (patch: Record<string, string | number | boolean | null>) => void;
  /** Shows faces in the 3D view. Without it the face counts are plain text. */
  onSelectHighlight?: ((node: FeatureNodeV2 | null) => void) | undefined;
}

const rowClass = 'flex items-start gap-2 py-0.5';
const labelClass = 'text-xs text-muted-foreground w-24 shrink-0';
const controlClass = 'flex-1 min-w-0 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-hidden focus:ring-1 focus:ring-primary/40';
const linkClass = 'text-left underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-hidden focus-visible:text-primary';
const kg = (v: number | null) => (v == null ? '—' : `${String(Math.round(v * 1000) / 1000)} kg`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className={rowClass} title={title}>
      <span className={labelClass}>{label}</span>
      <span className="flex-1 min-w-0 tabular-nums">{children}</span>
    </div>
  );
}

/** A count of faces that shows them in the 3D view when clicked. */
function Faces({ label, highlight, onSelectHighlight }: { label: string; highlight: FeatureNodeV2 | null; onSelectHighlight: Props['onSelectHighlight'] }) {
  if (!highlight || !onSelectHighlight) return <span>{label}</span>;
  return (
    <button type="button" className={linkClass} title="Click to highlight in the 3D view" onClick={() => { onSelectHighlight(highlight); }}>
      {label}
    </button>
  );
}

/** A yes / no stock rule: Auto leaves it to the data. */
function FlagSelect({ label, title, value, auto, on, off, onCommit }: {
  label: string; title: string; value: boolean | null; auto: string; on: string; off: string; onCommit: (v: boolean | null) => void;
}) {
  return (
    <div className={`${rowClass} items-center`} title={title}>
      <span className={labelClass}>{label}</span>
      <select className={`${controlClass} cursor-pointer`} value={flagValue(value)} onChange={(e) => { onCommit(flagOf(e.target.value)); }}>
        <option value="">{auto}</option>
        <option value="on">{on}</option>
        <option value="off">{off}</option>
      </select>
    </div>
  );
}

/**
 * The Cost Guide's Stock Machining panel: the stock the part is cut from and why that form, the allowance left on it, the piece cut for one
 * part, what a bar or plate makes, the band saw's cycle, every other form that holds the part with its cost, and the stock rules that can be
 * set here over the data's. The faces left as the stock supplies them, and the saw's two cuts, are shown in the 3D view when clicked.
 * The mill's or lathe's own work is on the Cost tab.
 */
export function StockMachiningSection({ stockMachining: s, currencySymbol, overrides, onChange, onSelectHighlight }: Props) {
  const set = stockMachiningOverridesOf(overrides);
  if (!s) return <p className="text-xs text-muted-foreground">The stock is not chosen yet: see the warning on the Cost tab.</p>;
  const stock = s.stock;
  const keys = STOCK_MACHINING_SCENARIO_KEYS;
  const curved = facesHighlight('stock-as-supplied-curved', 'CurvedWall', s.asSuppliedFaceIds.curvedWall);
  const planar = facesHighlight('stock-as-supplied-planar', 'PlanarFace', s.asSuppliedFaceIds.planarFace);
  const ends = facesHighlight('stock-trim', 'StockTrim', s.endFaceIds);
  const asSupplied = s.asSuppliedFaceIds.curvedWall.length + s.asSuppliedFaceIds.planarFace.length;
  return (
    <div className="space-y-1 text-xs">
      {stock ? (
        <>
          <Field label="Stock" title="The part's envelope plus the stock allowance on each side, snapped up to the next preferred size of the location (inch in USA, metric elsewhere).">
            <span className="font-medium">{stock.sizeLabel}</span> · {neededLine(stock)}
            <span className="block text-muted-foreground">
              {set.form ? `Set here. Auto would take ${stockFormLabel(s.rule.form).toLowerCase()}` : 'Auto'}: {s.rule.basis}
            </span>
            <span className="block text-muted-foreground">{stock.unitSystem === 'US' ? 'Inch sizes (USA)' : 'Metric sizes'}</span>
          </Field>
          <Field label="Allowance" title="The stock left for the machine to cut: on each side of the section, and faced off each end.">
            {allowanceLine(stock)}
          </Field>
          <Field label="Piece" title="What is cut from the bar or plate for one part, and what each cut loses.">
            {pieceLine(stock)}
            <span className="block text-muted-foreground">{lossLine(stock)}</span>
          </Field>
          <Field label="Yield" title="The parts one bar or plate makes. Each part carries its share of the whole bar or plate.">
            {yieldLine(stock)}
            <span className="block text-muted-foreground">{batchLine(stock)} · {stock.utilizationPct}% of the stock ends in the part</span>
          </Field>
          <Field label="Material" title="The stock bought per part (its share of a whole bar or plate), the piece cut for it, and the finished part.">
            {kg(stock.purchasedKg)} bought · {kg(stock.pieceKg)} piece · {kg(stock.partKg)} part
          </Field>
        </>
      ) : (
        <p className="text-amber-600 dark:text-amber-400">No stock form holds the part: the reasons are listed under Stock forms.</p>
      )}
      {s.fallback && <p className="text-amber-600 dark:text-amber-400 leading-snug">{s.fallback}</p>}
      {s.partSource === 'bounding box' && (
        <p className="text-amber-600 dark:text-amber-400 leading-snug">Sized from the part&apos;s bounding box. Press Refresh analysis to measure its stock envelope.</p>
      )}

      <Field label="Band Saw" title="The saw that cuts the piece from the bar or plate: cut time = area cut / the material's cutting rate, plus feed, load and unload.">
        {s.saw ? (
          <>
            {s.saw.machineName}
            <span className="block text-muted-foreground" title={s.saw.bundleBasis}>
              {bundleLine(s.saw, stock)} · {s.saw.cuttingRateMm2Min} mm²/min
            </span>
            <span className="block text-muted-foreground">{sawTimesLine(s.saw)}</span>
          </>
        ) : (
          <span className={stock?.cutOff === 'parting' ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}>{s.sawMissing ?? 'Not costed'}</span>
        )}
      </Field>

      <Field label="Faces" title="Where the stock carries no allowance, its surface is the part's: those faces are not finished by the machine. The saw cuts the two end faces.">
        {asSupplied > 0 ? (
          <span className="block">
            As supplied:{' '}
            {s.asSuppliedFaceIds.curvedWall.length > 0 && <Faces label={plural(s.asSuppliedFaceIds.curvedWall.length, 'curved face')} highlight={curved} onSelectHighlight={onSelectHighlight} />}
            {s.asSuppliedFaceIds.curvedWall.length > 0 && s.asSuppliedFaceIds.planarFace.length > 0 && ', '}
            {s.asSuppliedFaceIds.planarFace.length > 0 && <Faces label={plural(s.asSuppliedFaceIds.planarFace.length, 'flat face')} highlight={planar} onSelectHighlight={onSelectHighlight} />}
          </span>
        ) : (
          <span className="block text-muted-foreground">None as supplied: every side carries allowance</span>
        )}
        {s.endFaceIds.length > 0 && (
          <span className="block">
            Stock trim: <Faces label={plural(s.endFaceIds.length, 'end face')} highlight={ends} onSelectHighlight={onSelectHighlight} />
          </span>
        )}
      </Field>

      <Field label="Stock forms" title="Every form that holds the part, with the stock bought per part and its sawing. Auto follows the part's shape; a form picked here is quoted instead.">
        {s.options.map((o) => {
          const cost = optionCostLine(o, currencySymbol);
          return (
            <span key={o.form} className="flex items-start gap-2 py-0.5">
              <span className={`flex-1 min-w-0 ${o.chosen ? 'text-foreground' : 'text-muted-foreground'}`}>
                {o.sizeLabel ?? stockFormLabel(o.form)}{cost ? ` · ${cost}` : ''}
                {o.unavailable && <span className="block text-[11px] leading-snug">{o.unavailable}</span>}
              </span>
              {o.chosen ? (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground">Quoted</span>
              ) : !o.unavailable && (
                <button
                  type="button"
                  className="shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-border hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-primary/40"
                  title={`Quote the part from ${stockFormLabel(o.form).toLowerCase()}`}
                  onClick={() => { onChange({ [keys.form]: o.form }); }}
                >
                  Use
                </button>
              )}
            </span>
          );
        })}
        {set.form && (
          <button type="button" className={`${linkClass} mt-0.5`} onClick={() => { onChange({ [keys.form]: null }); }}>
            Back to Auto ({stockFormLabel(s.rule.form).toLowerCase()})
          </button>
        )}
      </Field>

      <NumberField
        label="Allowance mm"
        value={set.allowanceMm}
        placeholder={stock ? `${String(stock.allowancePerSideMm)} (the data's rule)` : "the data's rule"}
        parse={parseNonNegative}
        onCommit={(v) => { onChange({ [keys.allowanceMm]: v }); }}
        title="The stock left on each side of the part, in mm. Empty: a percentage of the largest section size, between the data's least and most. 0: the stock's surface as supplied."
      />
      <FlagSelect
        label="Stock size"
        title="Whether the size snaps up to the next preferred size, or the stock is bought at exactly what the part needs."
        value={set.snap}
        auto="Auto (the data's rule)"
        on="Next preferred size"
        off="Exactly what is needed"
        onCommit={(v) => { onChange({ [keys.snap]: v }); }}
      />
      {(!stock || !isPlateStock(stock)) && (
        <NumberField
          label="Bar end mm"
          value={set.barEndMm}
          placeholder={stock?.barEndMm != null ? String(stock.barEndMm) : '152.4'}
          parse={parseNonNegative}
          onCommit={(v) => { onChange({ [keys.barEndMm]: v }); }}
          title="The end of each bar that makes no part: what the saw's vise or the bar feeder holds."
        />
      )}
      <FlagSelect
        label="Scrap credit"
        title="Whether the chips are sold back at the material's scrap value, taken off the material cost."
        value={set.scrapCredit}
        auto="Auto (the data's rule)"
        on="Chips sold back"
        off="No credit"
        onCommit={(v) => { onChange({ [keys.scrapCredit]: v }); }}
      />
      <p className="text-muted-foreground leading-snug">
        {s.scrapCredit.enabled
          ? `Scrap credit ${currencySymbol}${s.scrapCredit.credit.toFixed(2)} a part${s.scrapCredit.percent != null ? ` (${String(s.scrapCredit.percent)}% of the material price on the chips)` : ''}`
          : 'No scrap credit is taken for the chips.'}
      </p>

      {s.notes.length > 0 && (
        <div className="text-[11px] leading-snug text-muted-foreground space-y-0.5 pt-0.5">
          {s.notes.map((note) => <p key={note}>{note}</p>)}
        </div>
      )}
    </div>
  );
}

'use client';

import {
  PCB_COPPER_OZ, PCB_FINISH_OPTIONS, PCB_ROUTE_OPTIONS, PCB_SCENARIO_KEYS, basisLabel, numberOf, pcbRouteOf, type PcbFact, type PcbSummary,
} from '@/lib/costing/pcb-view';

interface Props {
  pcb: PcbSummary | null | undefined;
  /** The quoted route's stamping die, bed-of-nails fixture or flying-probe program (USD): an investment each, spread over the job. */
  tooling?: { key: string; description: string; detail: string; costUsd: number | null; perPartUsd: number | null }[] | undefined;
  /** The part's scenario overrides (unset keys: the board files or the reference decide). */
  overrides: Record<string, unknown> | null | undefined;
  /** Writes one scenario key; null clears it. */
  onChange: (patch: Record<string, string | number | boolean | null>) => void;
}

const rowClass = 'flex items-start gap-2 py-0.5';
const labelClass = 'text-xs text-muted-foreground w-24 shrink-0';
const controlClass = 'flex-1 min-w-0 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-hidden focus:ring-1 focus:ring-primary/40';
const inputClass = 'w-16 border border-border rounded px-1 py-0.5 bg-background';
const n = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-US');

/** A board value with where it came from: measured values plain, others marked so a default is never read as measured. */
function Fact({ fact, unit }: { fact: PcbFact | { value: string; basis: PcbFact['basis']; source: string } | null; unit?: string }) {
  if (!fact) return <span className="text-muted-foreground">not stated</span>;
  const measured = fact.basis === 'board_files' || fact.basis === 'cad_model';
  return (
    <span title={`${basisLabel(fact.basis)}: ${fact.source}`}>
      {typeof fact.value === 'number' ? n(fact.value) : fact.value}{unit ?? ''}
      {!measured && <span className="text-muted-foreground"> ({basisLabel(fact.basis)})</span>}
    </span>
  );
}

/**
 * The Cost Guide's PCB panel: the board the CAD engine measured from its files (each value with where it came from), what the files cannot
 * state (layers of a model-only board, thickness, copper, finish, test points), the stack-up and the panel nest, the laminates, the finishes
 * priced beside the specified one, the tooling, and the four routes (the cheapest complete one quoted unless one is set here).
 */
export function PcbSection({ pcb: p, tooling, overrides, onChange }: Props) {
  const forced = pcbRouteOf(overrides);
  const finish = typeof overrides?.[PCB_SCENARIO_KEYS.finish] === 'string' ? String(overrides[PCB_SCENARIO_KEYS.finish]) : '';
  const plugging = overrides?.[PCB_SCENARIO_KEYS.viaPlugging];
  const setNumber = (key: string, value: string, whole = true) => {
    onChange({ [key]: value === '' ? null : whole ? Math.max(0, Math.floor(Number(value))) : Math.max(0, Number(value)) });
  };
  const b = p?.board;
  return (
    <div className="space-y-1 text-xs">
      <div className={rowClass}>
        <span className={labelClass}>Route</span>
        <select
          className={`${controlClass} cursor-pointer`}
          value={forced ?? ''}
          onChange={(e) => { onChange({ [PCB_SCENARIO_KEYS.route]: e.target.value || null }); }}
          title="Auto: the cheapest complete route (profile x electrical test) for the board and its volume."
        >
          <option value="">Auto (cheapest{p?.routeLabel && !forced ? `: ${p.routeLabel}` : ''})</option>
          {PCB_ROUTE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      <div className={rowClass}>
        <span className={labelClass}>Finish</span>
        <select
          className={`${controlClass} cursor-pointer`}
          value={finish}
          onChange={(e) => { onChange({ [PCB_SCENARIO_KEYS.finish]: e.target.value || null }); }}
          title="The board's surface finish: its specification. The other two are priced beside it, never quoted in its place."
        >
          <option value="">{p ? `Reference default: ${p.finishLabel}` : 'Reference default (HASL)'}</option>
          {PCB_FINISH_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      <div className={rowClass}>
        <span className={labelClass}>Board</span>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1" title="Copper layers. Counted from a Gerber set's copper files; a 3D model does not show them.">
            layers
            <input type="number" min={1} className={inputClass} value={numberOf(overrides, PCB_SCENARIO_KEYS.layers) ?? ''} placeholder={b ? String(b.layers.value) : ''}
              onChange={(e) => { setNumber(PCB_SCENARIO_KEYS.layers, e.target.value); }} />
          </label>
          <label className="flex items-center gap-1" title="Finished board thickness (mm): from the fabrication drawing; a Gerber set does not state it (defaultBoardThickness when not set).">
            mm
            <input type="number" min={0} step={0.1} className={inputClass} value={numberOf(overrides, PCB_SCENARIO_KEYS.thickness) ?? ''} placeholder={b ? n(b.thicknessMm.value) : ''}
              onChange={(e) => { setNumber(PCB_SCENARIO_KEYS.thickness, e.target.value, false); }} />
          </label>
          <label className="flex items-center gap-1" title="Outer copper weight (oz/ft²): a weight the reference prices.">
            outer oz
            <select className={`${inputClass} cursor-pointer`} value={numberOf(overrides, PCB_SCENARIO_KEYS.outerOz) ?? ''}
              onChange={(e) => { onChange({ [PCB_SCENARIO_KEYS.outerOz]: e.target.value === '' ? null : Number(e.target.value) }); }}>
              <option value="">{b ? n(b.outerCopperOz.value) : '-'}</option>
              {PCB_COPPER_OZ.map((oz) => <option key={oz} value={oz}>{oz}</option>)}
            </select>
          </label>
          {(b?.layers.value ?? numberOf(overrides, PCB_SCENARIO_KEYS.layers) ?? 0) > 2 && (
            <label className="flex items-center gap-1" title="Inner copper weight (oz/ft²).">
              inner oz
              <select className={`${inputClass} cursor-pointer`} value={numberOf(overrides, PCB_SCENARIO_KEYS.innerOz) ?? ''}
                onChange={(e) => { onChange({ [PCB_SCENARIO_KEYS.innerOz]: e.target.value === '' ? null : Number(e.target.value) }); }}>
                <option value="">{b?.innerCopperOz ? n(b.innerCopperOz.value) : '-'}</option>
                {PCB_COPPER_OZ.map((oz) => <option key={oz} value={oz}>{oz}</option>)}
              </select>
            </label>
          )}
        </span>
      </div>
      <div className={rowClass}>
        <span className={labelClass}>Sides, test</span>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1" title="Sides with solder mask (0-2): from the board files' mask layers when they have them.">
            mask
            <input type="number" min={0} max={2} className={inputClass} value={numberOf(overrides, PCB_SCENARIO_KEYS.maskSides) ?? ''} placeholder={b ? String(b.soldermaskSides.value) : ''}
              onChange={(e) => { setNumber(PCB_SCENARIO_KEYS.maskSides, e.target.value); }} />
          </label>
          <label className="flex items-center gap-1" title="Sides with a legend (silkscreen, 0-2): from the board files' legend layers when they have them.">
            legend
            <input type="number" min={0} max={2} className={inputClass} value={numberOf(overrides, PCB_SCENARIO_KEYS.legendSides) ?? ''} placeholder={b ? String(b.silkscreenSides.value) : ''}
              onChange={(e) => { setNumber(PCB_SCENARIO_KEYS.legendSides, e.target.value); }} />
          </label>
          <label className="flex items-center gap-1" title="Points the electrical test touches: the pins on the nets the board files trace, else set here.">
            test points
            <input type="number" min={0} className="w-20 border border-border rounded px-1 py-0.5 bg-background" value={numberOf(overrides, PCB_SCENARIO_KEYS.testPoints) ?? ''}
              placeholder={b?.testPoints ? String(b.testPoints.value) : 'not stated'} onChange={(e) => { setNumber(PCB_SCENARIO_KEYS.testPoints, e.target.value); }} />
          </label>
          <label className="flex items-center gap-1 cursor-pointer" title="Fill the vias (Plug Vias and Cure Plugged Vias): off unless set (defaultEnableViaPlugging).">
            <input type="checkbox" checked={plugging === true || plugging === 'true'} onChange={(e) => { onChange({ [PCB_SCENARIO_KEYS.viaPlugging]: e.target.checked || null }); }} />
            plug vias
          </label>
        </span>
      </div>

      {!p || !b ? (
        <p className="text-xs text-muted-foreground">Not costed as a PCB yet: upload the board files (Gerber set) and press Refresh analysis, or see the warning on the Cost tab.</p>
      ) : (
        <>
          {p.routeLabel && (
            <div className={rowClass}>
              <span className={labelClass}>Quoted</span>
              <span className="flex-1 min-w-0 text-foreground">{p.routeLabel}{p.nest ? ` · ${p.nest.boardsPerPanel} per panel` : ''}</span>
            </div>
          )}
          <div className={rowClass} title="The board as its files (or model) measure it; a value they cannot state comes from the Cost Guide or the reference, and says so.">
            <span className={labelClass}>Measured</span>
            <span className="flex-1 min-w-0 tabular-nums space-y-0.5">
              <span className="block"><Fact fact={b.lengthMm} /> x <Fact fact={b.widthMm} unit=" mm" /> · <Fact fact={b.thicknessMm} unit=" mm thick" /></span>
              <span className="block"><Fact fact={b.layers} unit=" layers" /> · outer <Fact fact={b.outerCopperOz} unit=" oz" />{b.innerCopperOz && <> · inner <Fact fact={b.innerCopperOz} unit=" oz" /></>}</span>
              <span className="block">mask <Fact fact={b.soldermaskSides} unit=" side(s)" /> · legend <Fact fact={b.silkscreenSides} unit=" side(s)" /> · <Fact fact={b.testPoints} unit=" test points" /></span>
              <span className="block" title={b.holesSource}>
                {b.holes.length ? b.holes.map((h) => `${h.count} x Ø${n(h.diameterMm)}${h.plated ? '' : ' NPTH'}`).join(', ') : 'no drilled holes'}
              </span>
            </span>
          </div>
          {p.stackup && (
            <div className={rowClass} title="The layer build-up (tblLayerMaterialType, tblDielectricThickness): cores, copper foils and the prepreg between them.">
              <span className={labelClass}>Stack-up</span>
              <span className="flex-1 min-w-0 tabular-nums">
                {p.stackup.sequence.join(' / ')} · {p.stackup.cores} core(s){p.stackup.coreDielectricMm != null ? ` of ${n(p.stackup.coreDielectricMm)} mm` : ''}
                {p.stackup.foils > 0 ? ` · ${p.stackup.foils} foil(s)` : ''}{p.stackup.laminated ? ' · laminated' : ''}
              </span>
            </div>
          )}
          {p.nest && (
            <div className={rowClass} title={p.nest.note}>
              <span className={labelClass}>Panel</span>
              <span className="flex-1 min-w-0 tabular-nums">
                {p.nest.boardsPerPanel} board(s) on a {p.nest.panelMm.map((v) => Math.round(v)).join(' x ')} mm panel ({p.nest.arraysPerPanel} array(s) of {p.nest.boardsPerArray}) · {Math.round(p.nest.utilization * 100)} % used
              </span>
            </div>
          )}
          {p.materials.length > 0 && (
            <div className={rowClass} title="The laminates the board takes, priced per square metre of panel (the Material Stock line).">
              <span className={labelClass}>Laminate</span>
              <span className="flex-1 min-w-0 space-y-0.5">
                {p.materials.map((m) => <span key={m.name} className="block tabular-nums" title={m.detail}>{m.count} x {m.name}{m.usdPerM2 > 0 ? ` · $${n(m.usdPerM2)}/m²` : ''}</span>)}
              </span>
            </div>
          )}
          {p.finishOptions.length > 0 && (
            <div className={rowClass} title="The finishes the board does not specify, priced on the quoted route for comparison. The quote keeps the specified one.">
              <span className={labelClass}>Other finishes</span>
              <span className="flex-1 min-w-0 space-y-0.5">
                {p.finishOptions.map((f) => (
                  <span key={f.finish} className="block text-muted-foreground" title={f.reason ?? undefined}>
                    {f.label}{f.totalCost != null ? ` · ${f.totalCost.toFixed(2)} a board` : f.reason ? ` · ${f.reason}` : ''}
                  </span>
                ))}
              </span>
            </div>
          )}
          {tooling && tooling.length > 0 && (
            <div className={rowClass} title="Tools and test programs: investments kept out of the piece cost, spread over the job (annual volume x production life).">
              <span className={labelClass}>Tooling</span>
              <span className="flex-1 min-w-0 space-y-0.5">
                {tooling.map((t) => (
                  <span key={t.key} className="block tabular-nums" title={t.detail}>
                    {t.description}: {t.costUsd != null ? `$${t.costUsd.toLocaleString('en-US')}` : 'not priced'}
                    {t.perPartUsd != null && <span className="text-muted-foreground"> · ${t.perPartUsd} a board</span>}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className={rowClass}>
            <span className={labelClass}>Routes</span>
            <span className="flex-1 min-w-0 space-y-0.5">
              {p.options.map((o) => (
                <span key={o.route} className={`block ${o.route === p.route ? 'text-foreground' : 'text-muted-foreground'}`} title={o.reason ?? undefined}>
                  {o.label}{o.totalCost != null ? ` · ${o.totalCost.toFixed(2)}` : o.reason ? ` · ${o.reason}` : ''}
                </span>
              ))}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

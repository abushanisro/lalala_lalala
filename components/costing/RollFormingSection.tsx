'use client';

import {
  ROLL_FORMING_ROUTE_OPTIONS, ROLL_FORMING_SCENARIO_KEYS, ROLL_FORMING_WELDING_OPTIONS, coilLine, lineSpeedLine, ribLines, rollFormingOverridesOf, sharpStripLine,
  stationsLine, tubeLine,
  type RollFormingSummary, type RollFormingTooling,
} from '@/lib/costing/roll-forming-view';

interface Props {
  rollForming: RollFormingSummary | null | undefined;
  /** The quoted route's rolls and press dies (USD): investments spread over the job, kept out of the piece cost. */
  tooling?: RollFormingTooling | undefined;
  /** The part's scenario overrides (unset keys: the engine decides). */
  overrides: Record<string, unknown> | null | undefined;
  /** Writes one scenario key; null clears it. */
  onChange: (patch: Record<string, string | number | boolean | null>) => void;
}

const rowClass = 'flex items-start gap-2 py-0.5';
const labelClass = 'text-xs text-muted-foreground w-24 shrink-0';
const controlClass = 'flex-1 min-w-0 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-hidden focus:ring-1 focus:ring-primary/40';
const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US');
const whole = (v: string) => (v === '' ? null : Math.max(1, Math.round(Number(v))));

/**
 * The Cost Guide's Sheet Metal Roll Forming panel: the coil line a profile is made on. The cut-off (memory's rule: a closed section by blade,
 * an open one by scissor, unless set here), the welding of a closed section, the roll stations (the data's rule unless set here) and the roll
 * tooling multiplier; then the strip, the mill, the line speed and what limits it, the coil and its change, the punching in the flat strip,
 * the tooling, and both routes compared.
 */
export function RollFormingSection({ rollForming: r, tooling, overrides, onChange }: Props) {
  const set = rollFormingOverridesOf(overrides);
  const closed = r?.section.closed ?? false;
  const sharpStrip = r?.section.sharpBends ? sharpStripLine(r.section.sharpBends.stripChangeMm, r.strip.measuredWidthMm) : null;
  const ribs = ribLines(r?.stations.groups ?? []);
  return (
    <div className="space-y-1 text-xs">
      <div className={rowClass}>
        <span className={labelClass}>Cut-off</span>
        <select
          className={`${controlClass} cursor-pointer`}
          value={set.cutOff ?? ''}
          onChange={(e) => { onChange({ [ROLL_FORMING_SCENARIO_KEYS.cutOff]: e.target.value || null }); }}
          title="Auto: memory's rule (a closed section is cut off by blade, leaving a slug; an open one by scissor)."
        >
          <option value="">Auto (memory&apos;s rule{r && !set.cutOff ? `: ${ROLL_FORMING_ROUTE_OPTIONS.find((o) => o.key === r.rule.route)?.label ?? r.rule.route}` : ''})</option>
          {ROLL_FORMING_ROUTE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      {(closed || set.welding) && (
        <div className={rowClass}>
          <span className={labelClass}>Welding</span>
          <select
            className={`${controlClass} cursor-pointer`}
            value={set.welding ?? ''}
            onChange={(e) => { onChange({ [ROLL_FORMING_SCENARIO_KEYS.welding]: e.target.value || null }); }}
            title="Auto: memory's autoIncludeIntegratedWeldingProcess (Integrated HFI Welding) seam welds a closed section."
          >
            <option value="">Auto (Integrated HFI Welding)</option>
            {ROLL_FORMING_WELDING_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
      )}
      <div className={rowClass}>
        <span className={labelClass}>Overrides</span>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1" title="The roll stations the profile is formed in: the data's rule (15° a pass per level of bends, a lead-in pass for thick stock, finishing passes) unless set here. Sizes the mill and the rolls.">
            stations
            <input type="number" min={1} className="w-14 border border-border rounded px-1 py-0.5 bg-background" value={set.stations ?? ''}
              placeholder={r ? String(r.stations.rule) : ''}
              onChange={(e) => { onChange({ [ROLL_FORMING_SCENARIO_KEYS.stations]: whole(e.target.value) }); }} />
          </label>
          <label className="flex items-center gap-1" title="The roll tooling multiplier (USD per mm of strip a station): the data's toolingMultiplier_Standard 14.64, or _Panel 21.96 for a panel profile, unless set here.">
            roll tooling ×
            <input type="number" min={0} step="0.01" className="w-16 border border-border rounded px-1 py-0.5 bg-background" value={set.toolingMultiplier ?? ''}
              placeholder={r?.stations.panel ? '21.96' : '14.64'}
              onChange={(e) => { onChange({ [ROLL_FORMING_SCENARIO_KEYS.toolingMultiplier]: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }); }} />
          </label>
        </span>
      </div>

      {!r ? (
        <p className="text-xs text-muted-foreground">Not costed as a roll formed profile yet: see the warning on the Cost tab.</p>
      ) : (
        <>
          <div className={rowClass}>
            <span className={labelClass}>Quoted</span>
            <span className="flex-1 min-w-0 text-foreground">
              {r.routeLabel}
              {!r.feasible && <span className="text-destructive"> · not roll formed (see the Cost tab)</span>}
              {r.feasible && !r.complete && <span className="text-amber-600 dark:text-amber-400"> · incomplete (see the Cost tab)</span>}
            </span>
          </div>
          <div className={rowClass} title={r.rule.basis}>
            <span className={labelClass}>Section</span>
            <span className="flex-1 tabular-nums">
              {n(r.section.heightMm)} x {n(r.section.widthMm)} mm · {r.section.closed ? 'closed' : 'open'} · {r.section.bends} bend{r.section.bends === 1 ? '' : 's'}
              {r.section.curveRadiusMm != null && ` · curved R${n(r.section.curveRadiusMm)}`}
              {r.section.tube && <span className="block text-muted-foreground">tube {tubeLine(r.section.tube)}</span>}
              {r.section.sharpBends && r.section.sharpBends.count > 0 && (
                <span className="block text-muted-foreground" title={r.section.sharpBends.basis}>
                  {r.section.sharpBends.count} bend{r.section.sharpBends.count === 1 ? '' : 's'} modelled sharp
                  {r.section.sharpBends.pricedRadiusMm != null ? `, priced at R${n(r.section.sharpBends.pricedRadiusMm)}` : ''}
                  {sharpStrip ? ` · ${sharpStrip}` : ''}
                </span>
              )}
            </span>
          </div>
          <div className={rowClass} title="The strip slit from the coil: the section's stretch-out, and the length fed a part (the part plus the blade's slug).">
            <span className={labelClass}>Strip</span>
            <span className="flex-1 tabular-nums">
              {n(r.strip.widthMm)} x {n(r.strip.thicknessMm)} mm · {n(r.strip.feedLengthMm)} mm a part{r.strip.slugMm > 0 ? ` (slug ${n(r.strip.slugMm)})` : ''} · {r.strip.massKg} kg
              {r.materialPriceSource && <span className="block text-muted-foreground">price: {r.materialPriceSource}</span>}
            </span>
          </div>
          <div
            className={rowClass}
            title={`Levels of bends from the web (${r.stations.levelSource}). A pass forms up to 15° (rollFormingLiftAngle), less for a long flange: `
              + `Bhattacharyya's deformation length √(8a³Δθ / 3t) must fit the mill's stand spacing${r.stations.standSpacingMm != null ? ` (${n(r.stations.standSpacingMm)} mm)` : ''}; `
              + `flanges measured ${r.stations.flangeSource ?? 'from the CAD'}.`}
          >
            <span className={labelClass}>Stations</span>
            <span className="flex-1 tabular-nums">
              {stationsLine(r.stations)}
              {r.stations.override != null && <span className="block text-foreground">{r.stations.override} set in the Cost Guide</span>}
              {r.stations.panel && <span className="block text-muted-foreground">panel profile (8 or more bends): duplex mill, panel tooling</span>}
              {ribs.map((line) => <span key={line} className="block text-muted-foreground">{line}, as one unit</span>)}
              {r.stations.directionsMeasured === false && (r.stations.groups ?? []).length > 0 && (
                <span className="block text-amber-600 dark:text-amber-400">bend directions not measured: close bends formed as flanges (Refresh analysis)</span>
              )}
            </span>
          </div>
          {r.mill && (
            <div className={rowClass}>
              <span className={labelClass}>Mill</span>
              <span className="flex-1 min-w-0">
                {r.mill.name}
                <span className="block text-muted-foreground tabular-nums">
                  {[r.mill.stands != null ? `${r.mill.stands} stands` : null, r.mill.shaftDiameterMm != null ? `shaft ${n(r.mill.shaftDiameterMm)} mm` : null,
                    r.mill.requiredShaftMm != null ? `needs ${n(r.mill.requiredShaftMm)} mm` : null, r.mill.type, r.mill.curveUnit ? 'curve unit' : null].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
          )}
          {r.lineSpeed && (
            <div
              className={rowClass}
              title={[...r.lineSpeed.caps.map((c) => `${c.name}: ${Math.round(c.mmPerS)} mm/s`),
                ...(r.lineSpeed.speedsTried != null ? [`the cheapest whole line of ${r.lineSpeed.speedsTried} speeds tried`] : [])].join('\n')}
            >
              <span className={labelClass}>Line speed</span>
              <span className="flex-1 tabular-nums">{lineSpeedLine(r.lineSpeed)}</span>
            </div>
          )}
          {r.coil && (
            <div className={rowClass} title="The coil the strip comes from (the data's 508 / 1524 mm coil, up to the uncoiler's capacity), and its change spread over its parts.">
              <span className={labelClass}>Coil</span>
              <span className="flex-1 tabular-nums">
                {coilLine(r.coil)}
                {r.coil.setupMethod && <span className="block text-muted-foreground">{r.coil.setupMethod}</span>}
              </span>
            </div>
          )}
          <div className={rowClass} title="The line stops to change or sharpen a press die (stationaryDieChangeoverTime every numHitsPerDieChange hits).">
            <span className={labelClass}>Stoppages</span>
            <span className="flex-1 tabular-nums">die sharpening {n(r.dieSharpeningPerPartS)} s a part</span>
          </div>
          <div className={rowClass}>
            <span className={labelClass}>Flattener</span>
            <span className="flex-1">{r.flattener.needed ? 'on the line' : 'not needed'} <span className="text-muted-foreground">({r.flattener.reason})</span></span>
          </div>
          {r.punching && (
            <div className={rowClass} title="Punched in the flat strip before the mill, one die station per kind of feature.">
              <span className={labelClass}>Punching</span>
              <span className="flex-1 min-w-0 tabular-nums">
                {r.punching.punched} punched · {r.punching.dieStations.length} die station{r.punching.dieStations.length === 1 ? '' : 's'}
                {r.punching.dieStations.length > 0 && <span className="block text-muted-foreground">{r.punching.dieStations.join(' · ')}</span>}
                {r.punching.notPunched.map((p) => (
                  <span key={p.featureType} className="block text-amber-600 dark:text-amber-400">{p.count} {p.featureType} not punched: {p.reason}</span>
                ))}
              </span>
            </div>
          )}
          {r.welding && (
            <div className={rowClass}>
              <span className={labelClass}>Welding</span>
              <span className="flex-1 min-w-0">{r.welding.process}{r.welding.machine ? ` · ${r.welding.machine}` : ''} <span className="text-muted-foreground">({r.welding.source})</span></span>
            </div>
          )}
          {(r.forcesKn.punch != null || r.forcesKn.cutOff != null) && (
            <div className={rowClass}>
              <span className={labelClass}>Forces</span>
              <span className="flex-1 tabular-nums">
                {[r.forcesKn.punch != null ? `punching ${n(r.forcesKn.punch)} kN` : null, r.forcesKn.cutOff != null ? `cut-off ${n(r.forcesKn.cutOff)} kN` : null].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          {tooling && tooling.length > 0 && (
            <div className={rowClass} title="Investments kept out of the piece cost, spread over the job (annual volume x production life).">
              <span className={labelClass}>Tools</span>
              <span className="flex-1 min-w-0 space-y-0.5">
                {tooling.map((t) => (
                  <span key={t.key} className="block tabular-nums" title={t.detail}>
                    {t.description}: {t.costUsd != null ? `$${t.costUsd.toLocaleString('en-US')}` : 'not costed'}
                    {t.perPartUsd != null && <span className="text-muted-foreground"> · ${t.perPartUsd} a part</span>}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className={rowClass}>
            <span className={labelClass}>Routes</span>
            <span className="flex-1 min-w-0 space-y-0.5">
              {r.options.map((o) => (
                <span key={o.route} className={`block ${o.route === r.route ? 'text-foreground' : 'text-muted-foreground'}`} title={o.reason ?? undefined}>
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

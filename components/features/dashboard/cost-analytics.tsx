'use client';

import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Activity, Clock, Coins, Factory, Layers, Package, Percent, PiggyBank, Target } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import type { CostAnalytics, CostElement } from '@/lib/api/cost-analytics';
import {
  basisLabel, basisOf, concentration, count, decades, driverRows, ELEMENT_LABEL, elementRows, gapRows, kg, money, pareto, percent, plural, ratios,
  savingsBridge, utilisationRows, weeklyCosted, weightRows, type Basis,
} from '@/lib/dashboard/cost-analytics';

import { AXIS_TICK, TOOLTIP_STYLE } from './charts';

import type { ReactNode } from 'react';

// The workspace's chart colours, in the order that keeps neighbours apart for colour-blind readers; every mark also carries its value in text.
const ELEMENT_COLOUR: Record<CostElement, string> = {
  rawMaterial: 'hsl(var(--chart-4))',
  process: 'hsl(var(--chart-1))',
  tooling: 'hsl(var(--chart-3))',
  packagingLogistics: 'hsl(var(--chart-2))',
  procuredParts: 'hsl(var(--chart-5))',
};
const SERIES = 'hsl(var(--chart-1))';
const ASKED = 'hsl(var(--chart-4))';
const SAVING = 'hsl(var(--success))';
const INCREASE = 'hsl(var(--destructive))';
const LABEL = { fill: 'hsl(var(--foreground))', fontSize: 12 };

interface Props {
  data: CostAnalytics | undefined;
  isLoading: boolean;
  isError: boolean;
  /** Injected so the weekly chart is testable; the page passes nothing. */
  now?: Date;
}

/** The workspace's should-cost: headline figures and the charts a buyer or a cost consultant reads them from. */
export function CostAnalyticsSection({ data, isLoading, isError, now }: Props) {
  if (isLoading) {
    return (
      <Card className="rounded-xl shadow-sm">
        <CardContent className="space-y-4 p-6">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-72 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card className="rounded-xl shadow-sm">
        <EmptyState icon={Coins} title="Should-cost analytics could not be loaded" description="The project figures below are not affected. Reload the page to try again." />
      </Card>
    );
  }
  if (data.coverage.costed === 0) {
    return (
      <Card className="rounded-xl shadow-sm">
        <EmptyState
          icon={Coins}
          title="No part is costed yet"
          description={data.coverage.unresolved > 0
            ? `${count(data.coverage.unresolved)} parts have cost records whose currency cannot be established, so they are left out. Recalculate them from the part's cost page.`
            : 'Open a part, choose its process route and apply it: its should-cost then appears here with the cost drivers, the costliest parts and the savings against each ask price.'}
        >
          <Button variant="outline" size="sm" asChild><Link href="/projects">Open projects</Link></Button>
        </EmptyState>
      </Card>
    );
  }

  const a = data;
  const basis = basisOf(a);
  const perYear = basis === 'annual';
  const r = ratios(a);
  const m = (v: number | null | undefined, compact = true) => money(v, a.currency, compact);
  const exact = (v: number) => money(v, a.currency);
  const spend = (row: { unitCost: number; annualSpend: number }) => (perYear ? row.annualSpend : row.unitCost);
  const elements = elementRows(a, basis);
  const drivers = driverRows(a, basis);
  const topParts = pareto(a, basis);
  const carried = concentration(a, basis);
  const gaps = gapRows(a.parts, 6);
  const bridge = savingsBridge(a);
  const weights = weightRows(a.parts);
  const weightTicks = decades(weights.map(w => w.weightKg));
  const costTicks = decades(weights.map(w => w.unitCost));
  const used = utilisationRows(a.materials);
  const weeks = weeklyCosted(a.parts, now ?? new Date());
  const machines = perYear ? a.machines : [...a.machines].sort((x, y) => y.unitCost - x.unitCost);
  const converted = Object.entries(a.fxRates).map(([from, rate]) => `1 ${from} = ${money(rate, a.currency)}`).join(', ');
  const askHint = 'Enter the price asked for a part on its Scenario panel (Currency and Ask Price). The gap to its should-cost then shows here.';

  return (
    <section aria-label="Should-cost analytics" className="space-y-6">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b border-border p-6 pb-4">
          <CardTitle className="text-lg font-semibold">Should-cost analytics</CardTitle>
          <p className="text-sm text-muted-foreground">
            Totalled from the saved cost records of {count(a.coverage.costed)} costed parts, in {a.currency}.
            {converted && ` Amounts in other currencies are converted at the workspace's budget rates (${converted}).`}
            {a.coverage.notCosted > 0 && ` ${count(a.coverage.notCosted)} BOM items have no cost yet.`}
            {a.coverage.unresolved > 0 && ` ${count(a.coverage.unresolved)} are left out because the currency of their records cannot be established.`}
            {perYear && a.coverage.withAnnualVolume < a.coverage.costed && ` Annual figures cover the ${count(a.coverage.withAnnualVolume)} parts with an annual volume.`}
          </p>
        </CardHeader>
        <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          <Tile icon={Layers} label="Parts costed" value={`${count(a.coverage.costed)} of ${count(a.coverage.parts)}`} note={`${percent(r.coverage)} of BOM items`} />
          <Tile icon={Coins} label={perYear ? 'Should-cost a year' : 'Should-cost, one of each part'} value={m(perYear ? a.totals.annualSpend : a.totals.unitCost)}
            note={perYear ? 'unit should-cost × annual volume' : 'no annual volumes entered'} />
          <Tile icon={Package} label="Average should-cost a part" value={m(r.averageUnitCost)} note={`${m(a.totals.unitCost)} for one of each part`} />
          {a.savings.parts > 0
            ? <Tile icon={PiggyBank} label="Savings opportunity a year" tone="success" value={m(a.savings.opportunityAnnual)}
                note={`${percent(r.opportunity, 1)} of the ${m(a.savings.askAnnual)} asked for ${plural(a.savings.parts, 'part')}`} />
            : <Tile icon={PiggyBank} label="Savings opportunity a year" value="No ask prices yet" note="ask price less should-cost, once prices are entered" />}
          <Tile icon={Percent} label="Material share of cost" value={percent(r.materialShare)} note={`${percent(r.materialShare == null ? null : 1 - r.materialShare)} is conversion and other cost`} />
          <Tile icon={Target} label="Material utilisation" value={percent(r.utilisation)}
            note={r.utilisation == null ? 'no stock weights on the material records' : `${kg(a.totals.netKg)} in the parts of ${kg(a.totals.grossKg)} bought`} />
          <Tile icon={Clock} label={perYear ? 'Machine hours a year' : 'Cycle time, one of each part'}
            value={perYear ? `${count(a.totals.annualHours)} h` : `${count(a.parts.reduce((s, p) => s + p.cycleTimeS, 0) / 60)} min`}
            note={`${plural(a.machines.length, 'machine')} and work centres`} />
          <Tile icon={Activity} label="Cost concentration" value={carried ? percent(carried.share) : '—'}
            note={carried ? `of the should-cost is in the ${count(carried.parts)} costliest parts` : 'needs every costed part in the list'} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="What the cost is made of" question={`Should-cost ${basisLabel(basis)}, by cost element.`}>
          <div className="flex h-3 w-full gap-0.5" role="img" aria-label={elements.map(e => `${e.label} ${percent(e.share)}`).join(', ')}>
            {elements.map(e => (
              <div key={e.key} className="h-3 rounded-sm" title={`${e.label}: ${exact(e.value)} (${percent(e.share, 1)})`} style={{ width: `${e.share * 100}%`, backgroundColor: ELEMENT_COLOUR[e.key] }} />
            ))}
          </div>
          <ul className="mt-4 divide-y divide-border text-sm">
            {elements.map(e => (
              <li key={e.key} className="flex items-baseline justify-between gap-4 py-2.5">
                <span className="flex items-center gap-2"><Swatch colour={ELEMENT_COLOUR[e.key]} />{e.label}</span>
                <span className="shrink-0 tabular-nums"><span className="font-medium">{exact(e.value)}</span><span className="ml-3 inline-block w-14 text-right text-muted-foreground">{percent(e.share, 1)}</span></span>
              </li>
            ))}
          </ul>
        </ChartCard>

        <ChartCard title="Should-cost by BOM" question={`Should-cost ${basisLabel(basis)} of each BOM's costed parts, by cost element.`}
          legend={elements.map(e => ({ label: e.label, colour: ELEMENT_COLOUR[e.key] }))}>
          <BomBars a={a} basis={basis} money={m} exact={exact} />
        </ChartCard>

        <ChartCard title="Cost drivers" question={`What the should-cost ${basisLabel(basis)} is spent on, the largest first: where a cost reduction has the most to act on.`}
          legend={elements.filter(e => drivers.some(d => d.element === e.key)).map(e => ({ label: e.label, colour: ELEMENT_COLOUR[e.key] }))}>
          <BarList rows={drivers.map(d => ({ key: d.key, name: d.label, note: `Moved by ${d.movedBy}`, value: d.value, label: m(d.value), detail: percent(d.share, 1),
            title: `${d.label}: ${exact(d.value)} (${percent(d.share, 1)} of the should-cost)`, colour: ELEMENT_COLOUR[d.element] }))} />
        </ChartCard>

        <ChartCard title="Where the cost is: the costliest parts" question={`Should-cost ${basisLabel(basis)} by part. The second figure is the share of the whole reached so far.`}>
          <BarList rows={topParts.map(p => ({ key: p.id, name: p.name, value: p.value, label: m(p.value), detail: percent(p.cumulativeShare),
            title: `${p.name}: ${exact(p.value)}, ${percent(p.share, 1)} of the should-cost (${percent(p.cumulativeShare, 1)} with the parts above it)` }))} />
        </ChartCard>

        <ChartCard title="Ask price against should-cost" question="The parts with the most money a year between the price asked and the should-cost."
          missing={gaps.length === 0 ? askHint : undefined} legend={[{ label: 'Ask price', colour: ASKED }, { label: 'Should-cost', colour: SERIES }]}>
          <GapBars rows={gaps} exact={exact} />
        </ChartCard>

        <ChartCard title="From ask price to should-cost" question="What is asked a year for the priced parts, the gap in each BOM, and what those parts should cost."
          missing={bridge.length === 0 ? askHint : undefined}
          legend={[{ label: 'Total', colour: ASKED }, { label: 'Above should-cost', colour: SAVING }, ...(bridge.some(s => s.kind === 'increase') ? [{ label: 'Below should-cost', colour: INCREASE }] : [])]}>
          <Bridge steps={bridge} money={m} exact={exact} />
        </ChartCard>

        <ChartCard title="Cost by process" question={`Process cost ${basisLabel(basis)}, by process group.`} missing={a.processGroups.length === 0 ? 'No process cost is saved on the costed parts.' : undefined}>
          <BarList rows={a.processGroups.slice(0, 8).map(g => ({ key: g.name, name: g.name, value: spend(g), label: m(spend(g)), detail: plural(g.parts, 'part'),
            title: `${g.name}: ${exact(spend(g))} over ${plural(g.records, 'operation')} on ${plural(g.parts, 'part')}` }))} />
        </ChartCard>

        <ChartCard title={perYear ? 'Machine load' : 'Cost by machine'}
          question={perYear ? 'Hours a year each machine or work centre runs to make the annual volumes.' : 'Process cost by machine or work centre, for one of each part.'}
          missing={machines.length === 0 ? 'No machine is named on the saved process records.' : undefined}>
          <BarList rows={machines.slice(0, 8).map(g => ({ key: g.name, name: g.name, value: perYear ? g.annualHours : g.unitCost, label: perYear ? `${count(g.annualHours)} h` : m(g.unitCost),
            detail: perYear ? m(g.annualSpend) : plural(g.parts, 'part'), title: `${g.name}: ${count(g.annualHours)} h and ${exact(g.annualSpend)} a year, on ${plural(g.parts, 'part')}` }))} />
        </ChartCard>

        <ChartCard title="Cost by material" question={`Material cost ${basisLabel(basis)}, by grade.`} missing={a.materials.length === 0 ? 'No material cost is saved on the costed parts.' : undefined}>
          <BarList rows={a.materials.slice(0, 8).map(g => ({ key: g.name, name: g.name, value: spend(g), label: m(spend(g)), detail: plural(g.parts, 'part'),
            title: `${g.name}: ${exact(spend(g))} on ${plural(g.parts, 'part')}`, colour: ELEMENT_COLOUR.rawMaterial }))} />
        </ChartCard>

        <ChartCard title="Material utilisation" question="Of the stock bought for one of each part, the share that stays in the part. The rest is machined or cut away."
          missing={used.length === 0 ? 'The saved material records state no stock and part weights in kg.' : undefined}>
          <BarList max={1} rows={used.map(u => ({ key: u.name, name: u.name, value: u.utilisation, label: percent(u.utilisation), detail: `${kg(u.netKg)} of ${kg(u.grossKg)}`,
            title: `${u.name}: ${kg(u.netKg)} stays in the parts of ${kg(u.grossKg)} bought`, colour: ELEMENT_COLOUR.rawMaterial }))} />
        </ChartCard>

        <ChartCard title="Cost against weight" question="Each costed part by its weight and should-cost, both on log scales. A part far above the others of its weight costs much more a kilogram."
          missing={weights.length < 2 ? 'Fewer than two costed parts have a weight.' : undefined}>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart accessibilityLayer={false} margin={{ top: 8, right: 16, left: 8, bottom: 24 }}>
                <CartesianGrid stroke="hsl(var(--border))" />
                <XAxis type="number" dataKey="weightKg" scale="log" domain={span(weightTicks)} ticks={weightTicks} tick={AXIS_TICK} axisLine={{ stroke: 'hsl(var(--border))' }}
                  tickLine={false} tickFormatter={v => kg(Number(v))} label={{ value: 'Part weight', position: 'insideBottom', offset: -14, style: { fill: 'hsl(var(--muted-foreground))', fontSize: 12 } }} />
                <YAxis type="number" dataKey="unitCost" scale="log" domain={span(costTicks)} ticks={costTicks} tick={AXIS_TICK} axisLine={false} tickLine={false} width={72} tickFormatter={v => m(Number(v))} />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ active, payload }) => {
                  const w = active ? (payload[0]?.payload as (typeof weights)[number] | undefined) : undefined;
                  return w ? (
                    <div style={TOOLTIP_STYLE} className="px-3 py-2 text-sm">
                      <p className="font-medium">{w.name}</p>
                      <p className="tabular-nums text-muted-foreground">{exact(w.unitCost)} · {kg(w.weightKg)} · {exact(w.costPerKg)} a kg</p>
                    </div>
                  ) : null;
                }} />
                <Scatter data={weights} fill={SERIES} stroke="hsl(var(--card))" strokeWidth={2} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Costing activity" question="Parts costed in each of the last eight weeks, by the date of their first cost record.">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart accessibilityLayer={false} data={weeks} margin={{ top: 24, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} tickMargin={10} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} contentStyle={TOOLTIP_STYLE} formatter={value => [count(Number(value)), 'Parts costed']} labelFormatter={label => (typeof label === 'string' ? `Week of ${label}` : '')} />
                <Bar dataKey="parts" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                  <LabelList dataKey="parts" position="top" style={LABEL} formatter={(v: unknown) => (Number(v) > 0 ? String(v) : '')} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>
    </section>
  );
}

function Tile({ icon: Icon, label, value, note, tone }: { icon: typeof Coins; label: string; value: string; note: string; tone?: 'success' }) {
  return (
    <div className="bg-card p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <p className={`mt-3 text-2xl font-semibold tabular-nums tracking-tight ${tone === 'success' ? 'text-success' : 'text-primary'}`}>{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

const Swatch = ({ colour }: { colour: string }) => <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: colour }} aria-hidden="true" />;

/** A chart with its title and the question it answers. With `missing`, it says what data is not there, and where to enter it. */
function ChartCard({ title, question, missing, legend, children }: {
  title: string; question: string; missing?: string | undefined; legend?: { label: string; colour: string }[]; children: ReactNode;
}) {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b border-border p-6 pb-4">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{question}</p>
      </CardHeader>
      <CardContent className="p-6">
        {missing ? <EmptyState icon={Factory} title="Nothing to chart yet" description={missing} className="h-56 py-0" /> : (
          <>
            {legend && legend.length > 1 && (
              <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                {legend.map(l => <li key={l.label} className="flex items-center gap-2"><Swatch colour={l.colour} />{l.label}</li>)}
              </ul>
            )}
            {children}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface BarRow { key: string; name: string; note?: string; value: number; label: string; detail?: string; title: string; colour?: string }

/** One bar a row, under its whole name: a name is never cut short, it wraps. The value and one detail stand at the right. */
function BarList({ rows, max }: { rows: BarRow[]; max?: number }) {
  const scale = max ?? Math.max(...rows.map(row => row.value), 0);
  return (
    <ul className="space-y-3.5">
      {rows.map(row => (
        <li key={row.key} title={row.title}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="min-w-0 break-words font-medium text-foreground">{row.name}</span>
            <span className="shrink-0 tabular-nums text-foreground">
              <span className="font-medium">{row.label}</span>
              {row.detail && <span className="ml-3 inline-block min-w-14 text-right text-muted-foreground">{row.detail}</span>}
            </span>
          </div>
          {row.note && <p className="text-xs text-muted-foreground">{row.note}</p>}
          <Track><Fill share={scale > 0 ? row.value / scale : 0} colour={row.colour ?? SERIES} /></Track>
        </li>
      ))}
    </ul>
  );
}

const Track = ({ children }: { children: ReactNode }) => <div className="relative mt-1.5 h-2 w-full rounded bg-muted">{children}</div>;
const Fill = ({ share, colour, from = 0 }: { share: number; colour: string; from?: number }) => (
  <div className="absolute top-0 h-2 rounded" style={{ left: `${from * 100}%`, width: `${Math.max(0, Math.min(1, share)) * 100}%`, minWidth: share > 0 ? 2 : 0, backgroundColor: colour }} />
);

/** Each BOM's should-cost as one bar of its cost elements, to the scale of the largest BOM. */
function BomBars({ a, basis, money: m, exact }: { a: CostAnalytics; basis: Basis; money: (v: number) => string; exact: (v: number) => string }) {
  const keys = elementRows(a, basis).map(e => e.key);
  const rows = a.boms.filter(b => b.costed > 0).slice(0, 8).map(b => {
    const total = basis === 'annual' ? b.annualSpend : b.unitCost;
    return { ...b, total, shares: keys.map(k => ({ key: k, share: b.unitCost > 0 ? b.elements[k] / b.unitCost : 0 })) };   // the elements in the BOM's own proportions
  });
  const scale = Math.max(...rows.map(b => b.total), 0);
  return (
    <ul className="space-y-3.5">
      {rows.map(b => (
        <li key={b.id} title={`${b.name}: ${exact(b.total)} (${keys.map((k, i) => `${ELEMENT_LABEL[k]} ${percent(b.shares[i]?.share ?? 0)}`).join(', ')})`}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="min-w-0 break-words font-medium text-foreground">{b.name}</span>
            <span className="shrink-0 tabular-nums"><span className="font-medium">{m(b.total)}</span><span className="ml-3 text-muted-foreground">{count(b.costed)} of {plural(b.parts, 'part')} costed</span></span>
          </div>
          <div className="mt-1.5 h-2 w-full rounded bg-muted">
            <div className="flex h-2 gap-0.5" style={{ width: `${scale > 0 ? (b.total / scale) * 100 : 0}%`, minWidth: 2 }}>
              {b.shares.filter(s => s.share > 0).map(s => <div key={s.key} className="h-2 rounded-sm" style={{ width: `${s.share * 100}%`, backgroundColor: ELEMENT_COLOUR[s.key] }} />)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Each priced part: what is asked and what it should cost, on one scale, and the gap between them in words. */
function GapBars({ rows, exact }: { rows: ReturnType<typeof gapRows>; exact: (v: number) => string }) {
  const scale = Math.max(...rows.flatMap(g => [g.askPrice, g.unitCost]), 0);
  return (
    <ul className="space-y-4">
      {rows.map(g => (
        <li key={g.id} title={`${g.name}: asked ${exact(g.askPrice)}, should cost ${exact(g.unitCost)}`}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="min-w-0 break-words font-medium text-foreground">{g.name}</span>
            <span className={`shrink-0 font-medium tabular-nums ${g.gap >= 0 ? 'text-success' : 'text-destructive'}`}>
              {g.gap >= 0 ? `${exact(g.gap)} above should-cost` : `${exact(-g.gap)} below should-cost`}{g.gapShare != null && ` (${percent(Math.abs(g.gapShare))})`}
            </span>
          </div>
          {([['Ask price', g.askPrice, ASKED], ['Should-cost', g.unitCost, SERIES]] as const).map(([name, value, colour]) => (
            <div key={name} className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="relative h-2 flex-1 rounded bg-muted"><Fill share={scale > 0 ? value / scale : 0} colour={colour} /></div>
              <span className="w-24 shrink-0 text-right tabular-nums text-foreground">{exact(value)}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** A waterfall on its side: the ask price, each BOM's step down (or up) from the level before it, and the should-cost. */
function Bridge({ steps, money: m, exact }: { steps: ReturnType<typeof savingsBridge>; money: (v: number) => string; exact: (v: number) => string }) {
  const scale = Math.max(...steps.flatMap(s => [s.from, s.to]), 0);
  return (
    <ul className="space-y-3.5">
      {steps.map(s => {
        const colour = s.kind === 'total' ? ASKED : s.kind === 'saving' ? SAVING : INCREASE;
        const low = Math.min(s.from, s.to);
        return (
          <li key={s.name} title={s.kind === 'total' ? `${s.name}: ${exact(s.value)} a year` : `${s.name}: ${exact(Math.abs(s.value))} a year ${s.kind === 'saving' ? 'above' : 'below'} its should-cost`}>
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className={`min-w-0 break-words text-foreground ${s.kind === 'total' ? 'font-semibold' : 'font-medium'}`}>{s.name}</span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">{s.kind === 'total' ? m(s.value) : `${s.value < 0 ? '−' : '+'}${m(Math.abs(s.value))}`}</span>
            </div>
            <Track><Fill from={scale > 0 ? low / scale : 0} share={scale > 0 ? Math.abs(s.to - s.from) / scale : 0} colour={colour} /></Track>
          </li>
        );
      })}
    </ul>
  );
}

/** The first and last tick: the domain of a log axis (which cannot start at zero). */
const span = (ticks: number[]): [number, number] => [ticks[0] ?? 1, ticks[ticks.length - 1] ?? 10];

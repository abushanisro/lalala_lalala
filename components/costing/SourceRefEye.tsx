'use client';

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from '@/components/ui/icons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';
import { opensTable, type ResolvedCostingInputsLike, type SourcePanel } from '@/lib/calculators/input-source';
import { columnValue, isMatchedLookupRow } from '@/lib/calculators/lookup-row-match';
import { loadSourcePanel } from '@/lib/calculators/source-panel';

const cell = (v: unknown): string => {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  return typeof v === 'string' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
};

/**
 * The eye beside a calculation input that says where its value was read (its SourceRef), and the source it opens: the reference table,
 * record, calculation, calculator defaults or costing inputs, the row the value came from outlined. `button` goes beside the value and
 * `panel` under the input; both are null for an input whose ref opens no table (CAD faces are lit on the model, in the calculator dialog).
 */
export function useSourceRefEye(step: CalculationTraceStep, resolvedInputs?: ResolvedCostingInputsLike | null): { button: ReactNode; panel: ReactNode } {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<SourcePanel | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!opensTable(step.ref)) return { button: null, panel: null };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !panel) {
      setFailed(null);
      loadSourcePanel(step.ref, step.value, resolvedInputs)
        .then((p) => { setPanel(p); })
        .catch((e: unknown) => { setFailed(e instanceof Error ? e.message : 'The source could not be read'); });
    }
  };
  const button = (
    <Button
      type="button" variant={open ? 'default' : 'ghost'} size="sm" className="h-6 w-6 p-0" aria-pressed={open}
      title={open ? 'Hide where this value comes from' : 'Show where this value comes from'} aria-label={`Where ${step.fieldName} comes from`}
      onClick={toggle}
    >
      {open ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
    </Button>
  );
  if (!open) return { button, panel: null };
  return {
    button,
    panel: (
      <div className="mt-1 rounded-md border border-border bg-muted/30 p-2">
        {failed && <p className="text-xs text-red-600">{failed}</p>}
        {!failed && !panel && <p className="text-xs text-muted-foreground">Reading the source…</p>}
        {panel && <SourcePanelTable panel={panel} />}
      </div>
    ),
  };
}

/** A source panel as a read-only table: its name, its note, and the row the value came from outlined (the value column last). */
function SourcePanelTable({ panel }: { panel: SourcePanel }) {
  const last = panel.column_definitions.length - 1;
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold">{panel.tableName}</div>
      {panel.note && <p className="text-[11px] text-muted-foreground">{panel.note}</p>}
      <div className="max-h-64 overflow-auto">
        <Table className="text-[11px]">
          <TableHeader>
            <TableRow>
              {panel.column_definitions.map((c, i) => (
                <TableHead key={c.name} className={`h-7 px-2 ${i === last ? 'text-primary' : ''}`}>{c.label}{c.unit ? ` (${c.unit})` : ''}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {panel.rows.map((row, r) => {
              const current = isMatchedLookupRow(row, panel.matchedRowKeys);
              return (
                <TableRow key={r} className={current ? 'bg-primary/10 outline outline-1 outline-primary' : ''} aria-current={current ? 'true' : undefined}>
                  {panel.column_definitions.map((c) => <TableCell key={c.name} className="px-2 py-1 align-top">{cell(columnValue(row, c.name))}</TableCell>)}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

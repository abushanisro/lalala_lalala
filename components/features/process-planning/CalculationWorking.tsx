'use client';

import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight } from '@/components/ui/icons';
import { workingNumber, type LineWorking, type WorkingStep } from '@/lib/calculators/calculation-working';

const shown = (v: number | string | null) => (typeof v === 'number' ? workingNumber(v) : v ?? '—');

/** A value with its unit, right-aligned: "2.9375 mm". */
function StepValue({ step, strong = false }: { step: WorkingStep; strong?: boolean }) {
  return (
    <span className={`shrink-0 tabular-nums ${strong ? 'text-base font-bold text-primary' : 'text-sm font-semibold'}`}>
      {shown(step.value)}
      {step.unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{step.unit}</span>}
    </span>
  );
}

/** A formula under its result: in field names, then in the numbers used. */
export function FormulaLines({ step }: { step: Pick<WorkingStep, 'formula' | 'withValues'> }) {
  if (!step.formula && !step.withValues) return null;
  return (
    <div className="mt-1 space-y-0.5 font-mono text-xs break-words">
      {step.formula && <div className="text-muted-foreground">= {step.formula}</div>}
      {step.withValues && <div className="text-foreground/80">= {step.withValues}</div>}
    </div>
  );
}

/**
 * How a result is reached, as a worked example: each calculated value in the order it is computed, numbered, with its formula in field
 * names and again in the numbers used. The values are the calculator's own; nothing is recomputed here.
 */
export function WorkingSteps({ steps, startAt = 1 }: { steps: readonly WorkingStep[]; startAt?: number }) {
  if (steps.length === 0) return null;
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={step.fieldName} className="flex gap-3 rounded-lg border border-border/60 p-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold tabular-nums text-muted-foreground">
            {startAt + i}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{step.fieldName}</span>
              <StepValue step={step} />
            </div>
            <FormulaLines step={step} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * A line that ran its calculator once per group (a turned diameter, a hole size): each group's time, its steps on request, and the line's
 * total of them. The calculator above it is filled with one group, so this is where the line's own cycle time is accounted for.
 */
export function LineGroupsWorking({ line }: { line: LineWorking }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {line.groups.map((group) => (
        <Collapsible
          key={group.label}
          open={open === group.label}
          onOpenChange={(isOpen) => { setOpen(isOpen ? group.label : null); }}
          className="rounded-lg border border-border/60"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 p-3 text-left">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
              {open === group.label ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{group.label}</span>
            </span>
            {group.result ? <StepValue step={group.result} /> : <span className="text-xs text-muted-foreground">not timed</span>}
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pb-3">
            <WorkingSteps steps={group.steps} />
          </CollapsibleContent>
        </Collapsible>
      ))}
      {line.total && (
        <div className="rounded-lg bg-secondary/50 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold">{line.total.fieldName}</span>
            <StepValue step={line.total} strong />
          </div>
          <FormulaLines step={line.total} />
        </div>
      )}
    </div>
  );
}

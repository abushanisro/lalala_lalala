"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { AlertTriangle, CircleAlert, Home, Info, Loader2, Pause, Play, RotateCcw } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/client";
import type { FillIssue, FillMeshReport, FillRun, Vec3 } from "@/lib/api/fill-simulation";
import { useFillMesh, useFillSimulationInputs, useRunFillSimulation } from "@/lib/api/hooks/useFillSimulation";
import { usePlasticPullDirection } from "@/lib/api/hooks/usePlasticPullDirection";
import {
  EMPTY_SETUP, formatValue, legendGradient, legendTicks, planArrows, requestOf, RESULTS, scaleOf, specOf, suggestionsOf, valuesOf, withSuggestions,
  type ResultKind, type SetupForm, type SuggestedField, type Suggestions,
} from "@/lib/flow-simulation/display";

import { FlowSimulationCanvas } from "./FlowSimulationCanvas";


/** The whole fill plays in this many seconds, whatever the real fill time. */
const PLAY_SECONDS = 6;
const STORAGE_PREFIX = "emithran:fill-simulation:";

function loadSetup(itemId: string): SetupForm {
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + itemId);
    return stored ? { ...EMPTY_SETUP, ...(JSON.parse(stored) as Partial<SetupForm>) } : EMPTY_SETUP;
  } catch {
    return EMPTY_SETUP;
  }
}

function saveSetup(itemId: string, form: SetupForm): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + itemId, JSON.stringify(form));
  } catch {
    // a private window: the form simply is not remembered
  }
}

export interface FlowSimulationWorkspaceProps {
  itemId: string;
  /** The fill time the cost engine calculated for the part, and its runner system: the setup starts from them. */
  costFillTimeS?: number | null | undefined;
  runner?: "hot" | "cold" | null | undefined;
}

/** The fill simulation of one part: the mesh and the melt on the left, setup and results on the right. */
export function FlowSimulationWorkspace({ itemId, costFillTimeS, runner }: FlowSimulationWorkspaceProps) {
  const meshQuery = useFillMesh(itemId, true);
  const inputsQuery = useFillSimulationInputs(itemId, true);
  // What the reference data and the cost engine give for this part: the setup fills its empty fields from it, and shows where each came from.
  const suggestions = useMemo(
    () => suggestionsOf(inputsQuery.data, { fillTimeS: costFillTimeS ?? null, runner: runner ?? null }),
    [inputsQuery.data, costFillTimeS, runner],
  );
  const pullAxis = usePlasticPullDirection(itemId).data?.axis ?? null;   // the axis already fixed for the part, if any: the setup starts from it
  const runMutation = useRunFillSimulation(itemId);
  const [form, setForm] = useState<SetupForm>(() => loadSetup(itemId));
  const [tab, setTab] = useState<"setup" | "results">("setup");
  const [kind, setKind] = useState<ResultKind>("fillTime");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [show, setShow] = useState({ arrows: true, weldLines: true, endOfFill: true });
  const [fitNonce, setFitNonce] = useState(0);
  const [ranWith, setRanWith] = useState<string | null>(null);
  const clock = useRef(0);

  useEffect(() => {
    saveSetup(itemId, form);
  }, [itemId, form]);
  useEffect(() => {
    if (pullAxis) setForm((f) => (f.pullAxis === "" ? { ...f, pullAxis } : f));
  }, [pullAxis]);
  useEffect(() => {
    setForm((f) => withSuggestions(f, suggestions));
  }, [suggestions]);

  const response = runMutation.data ?? meshQuery.data ?? null;
  const mesh = response?.mesh ?? null;
  const report = response?.report ?? null;
  const run = runMutation.data?.simulation ?? null;
  const total = run?.summary.fillTimeS ?? 0;
  const shown: ResultKind = run ? kind : "thickness";
  const spec = specOf(shown);
  const values = useMemo(() => (mesh ? valuesOf(shown, mesh, run) : []), [mesh, run, shown]);
  const scale = useMemo(() => scaleOf(values, spec.capped), [values, spec.capped]);
  const arrows = useMemo(() => (mesh && run ? planArrows(mesh, run) : null), [mesh, run]);
  const built = useMemo(() => requestOf(form), [form]);
  const stale = run !== null && built.request !== null && JSON.stringify(built.request) !== ranWith;

  useEffect(() => {
    if (!playing || total <= 0) return undefined;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = Math.min(total, clock.current + ((now - last) / 1000) * (total / PLAY_SECONDS));
      last = now;
      clock.current = next;
      setTime(next);
      if (next >= total) setPlaying(false);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, total]);

  const seek = (value: number) => {
    clock.current = value;
    setTime(value);
  };
  const start = () => {
    if (!built.request) return;
    const request = built.request;
    runMutation.mutate(request, {
      onSuccess: (data) => {
        setRanWith(JSON.stringify(request));
        if (!data.simulation) return;
        setKind("fillTime");
        setTab("results");
        seek(0);
        setPlaying(true);
      },
    });
  };
  const failure = runMutation.error ?? meshQuery.error;
  const reasonOf = (error: Error) => (error instanceof ApiError ? error.getUserMessage() : error.message);
  const cannotRun = runMutation.data && !runMutation.data.simulation;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 bg-linear-to-b from-[#e6f0e7] to-[#b4d2b7]">
          {mesh && mesh.triangles.length > 0 && (
            <FlowSimulationCanvas
              mesh={mesh}
              values={values}
              scale={run ? scale : null}
              run={run}
              time={run ? time : Infinity}
              arrows={arrows}
              showArrows={show.arrows}
              showWeldLines={show.weldLines}
              showEndOfFill={show.endOfFill}
              gate={run && !stale ? run.inputs.gateMm : form.gate}
              onPick={(point: Vec3) => {
                if (tab === "setup") setForm((f) => ({ ...f, gate: point }));
              }}
              fitNonce={fitNonce}
            />
          )}
          <button
            type="button"
            title="Fit the whole part"
            aria-label="Fit the whole part"
            onClick={() => {
              setFitNonce((n) => n + 1);
            }}
            className="absolute left-2 top-2 z-10 rounded border border-[#c4cfc6] bg-[#f3f6f3]/95 p-1.5 text-[#1f2d3a] shadow-xs hover:bg-[#dfe8e0]"
          >
            <Home className="h-4 w-4" />
          </button>
          {meshQuery.isLoading && <Overlay spinner text="Meshing the part's wall mid-surface…" />}
          {meshQuery.error && !mesh && <Overlay text={`This part could not be meshed. ${reasonOf(meshQuery.error)}`} />}
          {runMutation.isPending && <Overlay spinner text="Filling the cavity…" />}
          {mesh?.triangles.length === 0 && <Overlay text="This part has no thin wall the simulation can mesh (a solid block or a bar)." />}
          {mesh && mesh.triangles.length > 0 && report?.canSimulate && !form.gate && tab === "setup" && !runMutation.isPending && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded bg-white/90 px-3 py-1.5 text-xs font-medium text-[#1f2d3a] shadow-xs">
              Click the part where the gate goes
            </div>
          )}
        </div>
        {run && (
          <div className="flex shrink-0 items-center gap-2 border-t bg-background px-3 py-2">
            <Button
              type="button" variant="outline" size="icon" className="h-8 w-8" aria-label={playing ? "Pause" : "Play"}
              onClick={() => {
                if (!playing && time >= total) seek(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              type="button" variant="outline" size="icon" className="h-8 w-8" aria-label="Back to the start"
              onClick={() => {
                setPlaying(false);
                seek(0);
              }}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <input
              type="range" min={0} max={total} step={total / 500} value={time} aria-label="Fill time"
              onChange={(e) => {
                setPlaying(false);
                seek(Number(e.target.value));
              }}
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
            />
            <span className="w-36 shrink-0 text-right text-xs tabular-nums text-foreground">
              {formatValue(time, 3)} s / {formatValue(total, 3)} s
            </span>
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{total > 0 ? Math.round((100 * time) / total) : 0}%</span>
          </div>
        )}
      </div>

      <aside className="flex w-[360px] shrink-0 flex-col border-l bg-background">
        <Tabs value={tab} onValueChange={(v) => { setTab(v === "results" ? "results" : "setup"); }} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="m-2 grid shrink-0 grid-cols-2">
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="results" disabled={!run}>Results</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {failure && (
              <Notice tone="error" text={reasonOf(failure)} />
            )}
            {cannotRun && <Notice tone="error" text="The mesh cannot be simulated. See the mesh issues under Setup." />}
            <TabsContent value="setup" className="m-0 space-y-3 px-3 pb-4">
              <SetupPanel
                form={form} setForm={setForm} report={report} wallMm={mesh ? scaleOf(mesh.thicknessMm, false) : null}
                suggestions={suggestions} notes={inputsQuery.data?.notes ?? []} material={inputsQuery.data?.referenceMaterial ?? inputsQuery.data?.materialGrade ?? null}
                meshing={meshQuery.isLoading}
              />
              {built.missing.length > 0 && (
                <p className="text-[11px] leading-snug text-muted-foreground">Still needed: {built.missing.join("; ")}.</p>
              )}
              {report && !report.canSimulate && <p className="text-[11px] leading-snug text-red-500">This part cannot be simulated: see the mesh notes above.</p>}
              <Button type="button" className="h-9 w-full" disabled={!built.request || runMutation.isPending || !report?.canSimulate} onClick={start}>
                {runMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {run ? "Run again" : "Run simulation"}
              </Button>
            </TabsContent>
            <TabsContent value="results" className="m-0 space-y-3 px-3 pb-4">
              {run && (
                <ResultsPanel
                  run={run} kind={kind} setKind={setKind} scale={scale} time={time} show={show} setShow={setShow} stale={stale}
                />
              )}
            </TabsContent>
          </div>
        </Tabs>
      </aside>
    </div>
  );
}

function Overlay({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/40 px-10 text-center text-xs font-medium text-[#1f2d3a]" role={spinner ? "status" : undefined}>
      {spinner && <Loader2 className="h-4 w-4 animate-spin" />}
      {text}
    </div>
  );
}

const TONE = {
  error: { icon: CircleAlert, className: "text-red-500" },
  warning: { icon: AlertTriangle, className: "text-amber-500" },
  info: { icon: Info, className: "text-muted-foreground" },
} as const;

function Notice({ tone, text }: { tone: FillIssue["severity"]; text: string }) {
  const Icon = TONE[tone].icon;
  return (
    <div className="mx-3 mb-2 flex items-start gap-2 rounded border border-border bg-card px-2 py-1.5 text-[11px] leading-snug text-foreground">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE[tone].className}`} />
      <span>{text}</span>
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return <h3 className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="flex-1 truncate text-xs text-muted-foreground">{label}</span>
      <span className={`text-right text-xs tabular-nums ${strong ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>{value}</span>
    </div>
  );
}

function Field({ id, label, unit, value, onChange, placeholder, suggestion }: {
  id: string; label: string; unit?: string; value: string; onChange: (v: string) => void; placeholder?: string;
  /** The value the reference data or the cost engine gives for this field, and where from. */
  suggestion?: { value: string; source: string } | undefined;
}) {
  const own = suggestion !== undefined && value.trim() !== "" && value.trim() !== suggestion.value;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="flex-1 text-xs font-normal text-muted-foreground">{label}</Label>
        <Input
          id={id} inputMode="decimal" value={value} placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className="h-7 w-28 px-2 text-right text-xs tabular-nums"
        />
        <span className="w-9 text-[10px] text-muted-foreground">{unit ?? ""}</span>
      </div>
      {suggestion && (
        <p className="pr-11 text-right text-[10px] leading-tight text-muted-foreground">
          {own ? (
            <>
              Recommended {suggestion.value}{unit ? ` ${unit}` : ""} ({suggestion.source}).{" "}
              <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => { onChange(suggestion.value); }}>Use it</button>
            </>
          ) : `From ${suggestion.source}`}
        </p>
      )}
    </div>
  );
}

function SetupPanel({ form, setForm, report, wallMm, suggestions, notes, material, meshing }: {
  form: SetupForm;
  setForm: (update: (f: SetupForm) => SetupForm) => void;
  report: FillMeshReport | null;
  wallMm: { min: number; max: number } | null;
  suggestions: Suggestions;
  /** What the reference data could not give, and why. */
  notes: readonly string[];
  material: string | null;
  meshing: boolean;
}) {
  const set = (key: keyof SetupForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };
  const suggested = (key: SuggestedField) => suggestions[key];
  return (
    <>
      <Heading>Mesh</Heading>
      {report ? (
        <div>
          <Row label="Triangles (wall mid-surface)" value={formatValue(report.trianglesInMesh, 0)} />
          {wallMm && <Row label="Wall thickness" value={wallMm.max - wallMm.min < 0.01 ? `${formatValue(wallMm.min, 2)} mm` : `${formatValue(wallMm.min, 2)} to ${formatValue(wallMm.max, 2)} mm`} />}
          <Row label="Largest element edge" value={`${formatValue(report.longestEdgeMm, 1)} mm`} />
          {report.volumeRatio !== null && <Row label="Mesh volume against CAD" value={`${formatValue(100 * report.volumeRatio, 1)}%`} />}
          {report.detachedPieces > 0 && <Row label="Ribs and bosses left out" value={`${formatValue(report.detachedVolumePct, 1)}% of volume`} />}
          <div className="-mx-3 pt-1">{report.issues.map((issue) => <Notice key={issue.code} tone="warning" text={issue.message} />)}</div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{meshing ? "Meshing…" : "Not meshed."}</p>
      )}

      <Heading>Gate</Heading>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs tabular-nums text-foreground">
          {form.gate ? `x ${formatValue(form.gate[0], 1)}  y ${formatValue(form.gate[1], 1)}  z ${formatValue(form.gate[2], 1)} mm` : "Not placed: click the part"}
        </span>
        {form.gate && (
          <Button type="button" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setForm((f) => ({ ...f, gate: null })); }}>Clear</Button>
        )}
      </div>

      <Heading>{material ? `Process (${material})` : "Process"}</Heading>
      {notes.length > 0 && <div className="-mx-3">{notes.map((note) => <Notice key={note} tone="info" text={note} />)}</div>}
      <div className="space-y-1.5">
        <Field id="fs-fill" label="Fill time" unit="s" value={form.fillTimeS} onChange={set("fillTimeS")} suggestion={suggested("fillTimeS")} />
        <Field id="fs-melt" label="Melt temperature" unit="°C" value={form.meltTempC} onChange={set("meltTempC")} suggestion={suggested("meltTempC")} />
        <Field
          id="fs-limit" label="Injection pressure available" unit="MPa" value={form.maxInjectionPressureMpa} onChange={set("maxInjectionPressureMpa")}
          suggestion={suggested("maxInjectionPressureMpa")} {...(form.viscosity === "crossWlf" ? { placeholder: "optional" } : {})}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="fs-pull" className="flex-1 text-xs font-normal text-muted-foreground">Mold opening axis</Label>
          <select
            id="fs-pull" value={form.pullAxis}
            onChange={(e) => {
              const v = e.target.value;
              setForm((f) => ({ ...f, pullAxis: v === "x" || v === "y" || v === "z" ? v : "" }));
            }}
            className="h-7 w-28 rounded border border-border bg-background px-1.5 text-xs text-foreground"
          >
            <option value="">Automatic</option>
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
          <span className="w-9" />
        </div>
      </div>

      <Heading>Melt viscosity</Heading>
      <select
        id="fs-viscosity" aria-label="How the melt's viscosity is given" value={form.viscosity}
        onChange={(e) => {
          const v = e.target.value === "crossWlf" ? "crossWlf" : "estimate";
          setForm((f) => ({ ...f, viscosity: v }));
        }}
        className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground"
      >
        <option value="estimate">Estimated from the grade&apos;s flow length ratio</option>
        <option value="crossWlf">The grade&apos;s Cross-WLF constants</option>
      </select>
      {form.viscosity === "estimate" ? (
        <div className="space-y-1.5">
          <Field id="fs-ratio" label="Flow length ratio (L/t)" value={form.flowLengthRatio} onChange={set("flowLengthRatio")} suggestion={suggested("flowLengthRatio")} />
          <p className="text-[11px] leading-snug text-muted-foreground">
            One viscosity is set so that a part at the grade&apos;s flow length limit needs exactly the pressure available. The fill pattern, weld lines and air traps
            do not depend on it; the pressure is an estimate against that limit. For a pressure from the grade&apos;s real viscosity curve, switch to its Cross-WLF constants.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-snug text-muted-foreground">From the grade&apos;s datasheet or its rheology record. The reference data holds none, so these are entered by hand.</p>
          <Field id="fs-n" label="n" value={form.n} onChange={set("n")} />
          <Field id="fs-tau" label="τ*" unit="Pa" value={form.tauPa} onChange={set("tauPa")} />
          <Field id="fs-d1" label="D1" unit="Pa·s" value={form.d1PaS} onChange={set("d1PaS")} />
          <Field id="fs-d2" label="D2" unit="K" value={form.d2K} onChange={set("d2K")} />
          <Field id="fs-a1" label="A1" value={form.a1} onChange={set("a1")} />
          <Field id="fs-a2" label="A2" unit="K" value={form.a2K} onChange={set("a2K")} />
        </div>
      )}
    </>
  );
}

function ResultsPanel({ run, kind, setKind, scale, time, show, setShow, stale }: {
  run: FillRun;
  kind: ResultKind;
  setKind: (k: ResultKind) => void;
  scale: { min: number; max: number; top: number } | null;
  time: number;
  show: { arrows: boolean; weldLines: boolean; endOfFill: boolean };
  setShow: (update: (s: { arrows: boolean; weldLines: boolean; endOfFill: boolean }) => { arrows: boolean; weldLines: boolean; endOfFill: boolean }) => void;
  stale: boolean;
}) {
  const spec = specOf(kind);
  const s = run.summary;
  const curve = useMemo(
    () => run.curve.timeS.map((t, i) => ({ t, p: run.curve.inletPressureMpa[i] ?? 0, f: run.curve.filledFraction[i] ?? 0 })).filter((point) => point.f <= run.inputs.switchover),
    [run],
  );
  return (
    <>
      {stale && <Notice tone="info" text="The setup has changed since this run. Run again to see it." />}
      <Row label="Stage" value="Filling" />
      <div className="flex items-center gap-2">
        <Label htmlFor="fs-result" className="text-xs font-normal text-muted-foreground">Result</Label>
        <select
          id="fs-result" value={kind}
          onChange={(e) => {
            const next = RESULTS.find((r) => r.kind === e.target.value);
            if (next) setKind(next.kind);
          }}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs text-foreground"
        >
          {RESULTS.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
        </select>
      </div>

      {scale && (
        <div>
          <Heading>{`${spec.label} (${spec.unit})`}</Heading>
          <Row label="Max" value={`${formatValue(scale.max, spec.digits)} ${spec.unit}`} />
          <div className="my-1 flex h-52 gap-2">
            <div className="w-4 shrink-0 rounded-sm border border-border" style={{ background: legendGradient() }} />
            <div className="flex flex-col justify-between text-[11px] tabular-nums text-foreground">
              {legendTicks(scale).map((tick, i) => <span key={i} className="leading-none">{formatValue(tick, spec.digits)} {spec.unit}</span>)}
            </div>
          </div>
          <Row label="Min" value={`${formatValue(scale.min, spec.digits)} ${spec.unit}`} />
          {spec.capped && scale.top < scale.max && (
            <p className="text-[11px] leading-snug text-muted-foreground">The colours run to the 98th percentile: the few highest points sit at the gate, a point source.</p>
          )}
          <p className="pt-1 text-[11px] leading-snug text-muted-foreground">{spec.note}</p>
        </div>
      )}

      <Heading>Show</Heading>
      <Toggle id="fs-arrows" label="Flow direction arrows" swatch="bg-slate-900" checked={show.arrows} onChange={(v) => { setShow((x) => ({ ...x, arrows: v })); }} />
      <Toggle id="fs-welds" label="Weld lines" swatch="bg-white ring-2 ring-slate-900" checked={show.weldLines} onChange={(v) => { setShow((x) => ({ ...x, weldLines: v })); }} />
      <Toggle id="fs-ends" label="End of fill (red: air trap)" swatch="bg-red-600" checked={show.endOfFill} onChange={(v) => { setShow((x) => ({ ...x, endOfFill: v })); }} />
      <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"><span className="h-2.5 w-2.5 rounded-full bg-fuchsia-500" />Gate</div>

      <Heading>Fill summary</Heading>
      <div>
        <Row label="Fill time" value={`${formatValue(s.fillTimeS, 3)} s`} strong />
        <Row label="Injection pressure at V/P switchover" value={`${formatValue(s.switchoverPressureMpa, 1)} MPa`} strong />
        <Row label="Flow rate" value={`${formatValue(s.flowRateMm3S / 1000, 1)} cm³/s`} />
        <Row label="Melt-front speed (median)" value={`${formatValue(s.frontSpeedMedianMmS, 0)} mm/s`} />
        <Row label="Peak shear stress at wall" value={`${formatValue(s.wallShearStressPeakMpa, 3)} MPa`} />
        <Row label="Peak shear rate at wall" value={`${formatValue(s.wallShearRatePeakPerS, 0)} 1/s`} />
        <Row label="Clamp force while filling (one cavity)" value={s.clampForceT === null ? "set the opening axis" : `${formatValue(s.clampForceT, 1)} t`} />
        {run.inputs.pull && <Row label="Mold opening axis" value={`${axisName(run.inputs.pull.vector)}${run.inputs.pull.source === "automatic" ? " (automatic)" : ""}`} />}
        <Row
          label="Melt viscosity"
          value={run.inputs.viscosity.model === "cross_wlf" ? "Cross-WLF" : `${formatValue(run.inputs.viscosity.effectiveViscosityPaS, 0)} Pa·s (estimate)`}
        />
        <Row label="Weld line length" value={`${formatValue(s.weldLineLengthMm, 0)} mm`} />
        <Row label="Air traps" value={String(s.airTraps)} />
        <Row label="Volume not filled" value={`${formatValue(s.unfilledVolumePct, 1)}%`} />
      </div>

      <Heading>Injection pressure at the gate (MPa), to V/P switchover</Heading>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={curve} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} tickFormatter={(v: number) => formatValue(v, 2)} unit=" s" />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatValue(v, 0)} />
            <Tooltip
              cursor={{ stroke: "hsl(var(--border))" }}
              contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11 }}
              formatter={(value) => [`${formatValue(Number(value), 1)} MPa`, "Pressure"]}
              labelFormatter={(label) => `${formatValue(Number(label), 3)} s`}
            />
            <ReferenceLine x={Math.min(time, curve[curve.length - 1]?.t ?? time)} stroke="hsl(var(--foreground))" strokeOpacity={0.5} />
            <Line type="linear" dataKey="p" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <Heading>Issues</Heading>
      {run.issues.length === 0 ? (
        <p className="text-xs text-muted-foreground">None found by the filling analysis.</p>
      ) : (
        <div className="-mx-3">{run.issues.map((issue) => <Notice key={issue.code} tone={issue.severity} text={issue.message} />)}</div>
      )}

      <Heading>What this run assumes</Heading>
      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
        {run.assumptions.map((line) => <li key={line}>{line}</li>)}
        <li>Not checked against a molded part yet: read the numbers as a comparison between designs, not as a guarantee.</li>
      </ul>
    </>
  );
}

/** X, Y or Z for a direction along an axis; its components otherwise. */
function axisName(vector: Vec3): string {
  const along = vector.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-3);
  return along >= 0 ? (["X", "Y", "Z"][along] ?? "") : vector.map((c) => formatValue(c, 2)).join(", ");
}

function Toggle({ id, label, swatch, checked, onChange }: { id: string; label: string; swatch: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${swatch}`} />
      <Label htmlFor={id} className="flex-1 text-xs font-normal text-foreground">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

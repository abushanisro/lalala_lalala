'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Line,
  AreaChart,
  Area,
  ComposedChart,
  DefaultZIndexes,
  Legend
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { BarChart3, FolderKanban } from '@/components/ui/icons';
import { projectTrend } from '@/lib/dashboard/project-trend';

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

export const TOOLTIP_STYLE = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '12px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
};

export const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 12 };

// Semrush-style axis title, rotated along a Y axis.
function axisTitle(value: string, side: 'left' | 'right') {
  return {
    value,
    angle: side === 'left' ? -90 : 90,
    position: side === 'left' ? ('insideLeft' as const) : ('insideRight' as const),
    style: { fill: 'hsl(var(--muted-foreground))', fontSize: 12, textAnchor: 'middle' as const },
  };
}

// recharts 3 draws a grid only against a Y axis it names; a chart with several Y axes passes the one the grid follows.
function grid(yAxisId?: string) {
  return yAxisId === undefined
    ? <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
    : <CartesianGrid yAxisId={yAxisId} vertical={false} stroke="hsl(var(--border))" />;
}

// recharts 3 sorts tooltip rows by name; a constant key keeps them in the order the series are declared.
const keepSeriesOrder = () => 0;

const LEGEND_PROPS = {
  // recharts 3 sorts legend items too; null keeps the declared order.
  itemSorter: null,
  verticalAlign: 'top' as const,
  align: 'left' as const,
  iconType: 'square' as const,
  iconSize: 12,
  wrapperStyle: { paddingBottom: 16, fontSize: 14 },
};

interface CostChartProps {
  projects: Array<{
    name?: string;
    targetPrice?: number | string;
    shouldCost?: number | string;
    status?: string;
    createdAt?: string;
  }>;
}

export function CostChart({ projects }: CostChartProps) {
  if (!projects || projects.length === 0) {
    return (
      <div className="h-72 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <BarChart3 className="mb-2 h-10 w-10 opacity-50" />
          <p className="text-sm">No project data available for cost analysis</p>
        </div>
      </div>
    );
  }

  const chartData = projects.slice(0, 8).map((p) => ({
    name: p.name?.substring(0, 15) || 'Unnamed',
    targetPrice: Number(p.targetPrice) || 0,
    shouldCost: Number(p.shouldCost) || 0,
    savings: (Number(p.targetPrice) || 0) - (Number(p.shouldCost) || 0),
    savingsPercent: Number(p.targetPrice) ? (((Number(p.targetPrice) - Number(p.shouldCost)) / Number(p.targetPrice)) * 100) : 0
  }));

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart accessibilityLayer={false} data={chartData} margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
          {grid('cost')}
          <XAxis dataKey="name" tick={AXIS_TICK} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} tickMargin={10} />
          <YAxis
            yAxisId="cost"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={72}
            tickFormatter={(v) => `$${(v / 100000).toFixed(1)}L`}
            label={axisTitle('BOM Cost', 'left')}
          />
          <YAxis
            yAxisId="percent"
            orientation="right"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={64}
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            label={axisTitle('Savings %', 'right')}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--border))' }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => {
              if (name === 'Savings %') return [`${Number(value).toFixed(1)}%`, name];
              return [`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name];
            }}
            itemSorter={keepSeriesOrder}
          />
          <Legend {...LEGEND_PROPS} />
          <Line yAxisId="cost" type="linear" dataKey="targetPrice" name="Target Price" stroke="hsl(var(--chart-4))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          <Line yAxisId="cost" type="linear" dataKey="shouldCost" name="Should Cost" stroke="hsl(var(--chart-1))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          <Line yAxisId="percent" type="linear" dataKey="savingsPercent" name="Savings %" stroke="hsl(var(--chart-3))" strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface StatusPieChartProps {
  statusDistribution: Array<{
    label: string;
    count: number;
  }>;
}

export function StatusPieChart({ statusDistribution }: StatusPieChartProps) {
  const total = statusDistribution.reduce((sum, item) => sum + item.count, 0);
  const dataWithPercentage = statusDistribution.map(item => ({
    ...item,
    percentage: ((item.count / total) * 100).toFixed(1)
  }));

  return (
    <div className="space-y-4">
      <div className="relative h-48">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer={false}>
            <Pie
              data={dataWithPercentage}
              cx="50%"
              cy="85%"
              startAngle={180}
              endAngle={0}
              innerRadius={70}
              outerRadius={96}
              paddingAngle={3}
              cornerRadius={6}
              stroke="none"
              dataKey="count"
              nameKey="label"
            >
              {dataWithPercentage.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  // The index is always inside the palette; recharts 3 no longer takes an undefined fill.
                  fill={CHART_COLORS[index % CHART_COLORS.length] ?? ''}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '12px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              }}
              formatter={(value, name) => [`${String(value)} projects`, name]}
              // recharts 3 colours a pie's tooltip row like its slice; it was black before.
              itemStyle={{ color: '#000' }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-x-0 bottom-[12%] text-center">
          <p className="text-3xl font-semibold tabular-nums text-primary">{total}</p>
          <p className="text-xs text-muted-foreground">projects</p>
        </div>
      </div>

      <div className="space-y-2">
        {dataWithPercentage.map((item, index) => (
          <div key={item.label} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div 
                className="h-2.5 w-2.5 rounded-full" 
                style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
              />
              <span className="text-muted-foreground">{item.label}</span>
            </div>
            <div className="text-right">
              <span className="font-medium tabular-nums text-primary">{item.count}</span>
              <span className="text-muted-foreground ml-1">({item.percentage}%)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// New comprehensive analytics charts
export function ProjectTrendChart({ projects }: { projects: any[] }) {
  // recharts 3 replays the area's animation whenever it is handed a new data array, even one with the same values.
  // The rows are therefore rebuilt only when the projects change.
  const trend = useMemo(() => projectTrend(projects), [projects]);

  return (
    <>
      {/* The period follows the projects (30 days, 12 months, or since the first one), so the chart names it here. */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Project creation trends and volume</p>
        <Badge variant="outline" className="shrink-0 whitespace-nowrap">{trend.period}</Badge>
      </div>
      {projects.length === 0 ? (
        <EmptyState icon={FolderKanban} title="No projects yet" description="Each project shows here on the day it was created" className="h-80 py-0" />
      ) : (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart accessibilityLayer={false} data={trend.buckets} margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="colorProjects" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              {grid()}
              <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} tickMargin={10} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} allowDecimals={false} label={axisTitle('New Projects', 'left')} />
              <Tooltip cursor={{ stroke: 'hsl(var(--border))' }} contentStyle={TOOLTIP_STYLE} />
              <Legend {...LEGEND_PROPS} />
              <Area
                type="linear"
                dataKey="projects"
                stroke="hsl(var(--chart-1))"
                strokeWidth={2.5}
                fillOpacity={1}
                fill="url(#colorProjects)"
                name="New Projects"
                dot={false}
                activeDot={{ r: 4 }}
                // recharts 3 draws the hover line over the area; recharts 2 drew it behind.
                zIndex={DefaultZIndexes.cursorLine + 1}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}

export function EfficiencyGaugeChart({ efficiency }: { efficiency: number }) {
  const data = [
    { name: 'Efficiency', value: efficiency },
    { name: 'Remaining', value: 100 - efficiency }
  ];

  return (
    <div className="h-32">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart accessibilityLayer={false}>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            startAngle={180}
            endAngle={0}
            innerRadius={40}
            outerRadius={60}
            dataKey="value"
          >
            <Cell fill="hsl(var(--chart-1))" />
            <Cell fill="hsl(var(--muted))" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// Manufacturing Analytics Dashboard Charts
export function ManufacturingPerformanceChart({ modules }: { modules: any[] }) {
  const performanceData = modules.map(module => ({
    name: module.title.replace(' Management', '').replace(' & ', ' '),
    active: module.stats.active,
    total: module.stats.total,
    efficiency: ((module.stats.active / module.stats.total) * 100) || 0,
    value: module.stats.value == null ? null : module.stats.value / 100000, // Preserve unresolved values
  }));

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart accessibilityLayer={false} data={performanceData} margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
          {grid('count')}
          <XAxis
            dataKey="name"
            tick={{ ...AXIS_TICK, fontSize: 11 }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            tickLine={false}
            tickMargin={10}
            interval={0}
          />
          <YAxis yAxisId="count" tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} allowDecimals={false} label={axisTitle('Projects', 'left')} />
          <YAxis
            yAxisId="percent"
            orientation="right"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={64}
            domain={[0, 100]}
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            label={axisTitle('Efficiency', 'right')}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--border))' }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => {
              if (name === 'Efficiency') return [`${Number(value).toFixed(1)}%`, name];
              if (name === 'Value') return [`$${Number(value).toFixed(1)}L`, name];
              return [value, name];
            }}
            itemSorter={keepSeriesOrder}
          />
          <Legend {...LEGEND_PROPS} />
          <Line yAxisId="count" type="linear" dataKey="active" name="Active" stroke="hsl(var(--chart-1))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          <Line yAxisId="count" type="linear" dataKey="total" name="Total" stroke="hsl(var(--chart-4))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          <Line yAxisId="percent" type="linear" dataKey="efficiency" name="Efficiency" stroke="hsl(var(--chart-3))" strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CostSavingsChart({ projects }: { projects: any[] }) {
  // Always show chart with available data, even if incomplete
  const savingsData = projects
    .map(p => {
      const targetPrice = Number(p.targetPrice) || 0;
      const shouldCost = Number(p.shouldCost) || 0;
      const savings = targetPrice - shouldCost;
      const savingsPercent = targetPrice > 0 ? ((savings / targetPrice) * 100) : 0;
      
      return {
        name: p.name?.substring(0, 12) || `Project ${p.id?.slice(-4) || Math.random().toString(36).slice(-4)}`,
        targetPrice,
        shouldCost,
        savings,
        savingsPercent,
        hasData: targetPrice > 0 || shouldCost > 0,
        fillColor: savings >= 0 ? 'hsl(var(--chart-3))' : 'hsl(var(--destructive))'
      };
    })
    .filter(p => p.hasData)
    .slice(0, 6);


  // If no projects with cost data, show projects with placeholder data
  if (savingsData.length === 0 && projects.length > 0) {
    const placeholderData = projects.slice(0, 6).map((p, index) => ({
      name: p.name?.substring(0, 12) || `Project ${index + 1}`,
      targetPrice: 0,
      shouldCost: 0,
      savings: 0,
      savingsPercent: 0,
      hasData: false,
      fillColor: 'hsl(var(--muted))'
    }));

    return (
      <div className="h-64 relative">
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-background/80 backdrop-blur-xs">
          <div className="text-center">
            <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-950/20 flex items-center justify-center mx-auto mb-3">
              <div className="text-xl font-bold text-green-600">$</div>
            </div>
            <p className="text-sm font-medium">Add cost data to see savings analysis</p>
            <p className="text-xs text-muted-foreground mt-1">Enter target price and should cost in projects</p>
          </div>
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={placeholderData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.7} />
            <XAxis 
              dataKey="name" 
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
              axisLine={false} tickLine={false}
            />
            <YAxis 
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
              tickFormatter={() => '$0'}
              axisLine={false} tickLine={false}
            />
            <Bar dataKey="savings" fill="hsl(var(--muted))" radius={[2, 2, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-950/20 flex items-center justify-center mx-auto mb-3">
            <div className="text-xl font-bold text-green-600">$</div>
          </div>
          <p className="text-sm">No projects available</p>
          <p className="text-xs text-muted-foreground mt-1">Create projects to see cost savings analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          accessibilityLayer={false}
          data={savingsData}
          margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.7} />
          <XAxis 
            dataKey="name" 
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
            axisLine={false} tickLine={false}
          />
          <YAxis 
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
            tickFormatter={(v) => {
              const absV = Math.abs(v);
              if (absV >= 100000) return `$${(v / 100000).toFixed(1)}L`;
              if (absV >= 1000) return `$${(v / 1000).toFixed(1)}K`;
              return `$${v.toFixed(0)}`;
            }}
            axisLine={false} tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '12px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}
            formatter={(value, name) => {
              if (name === 'Cost Savings') {
                const numValue = Number(value);
                const sign = numValue >= 0 ? 'Savings' : 'Overspend';
                return [`$${Math.abs(numValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${sign})`, name];
              }
              return [`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name];
            }}
            // recharts 3 types the label as any React node, so it is placed as a child rather than turned into a string.
            labelFormatter={(label) => <>Project: {label}</>}
          />
          <Bar 
            dataKey="savings" 
            name="Cost Savings" 
            fill="hsl(var(--chart-3))"
            radius={[2, 2, 0, 0]} maxBarSize={32}
          >
            {savingsData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.fillColor} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
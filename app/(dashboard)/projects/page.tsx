'use client';

import { Country, State, City } from 'country-state-city';
import { format, formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';

import { StatusBadge } from '@/components/common/status-badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Plus,
  FolderKanban,
  Clock,
  CheckCircle2,
  Trash2,
  ArrowRight,
  Pause,
  XCircle,
  Pencil,
  Settings,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableSkeleton } from '@/components/ui/loading-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useProjects, useCreateProject, useUpdateProject, useDeleteProject } from '@/lib/api/hooks/useProjects';
import { formatProjectMoney, projectCostCurrency, projectSavings } from '@/lib/costing/project-costs';
import { cn } from '@/lib/utils';

const PROJECT_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function Projects() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<any>(null);
  const [projectToEdit, setProjectToEdit] = useState<any>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'draft' | 'active' | 'completed' | 'on_hold' | 'cancelled'>('draft');
  const [industry, setIndustry] = useState('');
  const [estimatedAnnualVolume, setEstimatedAnnualVolume] = useState('');
  const [targetBomCost, setTargetBomCost] = useState('');
  const [targetBomCostCurrency, setTargetBomCostCurrency] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [stateCode, setStateCode] = useState('');
  
  // Location options for the searchable comboboxes. All countries / all of a
  // country's states / all of a state's cities -- sorted, never truncated.
  const countryOptions = useMemo<ComboboxOption[]>(
    () =>
      Country.getAllCountries()
        .map((c) => ({ value: c.isoCode, label: c.name, keywords: [c.isoCode] }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );
  const availableStates = useMemo(
    () => (countryCode ? State.getStatesOfCountry(countryCode) : []),
    [countryCode],
  );
  const stateOptions = useMemo<ComboboxOption[]>(
    () =>
      availableStates
        .map((s) => ({ value: s.isoCode, label: s.name, keywords: [s.isoCode] }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [availableStates],
  );
  const cityOptions = useMemo<ComboboxOption[]>(
    () =>
      countryCode && stateCode
        ? City.getCitiesOfState(countryCode, stateCode)
            .map((c) => ({ value: c.name, label: c.name }))
            .sort((a, b) => a.label.localeCompare(b.label))
        : [],
    [countryCode, stateCode],
  );
  // The country-state-city dataset has no states for some countries and no
  // cities for some states. In those cases we fall back to a free-text input
  // so the user is never stuck.
  const statesListed = !!countryCode && stateOptions.length > 0;
  const citiesListed = !!stateCode && cityOptions.length > 0;

  // Open dialog if ?new=true in URL
  useEffect(() => {
    if (searchParams?.get('new') === 'true') {
      setCreateOpen(true);
      router.replace('/projects');
    }
  }, [searchParams, router]);

  const { data: projectsData, isLoading } = useProjects();
  const createMutation = useCreateProject();
  const updateMutation = useUpdateProject();
  const deleteMutation = useDeleteProject();

  const projects = projectsData?.projects || [];

  // Handle country selection
  // (Combobox passes '' when the user clicks the already-selected option,
  // which clears the field and everything below it.)
  const handleCountryChange = (value: string) => {
    const selectedCountry = countryOptions.find(c => c.value === value);
    setCountryCode(selectedCountry ? value : '');
    setCountry(selectedCountry ? selectedCountry.label : '');
    setStateCode('');
    setState('');
    setCity('');
  };

  // Handle state selection
  const handleStateChange = (value: string) => {
    const selectedState = stateOptions.find(s => s.value === value);
    setStateCode(selectedState ? value : '');
    setState(selectedState ? selectedState.label : '');
    setCity('');
  };

  // Handle city selection
  const handleCityChange = (value: string) => {
    setCity(cityOptions.some(c => c.value === value) ? value : '');
  };

  // Country / State / City fields, shared by the Create and Edit dialogs.
  // idPrefix keeps the element ids unique ('' for create, 'edit-' for edit).
  const renderLocationFields = (idPrefix: string) => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div>
        <Label htmlFor={`${idPrefix}country`} className="text-sm font-medium">Country</Label>
        <Combobox
          id={`${idPrefix}country`}
          modal
          className="mt-2 h-11"
          options={countryOptions}
          value={countryCode}
          onValueChange={handleCountryChange}
          placeholder="Select country"
          searchPlaceholder="Search country..."
          emptyText="No country found."
        />
      </div>

      <div>
        <Label htmlFor={`${idPrefix}state`} className="text-sm font-medium">State/Province</Label>
        {countryCode && !statesListed ? (
          <Input
            id={`${idPrefix}state`}
            className="mt-2 h-11"
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder="Enter state/province"
          />
        ) : (
          <Combobox
            id={`${idPrefix}state`}
            modal
            className="mt-2 h-11"
            options={stateOptions}
            value={stateCode}
            onValueChange={handleStateChange}
            disabled={!countryCode}
            placeholder={countryCode ? 'Select state' : 'Select country first'}
            searchPlaceholder="Search state..."
            emptyText="No state found."
          />
        )}
      </div>

      <div>
        <Label htmlFor={`${idPrefix}city`} className="text-sm font-medium">City</Label>
        {(stateCode && !citiesListed) || (countryCode && !statesListed) ? (
          <Input
            id={`${idPrefix}city`}
            className="mt-2 h-11"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Enter city"
          />
        ) : (
          <Combobox
            id={`${idPrefix}city`}
            modal
            className="mt-2 h-11"
            options={cityOptions}
            value={city}
            onValueChange={handleCityChange}
            disabled={!stateCode}
            placeholder={stateCode ? 'Select city' : 'Select state first'}
            searchPlaceholder="Search city..."
            emptyText="No city found."
          />
        )}
      </div>
    </div>
  );

  const handleCreate = () => {
    createMutation.mutate(
      {
        name,
        status,
        targetBomCostCurrency,
        ...(description ? { description } : {}),
        ...(industry ? { industry } : {}),
        ...(estimatedAnnualVolume ? { estimatedAnnualVolume: parseInt(estimatedAnnualVolume) } : {}),
        ...(targetBomCost ? { targetBomCost: parseFloat(targetBomCost) } : {}),
        ...(country ? { country } : {}),
        ...(state ? { state } : {}),
        ...(city ? { city } : {}),
      },
      {
        onSuccess: (data) => {
          setCreateOpen(false);
          setName('');
          setDescription('');
          setIndustry('');
          setEstimatedAnnualVolume('');
          setTargetBomCost('');
          setTargetBomCostCurrency('');
          setCountry('');
          setState('');
          setCity('');
          setCountryCode('');
          setStateCode('');
          router.push(`/projects/${data.id}`);
        },
      }
    );
  };

  const handleDelete = () => {
    if (!projectToDelete) return;

    deleteMutation.mutate(projectToDelete.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        setProjectToDelete(null);
      },
    });
  };

  const handleEditOpen = (project: any) => {
    setProjectToEdit(project);
    setName(project.name);
    setDescription(project.description || '');
    setStatus(project.status);
    setIndustry(project.industry || '');
    setEstimatedAnnualVolume(project.estimatedAnnualVolume ? project.estimatedAnnualVolume.toString() : '');
    setTargetBomCost(project.targetBomCost ? project.targetBomCost.toString() : '');
    setTargetBomCostCurrency(project.targetBomCostCurrency || '');
    setCountry(project.country || '');
    setState(project.state || '');
    setCity(project.city || '');
    
    // Set codes for dropdowns if data exists
    if (project.country) {
      const selectedCountry = Country.getAllCountries().find(c => c.name === project.country);
      if (selectedCountry) {
        setCountryCode(selectedCountry.isoCode);
      }
    }
    if (project.state && project.country) {
      const selectedCountry = Country.getAllCountries().find(c => c.name === project.country);
      if (selectedCountry) {
        const states = State.getStatesOfCountry(selectedCountry.isoCode);
        const selectedState = states.find(s => s.name === project.state);
        if (selectedState) {
          setStateCode(selectedState.isoCode);
        }
      }
    }
    
    setEditOpen(true);
  };

  const handleUpdate = () => {
    if (!projectToEdit) return;

    updateMutation.mutate(
      {
        id: projectToEdit.id,
        data: {
          name,
          status,
          ...(description ? { description } : {}),
          ...(industry ? { industry } : {}),
          ...(estimatedAnnualVolume ? { estimatedAnnualVolume: parseInt(estimatedAnnualVolume) } : {}),
          ...(targetBomCost ? { targetBomCost: parseFloat(targetBomCost) } : {}),
          ...(targetBomCostCurrency ? { targetBomCostCurrency } : {}),
          ...(country ? { country } : {}),
          ...(state ? { state } : {}),
          ...(city ? { city } : {}),
        },
      },
      {
        onSuccess: () => {
          setEditOpen(false);
          setProjectToEdit(null);
          setName('');
          setDescription('');
          setStatus('draft');
          setIndustry('');
          setEstimatedAnnualVolume('');
          setTargetBomCost('');
          setTargetBomCostCurrency('');
          setCountry('');
          setState('');
          setCity('');
          setCountryCode('');
          setStateCode('');
        },
      }
    );
  };

  const stats = {
    total: projects.length,
    active: projects.filter((p) => p.status === 'active').length,
    draft: projects.filter((p) => p.status === 'draft').length,
    completed: projects.filter((p) => p.status === 'completed').length,
  };


  // Figures for the four summary cards, all read from the loaded project list.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const withinWeek = (iso?: string) => !!iso && now - new Date(iso).getTime() <= WEEK_MS;
  const byStatus = (st: string) => projects.filter((p) => p.status === st);
  const activeProjects = byStatus('active');
  const draftProjects = byStatus('draft');
  const pct = (n: number) => (stats.total > 0 ? (n / stats.total) * 100 : 0);
  const lastActive = activeProjects
    .map((p) => p.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const cardStats = {
    newThisWeek: projects.filter((p) => withinWeek(p.createdAt)).length,
    withBoms: projects.filter((p) => (p.bomCount ?? 0) > 0).length,
    totalItems: projects.reduce((sum, p) => sum + (p.bomItemCount ?? 0), 0),
    activeWithBoms: activeProjects.filter((p) => (p.bomCount ?? 0) > 0).length,
    activeWithTarget: activeProjects.filter((p) => (p.targetBomCost ?? 0) > 0).length,
    lastActive,
    draftsModifiedThisWeek: draftProjects.filter((p) => withinWeek(p.updatedAt)).length,
    draftsBomPending: draftProjects.filter((p) => (p.bomItemCount ?? 0) === 0).length,
    draftsTargetMissing: draftProjects.filter((p) => !((p.targetBomCost ?? 0) > 0)).length,
    onHold: byStatus('on_hold').length,
    cancelled: byStatus('cancelled').length,
  };

  // Project status badge: label + icon, coloured by status. The shared StatusBadge has no entries for
  // project statuses, so they get their own clear styling here; anything else falls back to it.
  const renderStatusBadge = (status: string) => {
    const styles: Record<string, { icon: React.ReactNode; className: string }> = {
      draft: { icon: <Clock className="h-3 w-3" />, className: 'border-border bg-muted text-muted-foreground' },
      active: { icon: <CheckCircle2 className="h-3 w-3" />, className: 'border-success/30 bg-success/10 text-success' },
      completed: { icon: <CheckCircle2 className="h-3 w-3" />, className: 'border-primary/30 bg-primary/10 text-primary' },
      on_hold: { icon: <Pause className="h-3 w-3" />, className: 'border-warning/30 bg-warning/10 text-warning' },
      cancelled: { icon: <XCircle className="h-3 w-3" />, className: 'border-destructive/30 bg-destructive/10 text-destructive' },
    };
    const style = styles[status];
    if (!style) return <StatusBadge status={status} />;
    const label = PROJECT_STATUSES.find((st) => st.value === status)?.label ?? status;
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
          style.className,
        )}
      >
        {style.icon}
        {label}
      </span>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Projects"
        description="Manage manufacturing and costing projects"
      >
        <Button onClick={() => setCreateOpen(true)} className="gap-2 bg-foreground text-background hover:bg-foreground/90">
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </PageHeader>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Total */}
        <Card className="rounded-xl shadow-sm">
          <CardContent className="flex h-full flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-base font-semibold text-foreground">Total Projects</p>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">All time</span>
            </div>
            <div className="mt-2 flex items-end justify-between gap-2">
              <p className="text-4xl font-bold tabular-nums tracking-tight text-foreground">{stats.total}</p>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                +{cardStats.newThisWeek} this wk
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>With BOMs: <span className="font-medium tabular-nums text-foreground">{cardStats.withBoms}</span></span>
              <div className="h-1.5 w-24 shrink-0 rounded-full bg-secondary">
                <div className="h-1.5 rounded-full bg-foreground/70" style={{ width: `${pct(cardStats.withBoms)}%` }} />
              </div>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              BOM items: <span className="font-medium tabular-nums text-foreground">{cardStats.totalItems}</span>
            </p>
          </CardContent>
        </Card>

        {/* Active */}
        <Card className="rounded-xl shadow-sm">
          <CardContent className="flex h-full flex-col p-5">
            <p className="text-base font-semibold text-foreground">Active Projects</p>
            <div className="mt-2 flex items-end justify-between gap-2">
              <p className="text-4xl font-bold tabular-nums tracking-tight text-success">{stats.active}</p>
              <span className="truncate rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {cardStats.lastActive
                  ? `Last active ${formatDistanceToNow(new Date(cardStats.lastActive), { addSuffix: true })}`
                  : 'No activity yet'}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span><span className="font-medium tabular-nums text-foreground">{stats.active}</span> of {stats.total} in progress</span>
              <div className="h-1.5 w-24 shrink-0 rounded-full bg-secondary">
                <div className="h-1.5 rounded-full bg-success" style={{ width: `${pct(stats.active)}%` }} />
              </div>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              With BOMs: <span className="font-medium tabular-nums text-foreground">{cardStats.activeWithBoms}</span>
              {' • '}With target: <span className="font-medium tabular-nums text-foreground">{cardStats.activeWithTarget}</span>
            </p>
          </CardContent>
        </Card>

        {/* Draft */}
        <Card className="rounded-xl shadow-sm">
          <CardContent className="flex h-full flex-col p-5">
            <p className="text-base font-semibold text-foreground">Draft Projects</p>
            <div className="mt-2 flex items-end justify-between gap-2">
              <p className="text-4xl font-bold tabular-nums tracking-tight text-foreground">{stats.draft}</p>
              <span className="text-xs text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">{cardStats.draftsModifiedThisWeek}</span> modified within 7 days
              </span>
            </div>
            <div className="mt-3 flex items-start justify-between gap-3 text-sm">
              <p className="text-muted-foreground">Needs setup</p>
              <ul className="w-36 shrink-0 divide-y text-xs">
                <li className="flex items-center justify-between py-1">
                  <span className="flex items-center gap-1.5 text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-warning" />BOM pending</span>
                  <span className="font-medium tabular-nums text-foreground">{cardStats.draftsBomPending}</span>
                </li>
                <li className="flex items-center justify-between py-1">
                  <span className="flex items-center gap-1.5 text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-destructive" />Target missing</span>
                  <span className="font-medium tabular-nums text-foreground">{cardStats.draftsTargetMissing}</span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Completed */}
        <Card className="rounded-xl shadow-sm">
          <CardContent className="flex h-full flex-col p-5">
            <p className="text-base font-semibold text-foreground">Completed Projects</p>
            <p className="mt-2 text-4xl font-bold tabular-nums tracking-tight text-primary">{stats.completed}</p>
            <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span><span className="font-medium tabular-nums text-foreground">{stats.completed}</span> of {stats.total} finalized</span>
              <div className="h-1.5 w-24 shrink-0 rounded-full bg-secondary">
                <div className="h-1.5 rounded-full bg-primary" style={{ width: `${pct(stats.completed)}%` }} />
              </div>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              On hold: <span className="font-medium tabular-nums text-foreground">{cardStats.onHold}</span>
              {' • '}Cancelled: <span className="font-medium tabular-nums text-foreground">{cardStats.cancelled}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Projects table */}
      <Card className="overflow-hidden rounded-xl shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b px-6 py-4">
          <CardTitle className="text-lg font-semibold">All Projects</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <TableSkeleton rows={5} columns={5} label="Loading projects..." />
            </div>
          ) : projects.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={FolderKanban}
                title="No Projects Yet"
                description="Create your first manufacturing project to start managing BOMs and costs"
                className="rounded-lg border border-dashed bg-card"
              >
                <Button onClick={() => setCreateOpen(true)} size="lg" className="gap-2">
                  <Plus className="h-5 w-5" />
                  Create First Project
                </Button>
              </EmptyState>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="min-w-64 pl-6">Project</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead data-numeric>BOMs</TableHead>
                  <TableHead data-numeric>Items</TableHead>
                  <TableHead data-numeric>Annual Volume</TableHead>
                  <TableHead data-numeric>Target BOM Cost</TableHead>
                  <TableHead data-numeric>Actual Cost</TableHead>
                  <TableHead data-numeric>Savings</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-16 pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => {
                  const location = [project.city, project.state, project.country].filter(Boolean).join(', ');
                  const industryLabel = project.industry ? project.industry.replace('-', ' ') : '';
                  const meta = [industryLabel, location].filter(Boolean).join(' · ');
                  const saved = projectSavings(project);
                  const target = project.targetBomCost ?? 0;
                  return (
                    <TableRow
                      key={project.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/projects/${project.id}`)}
                    >
                      <TableCell className="max-w-80 py-4 pl-6">
                        <Link
                          href={`/projects/${project.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                          className="block truncate font-semibold text-foreground hover:text-primary hover:underline"
                        >
                          {project.name}
                        </Link>
                        {project.description && (
                          <p className="line-clamp-1 text-sm text-muted-foreground">{project.description}</p>
                        )}
                        <p className="truncate text-xs capitalize text-muted-foreground" title={location}>
                          {meta || '-'}
                        </p>
                      </TableCell>
                      <TableCell>{renderStatusBadge(project.status)}</TableCell>
                      <TableCell data-numeric>{project.bomCount ?? 0}</TableCell>
                      <TableCell data-numeric>{project.bomItemCount ?? 0}</TableCell>
                      <TableCell data-numeric>
                        {project.estimatedAnnualVolume
                          ? Number(project.estimatedAnnualVolume).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell data-numeric>
                        {project.targetBomCost && project.targetBomCostCurrency ? (
                          <span className="font-medium">
                            {`${project.targetBomCostCurrency} ${Number(project.targetBomCost).toLocaleString()}`}
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditOpen(project);
                            }}
                          >
                            Set up
                          </Button>
                        )}
                      </TableCell>
                      <TableCell data-numeric>
                        {formatProjectMoney(project.actualCost, projectCostCurrency(project))}
                      </TableCell>
                      <TableCell data-numeric className="text-success">
                        {target > 0 && saved != null ? `${(saved / target * 100).toFixed(1)}%` : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {format(new Date(project.createdAt), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell
                        className="pr-6 text-right"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" className="h-8 w-8 text-muted-foreground">
                              <Settings className="h-4 w-4" />
                              <span className="sr-only">Open menu for {project.name}</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              onSelect={() => {
                                router.push(`/projects/${project.id}`);
                              }}
                            >
                              <ArrowRight className="mr-2 h-4 w-4 text-muted-foreground" />
                              Open Project
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                handleEditOpen(project);
                              }}
                            >
                              <Pencil className="mr-2 h-4 w-4 text-muted-foreground" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                              onSelect={() => {
                                setProjectToDelete(project);
                                setDeleteOpen(true);
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Project Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[800px] max-h-[85vh] p-0 pointer-events-auto">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
            <DialogTitle className="text-2xl font-bold tracking-tight">Create New Project</DialogTitle>
            <DialogDescription className="text-[15px] text-muted-foreground">
              Set up a new manufacturing cost analysis project with all essential details
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto max-h-[60vh]">
            <div className="divide-y divide-border">
              {/* Project Basic Information */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Project Information</h3>
                  <p className="text-sm text-muted-foreground">Basic details about your project</p>
                </div>
                
                <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <Label htmlFor="name" className="text-sm font-medium">Project Name <span className="text-destructive">*</span></Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Engine Block Manufacturing"
                      className="mt-2 h-11"
                    />
                  </div>
                  
                  <div className="md:col-span-2">
                    <Label htmlFor="description" className="text-sm font-medium">Description</Label>
                    <Textarea
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Describe the project scope and objectives..."
                      rows={4}
                      className="mt-2"
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="status" className="text-sm font-medium">Status</Label>
                    <Select value={status} onValueChange={(value: any) => setStatus(value)}>
                      <SelectTrigger id="status" className="mt-2 h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_STATUSES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div>
                    <Label htmlFor="industry" className="text-sm font-medium">Industry</Label>
                    <Select value={industry} onValueChange={setIndustry}>
                      <SelectTrigger id="industry" className="mt-2 h-11">
                        <SelectValue placeholder="Select industry" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="medical">Medical</SelectItem>
                        <SelectItem value="automotive">Automotive</SelectItem>
                        <SelectItem value="aerospace">Aerospace</SelectItem>
                        <SelectItem value="electronics">Electronics</SelectItem>
                        <SelectItem value="consumer-goods">Consumer Goods</SelectItem>
                        <SelectItem value="industrial">Industrial</SelectItem>
                        <SelectItem value="energy">Energy</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              {/* Project Metrics */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Project Metrics</h3>
                  <p className="text-sm text-muted-foreground">Production volume and cost targets</p>
                </div>
                
                <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
                  <div>
                    <Label htmlFor="estimatedAnnualVolume" className="text-sm font-medium">Estimated Annual Volume</Label>
                    <Input
                      id="estimatedAnnualVolume"
                      type="number"
                      min="1"
                      max="999999999"
                      value={estimatedAnnualVolume}
                      onChange={(e) => setEstimatedAnnualVolume(e.target.value)}
                      placeholder="e.g., 10,000"
                      className="mt-2 h-11 font-mono"
                    />
                    <p className="mt-2 text-sm text-muted-foreground">Units per year</p>
                  </div>
                  
                  <div>
                    <Label htmlFor="targetBomCost" className="text-sm font-medium">Target BOM Cost</Label>
                    <div className="mt-2 flex overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
                      <Input
                        id="targetBomCost"
                        type="number"
                        min="0"
                        max="999999.99"
                        step="0.01"
                        value={targetBomCost}
                        onChange={(e) => setTargetBomCost(e.target.value)}
                        placeholder="0.00"
                        className="h-11 flex-1 rounded-none border-0 font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      <Select value={targetBomCostCurrency} onValueChange={setTargetBomCostCurrency}>
                        <SelectTrigger className="h-11 w-24 rounded-none border-0 border-l border-input bg-muted/50 font-mono shadow-none focus:ring-0 focus:ring-offset-0">
                          <SelectValue placeholder="USD" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="INR">INR</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">Per unit cost target</p>
                  </div>
                </div>
              </div>

              {/* Location Information */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Location</h3>
                  <p className="text-sm text-muted-foreground">Manufacturing location details</p>
                </div>
                
                {renderLocationFields('')}
              </div>
            </div>
          </div>
          
          <div className="border-t border-border bg-muted/40 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                <span className="text-destructive">*</span> Required fields
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                  disabled={createMutation.isPending}
                  className="h-10 px-5 font-medium border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors select-none"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  onClick={handleCreate}
                  disabled={!name || createMutation.isPending}
                  className="h-10 px-6 font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors shadow-xs select-none"
                >
                  {createMutation.isPending ? (
                    <div className="flex items-center gap-2">
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background" />
                      <span>Creating...</span>
                    </div>
                  ) : (
                    'Create Project'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Project Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-[800px] max-h-[85vh] p-0 pointer-events-auto">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
            <DialogTitle className="text-2xl font-bold tracking-tight">Edit Project</DialogTitle>
            <DialogDescription className="text-[15px] text-muted-foreground">
              Update project information and settings
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto max-h-[60vh]">
            <div className="divide-y divide-border">
              {/* Project Basic Information */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Project Information</h3>
                  <p className="text-sm text-muted-foreground">Update basic project details</p>
                </div>
                
                <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <Label htmlFor="edit-name" className="text-sm font-medium">Project Name <span className="text-destructive">*</span></Label>
                    <Input
                      id="edit-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Engine Block Manufacturing"
                      className="mt-2 h-11"
                    />
                  </div>
                  
                  <div className="md:col-span-2">
                    <Label htmlFor="edit-description" className="text-sm font-medium">Description</Label>
                    <Textarea
                      id="edit-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Describe the project scope and objectives..."
                      rows={4}
                      className="mt-2"
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="edit-status" className="text-sm font-medium">Status</Label>
                    <Select value={status} onValueChange={(value: any) => setStatus(value)}>
                      <SelectTrigger id="edit-status" className="mt-2 h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_STATUSES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div>
                    <Label htmlFor="edit-industry" className="text-sm font-medium">Industry</Label>
                    <Select value={industry} onValueChange={setIndustry}>
                      <SelectTrigger id="edit-industry" className="mt-2 h-11">
                        <SelectValue placeholder="Select industry" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="medical">Medical</SelectItem>
                        <SelectItem value="automotive">Automotive</SelectItem>
                        <SelectItem value="aerospace">Aerospace</SelectItem>
                        <SelectItem value="electronics">Electronics</SelectItem>
                        <SelectItem value="consumer-goods">Consumer Goods</SelectItem>
                        <SelectItem value="industrial">Industrial</SelectItem>
                        <SelectItem value="energy">Energy</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              
              {/* Project Metrics */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Project Metrics</h3>
                  <p className="text-sm text-muted-foreground">Production volume and cost targets</p>
                </div>
                
                <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
                  <div>
                    <Label htmlFor="edit-estimatedAnnualVolume" className="text-sm font-medium">Estimated Annual Volume</Label>
                    <Input
                      id="edit-estimatedAnnualVolume"
                      type="number"
                      min="1"
                      max="999999999"
                      value={estimatedAnnualVolume}
                      onChange={(e) => setEstimatedAnnualVolume(e.target.value)}
                      placeholder="e.g., 10,000"
                      className="mt-2 h-11 font-mono"
                    />
                    <p className="mt-2 text-sm text-muted-foreground">Units per year</p>
                  </div>
                  
                  <div>
                    <Label htmlFor="edit-targetBomCost" className="text-sm font-medium">Target BOM Cost</Label>
                    <div className="mt-2 flex overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
                      <Input
                        id="edit-targetBomCost"
                        type="number"
                        min="0"
                        max="999999.99"
                        step="0.01"
                        value={targetBomCost}
                        onChange={(e) => setTargetBomCost(e.target.value)}
                        placeholder="0.00"
                        className="h-11 flex-1 rounded-none border-0 font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      <Select value={targetBomCostCurrency} onValueChange={setTargetBomCostCurrency}>
                        <SelectTrigger className="h-11 w-24 rounded-none border-0 border-l border-input bg-muted/50 font-mono shadow-none focus:ring-0 focus:ring-offset-0">
                          <SelectValue placeholder="USD" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="INR">INR</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">Per unit cost target</p>
                  </div>
                </div>
              </div>

              {/* Location Information */}
              <div className="space-y-5 px-6 py-6">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Location</h3>
                  <p className="text-sm text-muted-foreground">Manufacturing location details</p>
                </div>
                
                {renderLocationFields('edit-')}
              </div>
            </div>
          </div>
          
          <div className="border-t border-border bg-muted/40 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                <span className="text-destructive">*</span> Required fields
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditOpen(false);
                    setProjectToEdit(null);
                    setName('');
                    setDescription('');
                    setStatus('draft');
                    setIndustry('');
                    setEstimatedAnnualVolume('');
                    setTargetBomCost('');
                    setTargetBomCostCurrency('');
                    setCountry('');
                    setState('');
                    setCity('');
                    setCountryCode('');
                    setStateCode('');
                  }}
                  disabled={updateMutation.isPending}
                  className="h-10 px-5 font-medium border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors select-none"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  onClick={handleUpdate}
                  disabled={!name || updateMutation.isPending}
                  className="h-10 px-6 font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors shadow-xs select-none"
                >
                  {updateMutation.isPending ? (
                    <div className="flex items-center gap-2">
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background" />
                      <span>Updating...</span>
                    </div>
                  ) : (
                    'Update Project'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{projectToDelete?.name}"? This action cannot be
              undone and will remove all associated BOMs and data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

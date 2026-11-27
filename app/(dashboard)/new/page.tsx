'use client';

import Link from 'next/link';

import { StatusBadge } from '@/components/common/status-badge';
import { IntakeBox } from '@/components/features/intake/IntakeBox';
import { ArrowRight } from '@/components/ui/icons';
import { useProfile } from '@/lib/api/hooks/useProfile';
import { useProjects } from '@/lib/api/hooks/useProjects';
import { formatProjectMoney, projectCostCurrency } from '@/lib/costing/project-costs';

/**
 * New: the generative way in. Drop drawings, pictures of parts, STEP files or a zip and say what the job is; the plan is shown to
 * check, and one click makes the project, its BOM and its parts, each costed from a model built from its drawing. The newest
 * projects are below, to go back into one.
 */
export default function NewPage() {
  const { data: profile } = useProfile();
  const { data: projectsData } = useProjects({ limit: 6 });
  const firstName = profile?.displayName?.trim().split(/\s+/)[0];
  const projects = projectsData?.projects ?? [];

  return (
    <div className="space-y-8 animate-fade-in">
      {/* The accent colour fades in from the top behind the prompt, in both themes: the page's one piece of decoration. */}
      <div className="rounded-3xl bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.22),transparent_62%)] px-4 pb-10 pt-12 sm:px-8 sm:pt-16">
        <IntakeBox title={firstName ? `What do you want to cost, ${firstName}?` : 'What do you want to cost?'} />
      </div>

      <section aria-label="Recent projects" className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Recent projects</h2>
          <Link href="/projects" className="flex items-center gap-1 text-sm font-medium text-foreground hover:underline">Browse all <ArrowRight className="h-4 w-4" /></Link>
        </div>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No project yet. The first one you create above appears here.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map(project => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="block h-full rounded-xl border border-border bg-background p-4 transition-colors hover:border-primary/60 hover:bg-accent">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-sm font-semibold text-foreground">{project.name}</p>
                    <StatusBadge status={project.status} />
                  </div>
                  <p className="mt-3 text-xs tabular-nums text-muted-foreground">
                    {project.bomCount ?? 0} {project.bomCount === 1 ? 'BOM' : 'BOMs'} · {project.bomItemCount ?? 0} {project.bomItemCount === 1 ? 'item' : 'items'} · {formatProjectMoney(project.actualCost, projectCostCurrency(project))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

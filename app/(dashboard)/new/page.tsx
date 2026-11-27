'use client';

import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

import { StatusBadge } from '@/components/common/status-badge';
import { IntakeBox } from '@/components/features/intake/IntakeBox';
import { OwnerAvatar, ProjectPicture } from '@/components/features/projects/project-visuals';
import { ArrowRight } from '@/components/ui/icons';
import { useProfile } from '@/lib/api/hooks/useProfile';
import { useProjects } from '@/lib/api/hooks/useProjects';
import { formatProjectMoney, projectCostCurrency } from '@/lib/costing/project-costs';
import { projectEntryHref } from '@/lib/projects/entry-href';

/**
 * New: the generative way in. Drop drawings, pictures of parts, STEP files or a zip and say what the job is; the plan is shown to
 * check, and one click makes the project, its BOM and its parts, each costed from a model built from its drawing. The newest
 * projects are below, to go back into one.
 */
/**
 * The page's backdrop, in the brand's own terms (the hero of emithran.com): a drawing sheet's grid, two parts in fine line as an engineer
 * dimensions them, and the brand's teal slice rising to the right. It is not a box: it runs to the edges of the content area (over the
 * layout's padding) and down the whole page, behind the recent projects, thinning out toward the foot. Everything is drawn from the
 * theme's tokens, so it follows the light, dark and brand themes. Decoration only: nothing here can be focused or read aloud.
 */
function PageBackdrop() {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const };
  const centre = { ...line, strokeDasharray: '18 5 3 5' };
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -inset-4 -z-10 overflow-hidden sm:-inset-8">
      {/* The sheet's grid, strongest at the top centre and gone toward the sides and the middle. */}
      <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,hsl(var(--foreground))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--foreground))_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_75%_70%_at_50%_0%,black,transparent)]" />

      {/* A plate with its holes, a slot and its overall dimension. */}
      <svg viewBox="0 0 320 200" className="absolute left-6 top-10 hidden h-44 w-72 text-foreground/15 xl:block">
        <rect x="30" y="46" width="260" height="120" rx="6" {...line} />
        <rect x="120" y="91" width="80" height="30" rx="15" {...line} />
        {[{ x: 60, y: 76 }, { x: 260, y: 76 }, { x: 60, y: 136 }, { x: 260, y: 136 }].map(({ x, y }) => <circle key={`${x}-${y}`} cx={x} cy={y} r="9" {...line} />)}
        <path d="M30 40V16M290 40V16M30 24H290M30 24l8-3v6zM290 24l-8-3v6z" {...line} />
        <path d="M14 106H306" {...centre} />
        <text x="160" y="18" textAnchor="middle" className="fill-current font-mono text-[11px]">260</text>
      </svg>

      {/* A flange: its bolt circle, bore and centre lines. */}
      <svg viewBox="0 0 400 400" className="absolute -right-14 -top-16 hidden h-80 w-80 text-foreground/15 lg:block">
        <circle cx="200" cy="200" r="150" {...line} />
        <circle cx="200" cy="200" r="110" {...line} strokeDasharray="6 6" />
        <circle cx="200" cy="200" r="60" {...line} />
        <circle cx="200" cy="200" r="24" {...line} />
        {[0, 60, 120, 180, 240, 300].map((deg) => {
          const a = (deg * Math.PI) / 180;
          return <circle key={deg} cx={200 + 110 * Math.cos(a)} cy={200 + 110 * Math.sin(a)} r="11" {...line} />;
        })}
        <path d="M20 200H380M200 20V380" {...centre} />
      </svg>

      {/* The brand's teal slice and its glow. Its edge starts beside the prompt at the right edge (lower on a narrow page, where the
          heading's lines reach that edge) and falls to the left at one angle whatever the page's size (a long sheet turned about its top
          right corner); everything under the edge is teal, on down the page. */}
      <div className="absolute right-0 top-56 h-64 w-3/5 rounded-full bg-primary/15 blur-3xl" />
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_45%,transparent)]">
        <div className="absolute right-0 top-64 h-[400vh] w-[220%] origin-top-right -rotate-[16deg] bg-[linear-gradient(90deg,hsl(var(--primary)/0.3)_70%,hsl(var(--primary)))] xl:top-44" />
      </div>
    </div>
  );
}

export default function NewPage() {
  const { data: profile } = useProfile();
  const { data: projectsData } = useProjects({ limit: 6 });
  const firstName = profile?.displayName?.trim().split(/\s+/)[0];
  const projects = projectsData?.projects ?? [];

  return (
    <div className="relative isolate space-y-8 animate-fade-in">
      <PageBackdrop />
      <div className="pb-8 pt-6 sm:pb-12 sm:pt-12">
        <IntakeBox title={<>What do you want to <span className="text-primary">cost</span>{firstName ? `, ${firstName}` : ''}?</>} />
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
                <Link href={projectEntryHref(project)} className="block h-full overflow-hidden rounded-xl border border-border bg-background transition-colors hover:border-primary/60 hover:bg-accent">
                  <div className="flex aspect-[16/9] items-center justify-center border-b border-border bg-gradient-to-br from-muted/70 to-muted/20">
                    <ProjectPicture thumbnailUrl={project.thumbnailUrl} className="p-3" />
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 break-words text-sm font-semibold text-foreground">{project.name}</p>
                      <StatusBadge status={project.status} />
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <OwnerAvatar
                        className="h-6 w-6 text-[10px]"
                        name={project.ownerName}
                        photoUrl={project.ownerId && project.ownerId === profile?.userId ? (profile.avatarUrl ?? undefined) : undefined}
                      />
                      <span className="truncate">{project.ownerName ? `${project.ownerName} · ` : ''}Edited {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}</span>
                    </div>
                    <p className="mt-3 text-xs tabular-nums text-muted-foreground">
                      {project.bomCount ?? 0} {project.bomCount === 1 ? 'BOM' : 'BOMs'} · {project.bomItemCount ?? 0} {project.bomItemCount === 1 ? 'item' : 'items'} · {formatProjectMoney(project.actualCost, projectCostCurrency(project))}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

import { format, formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ArrowRight, FolderKanban, Pencil, Settings, Trash2 } from '@/components/ui/icons';
import type { Project } from '@/lib/api/projects';

const initialsOf = (name: string | undefined): string =>
  (name ?? '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || '?';

export interface ProjectCardProps {
  project: Project;
  /** The owner's photo. Only the signed-in user's own is available (a photo is signed for its owner alone); others show initials. */
  ownerAvatarUrl?: string | undefined;
  statusBadge: React.ReactNode;
  /** Already formatted, in the project's currency. */
  actualCost: string;
  /** Already formatted ("12.5%"); null when there is nothing to compare with. */
  savings: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onOpen: () => void;
}

/** One project as a card: its picture, who owns it and when it was last edited, and the figures the table row held. */
export function ProjectCard({ project, ownerAvatarUrl, statusBadge, actualCost, savings, onEdit, onDelete, onOpen }: ProjectCardProps) {
  const href = `/projects/${project.id}`;
  const location = [project.city, project.state, project.country].filter(Boolean).join(', ');
  const meta = [project.industry?.replace('-', ' '), location].filter(Boolean).join(' · ');
  const owner = project.ownerName ?? 'Owner';

  return (
    <article className="group flex flex-col gap-3">
      <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border bg-gradient-to-br from-muted/70 to-muted/20">
        <Link href={href} aria-label={`Open ${project.name}`} className="absolute inset-0 z-0 flex items-center justify-center">
          {project.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a stored data URL, not a file Next can optimise
            <img src={project.thumbnailUrl} alt="" className="h-full w-full object-contain p-5 transition-transform duration-300 group-hover:scale-[1.03]" />
          ) : (
            <FolderKanban className="h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
          )}
        </Link>
        <div className="pointer-events-none absolute left-3 top-3 z-10">{statusBadge}</div>
        <div className="absolute right-3 top-3 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 bg-background/90 text-muted-foreground backdrop-blur">
                <Settings className="h-4 w-4" />
                <span className="sr-only">Open menu for {project.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onOpen}>
                <ArrowRight className="mr-2 h-4 w-4 text-muted-foreground" />
                Open Project
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="mr-2 h-4 w-4 text-muted-foreground" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" onSelect={onDelete}>
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Avatar className="h-9 w-9" title={owner}>
          {ownerAvatarUrl && <AvatarImage src={ownerAvatarUrl} alt={owner} />}
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initialsOf(project.ownerName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <Link href={href} className="block truncate font-semibold text-foreground hover:text-primary hover:underline" title={project.name}>
            {project.name}
          </Link>
          <p className="truncate text-sm text-muted-foreground" title={`Created ${format(new Date(project.createdAt), 'MMM d, yyyy')}`}>
            {project.ownerName ? `${project.ownerName} · ` : ''}Edited {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
          </p>
        </div>
      </div>

      {(Boolean(project.description) || meta !== '') && (
        <div className="space-y-0.5 text-sm text-muted-foreground">
          {project.description && <p className="line-clamp-1">{project.description}</p>}
          {meta && <p className="truncate text-xs capitalize" title={location}>{meta}</p>}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t pt-3 text-xs">
        <Fact label="BOMs" value={String(project.bomCount ?? 0)} />
        <Fact label="Items" value={String(project.bomItemCount ?? 0)} />
        <Fact label="Annual volume" value={project.estimatedAnnualVolume ? project.estimatedAnnualVolume.toLocaleString() : '-'} />
        <Fact
          label="Target BOM cost"
          value={project.targetBomCost && project.targetBomCostCurrency
            ? `${project.targetBomCostCurrency} ${project.targetBomCost.toLocaleString()}`
            : <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onEdit}>Set up</Button>}
        />
        <Fact label="Actual cost" value={actualCost} />
        <Fact label="Savings" value={savings ?? '—'} valueClassName={savings ? 'text-success' : undefined} />
        <Fact label="Created" value={format(new Date(project.createdAt), 'MMM d, yyyy')} />
      </dl>
    </article>
  );
}

function Fact({ label, value, valueClassName }: { label: string; value: React.ReactNode; valueClassName?: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium tabular-nums ${valueClassName ?? 'text-foreground'}`}>{value}</dd>
    </div>
  );
}

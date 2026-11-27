import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { FolderKanban } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

const initialsOf = (name: string | undefined): string =>
  (name ?? '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || '?';

/** A project's picture, filling its container, or a placeholder when none has been drawn yet. */
export function ProjectPicture({ thumbnailUrl, className, compact }: { thumbnailUrl?: string | undefined; className?: string | undefined; compact?: boolean | undefined }) {
  return thumbnailUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- a stored data URL, not a file Next can optimise
    <img src={thumbnailUrl} alt="" className={cn('h-full w-full object-contain', compact ? 'p-0.5' : 'p-5', className)} />
  ) : (
    <FolderKanban className={cn(compact ? 'h-5 w-5' : 'h-10 w-10', 'text-muted-foreground/30')} aria-hidden="true" />
  );
}

/** The owner's photo, else their initials. A photo is signed for its own user only, so only the signed-in user's is ever given. */
export function OwnerAvatar({ name, photoUrl, className }: { name?: string | undefined; photoUrl?: string | undefined; className?: string | undefined }) {
  return (
    <Avatar className={cn('h-9 w-9', className)} title={name ?? 'Owner'}>
      {photoUrl && <AvatarImage src={photoUrl} alt={name ?? 'Owner'} />}
      <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}

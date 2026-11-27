import type { Project } from '@/lib/api/projects';

/** Where a project opens when it is picked from a list: straight into its main BOM, or the project's own page when it has no BOM. */
export const projectEntryHref = (project: Pick<Project, 'id' | 'mainBomId'>): string =>
  project.mainBomId ? `/projects/${project.id}/bom/${project.mainBomId}` : `/projects/${project.id}`;

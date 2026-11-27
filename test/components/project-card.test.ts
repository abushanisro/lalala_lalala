import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProjectCard, type ProjectCardProps } from '@/components/features/projects/ProjectCard';
import type { Project } from '@/lib/api/projects';

const PROJECT: Project = {
  id: 'p1', name: 'Bharat Forge', description: 'Drawing and CAD in; cycle time out', status: 'draft',
  country: 'United States', state: 'California', industry: 'automotive', estimatedAnnualVolume: 10000,
  targetBomCost: 0.18, targetBomCostCurrency: 'USD', createdAt: '2026-11-27T10:00:00Z', updatedAt: new Date().toISOString(),
  bomCount: 5, bomItemCount: 21, ownerId: 'u1', ownerName: 'Bharat Forge Demo',
};

const render = (project: Partial<Project> = {}, props: Partial<ProjectCardProps> = {}) =>
  renderToStaticMarkup(createElement(ProjectCard, {
    project: { ...PROJECT, ...project }, statusBadge: 'Draft', actualCost: 'USD 5,644', savings: null, onEdit: () => undefined, onDelete: () => undefined, onOpen: () => undefined, ...props,
  }));

describe('ProjectCard', () => {
  it("opens the project from its picture and its name, and shows the owner and when it was last edited", () => {
    const html = render();
    expect(html).toContain('href="/projects/p1"');
    expect(html).toContain('aria-label="Open Bharat Forge"');
    expect(html).toMatch(/Bharat Forge Demo · Edited less than a minute ago/);
  });

  it("shows the project's picture when it has one, and a placeholder when it has none", () => {
    expect(render({ thumbnailUrl: 'data:image/png;base64,AAAA' })).toContain('src="data:image/png;base64,AAAA"');
    expect(render()).not.toContain('<img');
  });

  it("stands the owner's initials in for a photo, and keeps every figure the table row held", () => {
    const html = render();
    expect(html).toContain('>BF<');
    for (const text of ['BOMs', '>5<', 'Items', '>21<', '10,000', 'USD 0.18', 'USD 5,644', 'Savings', 'Created', 'Nov 27, 2026']) expect(html).toContain(text);
  });

  it('offers Set up for a project with no target BOM cost, and the savings when there are some', () => {
    expect(render({ targetBomCost: undefined, targetBomCostCurrency: undefined })).toContain('Set up');
    expect(render({}, { savings: '12.5%' })).toContain('12.5%');
    expect(render()).not.toContain('Set up');
  });

  it('keeps the actions: the menu for the project', () => {
    expect(render()).toContain('Open menu for Bharat Forge');
  });
});

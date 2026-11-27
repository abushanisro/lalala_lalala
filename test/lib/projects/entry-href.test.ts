import { describe, expect, it } from 'vitest';

import { projectEntryHref } from '@/lib/projects/entry-href';

describe('projectEntryHref', () => {
  it('opens a project with a BOM straight into that BOM', () => {
    expect(projectEntryHref({ id: 'p1', mainBomId: 'b1' })).toBe('/projects/p1/bom/b1');
  });

  it("opens a project with no BOM on the project's own page", () => {
    expect(projectEntryHref({ id: 'p1' })).toBe('/projects/p1');
  });
});

import { pickMainBoms, type BomSummary } from '../../../modules/projects/project-main-bom';

const bom = (id: string, projectId: string, itemCount: number, hasAssembly = false, createdAt = '2026-11-27T10:00:00Z'): BomSummary =>
  ({ id, projectId, itemCount, hasAssembly, createdAt });

describe('pickMainBoms', () => {
  it('takes the BOM that holds the main assembly, even when another has more items', () => {
    const picked = pickMainBoms([bom('flare', 'p', 9), bom('asm', 'p', 5, true), bom('parts', 'p', 7)]);
    expect(picked.get('p')).toBe('asm');
  });

  it('else takes the BOM with the most items', () => {
    expect(pickMainBoms([bom('a', 'p', 3), bom('b', 'p', 8), bom('c', 'p', 5)]).get('p')).toBe('b');
  });

  it('breaks a tie by the earliest created, then the lowest id, so the choice is stable', () => {
    expect(pickMainBoms([bom('b', 'p', 4, false, '2026-11-27T10:00:00Z'), bom('a', 'p', 4, false, '2026-11-26T10:00:00Z')]).get('p')).toBe('a');
    expect(pickMainBoms([bom('b', 'p', 4), bom('a', 'p', 4)]).get('p')).toBe('a');
  });

  it('picks per project, and gives a project with no BOM nothing', () => {
    const picked = pickMainBoms([bom('x', 'p1', 1), bom('y', 'p2', 2)]);
    expect(Object.fromEntries(picked)).toEqual({ p1: 'x', p2: 'y' });
    expect(pickMainBoms([]).size).toBe(0);
  });
});

import { pickThumbnailItems, type DrawnItem } from '../../../modules/projects/project-thumbnail';

const item = (id: string, projectId: string, itemType: string, createdAt = '2026-11-27T10:00:00Z'): DrawnItem => ({ id, projectId, itemType, createdAt });

describe('pickThumbnailItems', () => {
  it("takes a project's main assembly over a sub-assembly, and a sub-assembly over a part", () => {
    const picked = pickThumbnailItems([
      item('part', 'p1', 'child_part'), item('sub', 'p1', 'sub_assembly'), item('asm', 'p1', 'assembly'),
      item('part2', 'p2', 'child_part'), item('sub2', 'p2', 'sub_assembly'),
    ]);
    expect(Object.fromEntries(picked)).toEqual({ p1: 'asm', p2: 'sub2' });
  });

  it('takes the earliest of equal rank, then the lowest id, so the picture does not change when another item is drawn', () => {
    const picked = pickThumbnailItems([
      item('b', 'p1', 'child_part', '2026-11-27T10:00:00Z'),
      item('c', 'p1', 'child_part', '2026-11-26T10:00:00Z'),
      item('a', 'p1', 'child_part', '2026-11-26T10:00:00Z'),
    ]);
    expect(picked.get('p1')).toBe('a');
  });

  it('gives a project with nothing drawn nothing, and ranks an unknown type last', () => {
    expect(pickThumbnailItems([]).size).toBe(0);
    expect(pickThumbnailItems([item('x', 'p1', 'mystery'), item('part', 'p1', 'child_part')]).get('p1')).toBe('part');
  });
});

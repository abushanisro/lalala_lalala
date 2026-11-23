import { readFileSync } from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { render, out } = require('../../../../../scripts/sync-electronics-contract');

// The canonical schemas live in cad-engine/pcb/contract/schemas (the Python side checks them too). If a schema edit is not
// mirrored in the generated TypeScript copy, this fails. No example documents are bundled: graphs come from real uploads.
describe('feature-graph contract (shared with the CAD engine)', () => {
  it('the generated TypeScript schemas match the canonical CAD engine schemas', () => {
    expect(readFileSync(out, 'utf8')).toBe(render());
  });
});

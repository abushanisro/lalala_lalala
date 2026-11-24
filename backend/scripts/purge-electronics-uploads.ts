/**
 * Empties the object-store bucket the removed Electronics module kept its design files in ("electronics-uploads": the uploaded board and
 * harness files, their previews and thumbnails). Migration 1135 drops the tables that pointed at them; a migration cannot reach the object
 * store, so this removes the files. Run once per environment, after 1135, with that environment's S3_* settings:
 *   npx ts-node scripts/purge-electronics-uploads.ts          # counts what is there, removes nothing
 *   npx ts-node scripts/purge-electronics-uploads.ts --yes    # removes it
 * Prints counts only (the keys carry organization ids).
 */
import 'dotenv/config';

import { S3ObjectStore } from '../src/common/storage/s3-object-store';

const BUCKET = 'electronics-uploads';
const BATCH = 500;

async function main(): Promise<void> {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const store = new S3ObjectStore({
    bucket: need('S3_BUCKET'), region: need('S3_REGION'), endpoint: process.env['S3_ENDPOINT'] || undefined,
    accessKeyId: need('S3_ACCESS_KEY_ID'), secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
  });
  const keys = await store.list(BUCKET, '');
  console.log(`${BUCKET}: ${keys.length} object(s)`);
  if (!process.argv.includes('--yes')) {
    console.log('Dry run: nothing removed. Run again with --yes to remove them.');
    return;
  }
  for (let i = 0; i < keys.length; i += BATCH) await store.remove(BUCKET, keys.slice(i, i + BATCH));
  const left = await store.list(BUCKET, '');
  console.log(`removed ${keys.length - left.length}; ${left.length} left`);
  if (left.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('purge failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

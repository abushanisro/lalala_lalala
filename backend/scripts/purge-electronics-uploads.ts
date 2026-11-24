/**
 * Empties the object-store bucket the removed Electronics module kept its design files in ("electronics-uploads": the uploaded board and
 * harness files, their previews and thumbnails). Migration 1135 drops the tables that pointed at them; a migration cannot reach the object
 * store, so this removes the files. Run once per environment, after 1135, with that environment's S3_* settings (as the backend reads them):
 *   npx ts-node --transpile-only scripts/purge-electronics-uploads.ts          # counts what is there, removes nothing
 *   npx ts-node --transpile-only scripts/purge-electronics-uploads.ts --yes    # removes it
 * DOTENV_CONFIG_PATH=<env file> points it at an env file other than ./.env. Prints counts only (the keys carry organization ids).
 *
 * Every logical bucket is a key prefix in the one S3 bucket (common/storage/s3-object-store.ts: "<bucket>/<key>"). The app's ObjectStore
 * lists one level at a time and has no root listing, so this lists and deletes under the prefix with the S3 client directly.
 */
import 'dotenv/config';

import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const PREFIX = 'electronics-uploads/';

async function main(): Promise<void> {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const bucket = need('S3_BUCKET');
  const client = new S3Client({
    region: need('S3_REGION'),
    credentials: { accessKeyId: need('S3_ACCESS_KEY_ID'), secretAccessKey: need('S3_SECRET_ACCESS_KEY') },
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
    ...(process.env['S3_ENDPOINT'] ? { endpoint: process.env['S3_ENDPOINT'] } : {}),
  });
  const keys = async (): Promise<string[]> => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key) out.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  };
  const found = await keys();
  console.log(`${PREFIX}: ${found.length} object(s)`);
  if (!process.argv.includes('--yes')) {
    console.log('Dry run: nothing removed. Run again with --yes to remove them.');
    return;
  }
  for (let i = 0; i < found.length; i += 1000) {
    const out = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: found.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    if (out.Errors?.length) throw new Error(`remove failed for ${out.Errors.length} object(s): ${out.Errors[0]?.Code ?? 'unknown'}`);
  }
  const left = await keys();
  console.log(`removed ${found.length - left.length}; ${left.length} left`);
  if (left.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('purge failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

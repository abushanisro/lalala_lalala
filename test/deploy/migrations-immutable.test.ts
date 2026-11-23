import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// backend/scripts/check-migrations-immutable.sh, run the way CI runs it: in a shallow checkout of GitHub's merge commit for a pull
// request. The base can move on between the moment that merge is made and the moment the job runs; migrations that arrived on the base
// meanwhile must not read as deleted by the pull request (it failed two pull requests that way).
const SCRIPT = path.resolve(process.cwd(), 'backend/scripts/check-migrations-immutable.sh');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

let tmp: string;
let origin: string;
let author: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
};

/** A pull request branch made from the base's tip, and GitHub's merge of it into that tip (refs/pull/<n>/merge). */
function pullRequest(n: number, change: (cwd: string) => void): void {
  git(author, 'checkout', '-q', '-B', `pr-${n}`, 'origin/develop');
  change(author);
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', `pr ${n}`);
  git(author, 'checkout', '-q', '--detach', 'origin/develop');
  git(author, 'merge', '-q', '--no-ff', '-m', `merge pr ${n}`, `pr-${n}`);
  git(author, 'push', '-q', 'origin', `HEAD:refs/pull/${n}/merge`);
}
/** Another pull request lands on the base afterwards. */
function baseMovesOn(file: string): void {
  git(author, 'checkout', '-q', '-B', 'develop', 'origin/develop');
  write(author, file, 'select 2;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', `base adds ${file}`);
  git(author, 'push', '-q', 'origin', 'develop');
  git(author, 'fetch', '-q', 'origin');
}
/** What the CI job does: a shallow checkout of the merge commit, then the script with the base branch's name. */
function check(n: number): { status: number | null; out: string } {
  const job = fs.mkdtempSync(path.join(tmp, `job-${n}-`));
  git(job, 'init', '-q');
  git(job, 'remote', 'add', 'origin', origin);
  git(job, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', `refs/pull/${n}/merge`);
  git(job, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  const run = spawnSync('bash', [SCRIPT, 'develop'], { cwd: job, env: ENV, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-immutable-'));
  origin = path.join(tmp, 'origin.git');
  author = path.join(tmp, 'author');
  execFileSync('git', ['init', '-q', '--bare', origin], { env: ENV });
  // as GitHub does: a commit that is reachable can be fetched by its id
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  fs.mkdirSync(author);
  git(author, 'init', '-q', '-b', 'develop');
  git(author, 'remote', 'add', 'origin', origin);
  write(author, 'backend/migrations/1000_first.sql', 'select 1;\n');
  write(author, 'backend/migrations/1001_second.sql', 'select 1;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'base');
  git(author, 'push', '-q', 'origin', 'develop');
  git(author, 'fetch', '-q', 'origin');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('check-migrations-immutable.sh', () => {
  it('accepts a pull request that adds a migration', () => {
    pullRequest(1, (cwd) => { write(cwd, 'backend/migrations/1002_new.sql', 'select 1;\n'); });
    const { status, out } = check(1);
    expect(out).toContain('nothing on develop was changed (1 new)');
    expect(status).toBe(0);
  });

  it('refuses one that edits a migration the base has, and names it', () => {
    pullRequest(2, (cwd) => { write(cwd, 'backend/migrations/1000_first.sql', 'select 99;\n'); });
    const { status, out } = check(2);
    expect(status).toBe(1);
    expect(out).toMatch(/M\tbackend\/migrations\/1000_first\.sql/);
  });

  it('refuses one that deletes a migration the base has', () => {
    pullRequest(3, (cwd) => { fs.rmSync(path.join(cwd, 'backend/migrations/1001_second.sql')); });
    const { status, out } = check(3);
    expect(status).toBe(1);
    expect(out).toMatch(/D\tbackend\/migrations\/1001_second\.sql/);
  });

  it('does not blame a pull request for a migration that reached the base after its merge commit was made', () => {
    pullRequest(4, (cwd) => { write(cwd, 'backend/migrations/1004_mine.sql', 'select 1;\n'); });
    pullRequest(5, (cwd) => { write(cwd, 'backend/migrations/1000_first.sql', 'select 99;\n'); });
    baseMovesOn('backend/migrations/1003_theirs.sql');
    const added = check(4);
    expect(added.out).not.toContain('1003_theirs.sql');
    expect(added.out).toContain('nothing on develop was changed (1 new)');
    expect(added.status).toBe(0);
    // and the base moving on excuses nothing: an edit is still an edit
    const edited = check(5);
    expect(edited.status).toBe(1);
    expect(edited.out).toMatch(/M\tbackend\/migrations\/1000_first\.sql/);
    expect(edited.out).not.toContain('1003_theirs.sql');
  });

  it('outside a merge commit (a branch checked out by hand) compares with the tip of the base, as before', () => {
    const local = fs.mkdtempSync(path.join(tmp, 'local-'));
    git(local, 'clone', '-q', origin, '.');
    git(local, 'checkout', '-q', '-b', 'work', 'origin/develop');
    write(local, 'backend/migrations/1001_second.sql', 'select 99;\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'edit');
    const run = spawnSync('bash', [SCRIPT, 'develop'], { cwd: local, env: ENV, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/M\tbackend\/migrations\/1001_second\.sql/);
  });
});

# Moving Postgres to a new major version (17 to 19)

**Status: prepared and rehearsed, not scheduled.** Nothing in this runbook has been run against the local, stage or production
database. The pinned image stays on Postgres 17 until someone decides to do the move.

Postgres 17 is still a supported version, and the Postgres 19 image is the first release of that major (19.0). There is no need to
hurry: the usual practice is to let a new major get its first minor release before production moves to it.

## Why it is not an image bump

- **A newer major cannot open an older data directory.** The data has to be dumped from the old server and restored into the new one
  (or converted with `pg_upgrade`). This runbook dumps and restores: the databases are small, and the old data stays untouched.
- **From 18 on the image stores its data elsewhere.** It expects one volume at `/var/lib/postgresql` (data under `19/docker`) and
  refuses to start with a volume at the old `/var/lib/postgresql/data` path.

So a release that only changed the image would take the database down. That is why `.github/dependabot.yml` ignores Postgres major
versions.

## What was checked on Postgres 19

All on throwaway containers (image `postgres:19-alpine@sha256:8b0ff4cd...`, version 19.0):

| Check | Result |
|---|---|
| `npm run test:sql` (every migration test) | 40 of 40 pass |
| `npm run test:postgrest` (the data API on it, tokens and row-level security) | 17 of 17 pass |
| `npm run test:baseline` (baseline dump and load) | 29 of 29 pass |
| `npm run test:schema-drift` | 6 of 6 pass |
| `npm run test:pg-upgrade` (this procedure, end to end) | 37 of 37 pass |
| Rehearsal on a copy of the local database | 7,418 objects, 228 tables, 80,365 rows identical; copied in 4 seconds |

To run the database test suites against another version:

```bash
cd backend
POSTGRES_IMAGE='postgres:19-alpine@sha256:<digest>' POSTGRES_DATA_MOUNT=/var/lib/postgresql npm run test:sql   # also test:postgrest, test:baseline, test:schema-drift
```

## The tool

`infra/oracle/pg-major-upgrade.sh` (needs only Docker; run it on the machine that hosts the database):

| Command | What it does | Changes anything? |
|---|---|---|
| `rehearse <container>` | Copies the running database into a throwaway Postgres 19, verifies the copy, reports the copy time, removes the copy | No. The source is only read. Safe at any time. |
| `cutover <container> <new-volume>` | The same copy into a new volume, verified the same way; then stops the old server | Yes: creates the new volume and stops the old container. Never writes to or removes the old volume. Asks for `GO`. |
| `verify <container-a> <container-b>` | Compares two running servers | No |

"Verified" means every role (with its password hash and settings), schema, column, constraint, index, view, function, trigger, policy,
grant, sequence and enum is compared one by one, and every table's row count and a checksum of its rows. Any difference fails the run.

## The procedure

### 1. Rehearse (any day)

On each environment's host:

```bash
infra/oracle/pg-major-upgrade.sh rehearse emithran-local-data-postgres-1   # local
infra/oracle/pg-major-upgrade.sh rehearse emithran-stage-postgres-1        # stage
infra/oracle/pg-major-upgrade.sh rehearse emithran-prd-postgres-1          # production
```

It must end with `OK: the copy is identical`. The copy time it prints is the main part of the downtime.

### 2. Prepare the release (a PR, merged only when the window is agreed)

The release changes, together:

1. **The `postgres` service** in `docker-compose.data.yml` and `docker-compose.local-data.yml`: its `image`, an `entrypoint`, its
   `volumes`, and the new volume `pgdata19`. Write them exactly as `backend/test/pg-major-upgrade/next.compose.yml` has them: that
   file is what the test runs.
2. **The pinned image** in `backend/scripts/{baseline-dump,baseline-load,restore-check,schema-drift}.sh`,
   `backend/test/{sql,baseline,postgrest,schema-drift,local-data}/run.sh` and `.github/workflows/ops.yml` (the nightly backup's dump
   client must not be older than the server).
3. **The data mount default** (`/var/lib/postgresql/data` to `/var/lib/postgresql`) in the three scripts that mount one:
   `backend/test/sql/run.sh`, `backend/scripts/restore-check.sh`, `backend/scripts/schema-drift.sh`.
4. **`.github/dependabot.yml`**: the Postgres major ignore now names the next major.

The new service definition **fails closed**: while an environment's Postgres 17 volume holds a database and its new volume holds
none, the server refuses to start and says why. So a release that reaches an environment before its data was moved takes that
environment's database down (loudly, with no data lost) instead of starting an empty one. Deploy the previous release to bring it back.

### 3. Move each environment (local, then stage, then production)

For each one, in a window agreed beforehand:

1. **Back up.** Production: `infra/oracle/backup.sh`. Stage and local: optional (the old volume is kept).
2. **Stop every service except `postgres` and `storage`** (backend, frontend, the data API, the engines, workers, the tunnel
   connector). From here the site is down.
3. **Move the data.** The new volume is `<compose project>_pgdata19`:
   ```bash
   COMPOSE_PROJECT=emithran-stage infra/oracle/pg-major-upgrade.sh cutover emithran-stage-postgres-1 emithran-stage_pgdata19
   ```
   It refuses if anyone is still connected, if the volume exists, or if the copy is not identical; in each case nothing was changed
   and the old server keeps running. `DRY_RUN=1` prints the plan only.
4. **Deploy the release** the usual way (`stage-release.sh`, `micro-release.sh`, `local:use`). Postgres starts on version 19 with the
   moved data; migrations and the smoke test run as on any release.
5. **Check:** the site answers, and `select version()` says 19.

### 4. Going back

- **Before anything was written on 19:** deploy the previous release. It starts Postgres 17 on the old volume, which holds the data
  exactly as it was at the cutover. Remove the new volume.
- **After writes on 19:** those writes exist only there. Going back loses them, so decide inside the window.

### 5. Clean up (a later release, when nobody needs the old data)

Remove the `pgdata:/var/lib/postgresql-17:ro` mount and the `entrypoint` from the `postgres` service, deploy, then on each host
`docker volume rm <compose project>_pgdata`.

## Notes

- The copy goes through `docker exec` (`pg_dumpall` in the old container, `psql` in the new one): no password is needed or printed,
  and the new server has no network while it is being filled.
- Roles are copied with their password hashes, so the data API's `authenticator` login and the superuser password stay as they are.
- A rehearsal on a live database reports the tables that changed while it copied and leaves them out of the comparison. A cutover
  allows no change at all.

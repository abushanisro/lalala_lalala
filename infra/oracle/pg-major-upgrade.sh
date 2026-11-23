#!/usr/bin/env bash
# Moves one environment's Postgres to a newer MAJOR version, by dump and restore into a new volume, and proves the copy.
#
# A newer major cannot open a data directory an older one wrote, and from 18 on the image keeps its data under /var/lib/postgresql/<major>
# and refuses to start with a volume at the old path. So a major upgrade is a data move with a short stop of the site, never an image bump.
# The whole procedure, the compose change and the rollback are in docs/runbooks/postgres-major-upgrade.md.
#
#   infra/oracle/pg-major-upgrade.sh rehearse <source-container>
#       Copies the running database into a THROWAWAY Postgres of the target version (its own volume, removed at the end), verifies the copy
#       and reports how long it took. The source is only read (pg_dumpall through docker exec): safe at any time, on any environment.
#
#   infra/oracle/pg-major-upgrade.sh cutover <source-container> <new-volume>
#       The real move, in the upgrade window. Stop the environment's writers first (backend, the data API, workers): the script refuses
#       while anyone else is connected. It makes the same copy into <new-volume> (which must not exist yet), verifies it the same way, and
#       only then stops the source container. The old volume is never written to or removed: it is the rollback.
#       Asks for the word GO first (YES=1 answers it; DRY_RUN=1 prints the plan and changes nothing).
#
#   infra/oracle/pg-major-upgrade.sh verify <container-a> <container-b>
#       Compares two running servers the same way and changes nothing: for a rehearsal copy kept with KEEP=1, or to check any copy by hand.
#
#   TARGET_IMAGE     the new version's pinned image (default below)
#   KEEP=1           rehearse only: leave the throwaway copy running (its name is printed) instead of removing it
#   COMPOSE_PROJECT  cutover only: label <new-volume> as this compose project's volume, so `docker compose up` adopts it without a warning
#
# What "verifies" means: for every database, the roles (attributes, memberships and password hashes), settings, schemas, columns, constraints,
# indexes, views, functions, triggers, policies, grants, sequences and enums are compared one by one, and so is every table's row count and
# a checksum of its rows. Any difference fails the run. In a rehearsal the source keeps changing, so a table that changed while it was
# being copied is reported as such and not counted as a difference; in a cutover nothing may change.
set -Eeuo pipefail
trap 'echo "pg-major-upgrade.sh failed at line $LINENO" >&2' ERR

TARGET_IMAGE="${TARGET_IMAGE:-postgres:19-alpine@sha256:8b0ff4cdf221f0c53d7fcda681d3b461be725c492cd881c5ec9c0ad25023f188}"
mode="${1:-}"; src="${2:-}"; new_volume="${3:-}"
usage() { echo "usage: pg-major-upgrade.sh rehearse <source-container> | cutover <source-container> <new-volume> | verify <container-a> <container-b>" >&2; exit 2; }
case "$mode" in rehearse) [ -n "$src" ] && [ -z "$new_volume" ] || usage ;; cutover | verify) [ -n "$src" ] && [ -n "$new_volume" ] || usage ;; *) usage ;; esac

docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 2; }
[ "$(docker inspect -f '{{.State.Running}}' "$src" 2>/dev/null)" = true ] || { echo "the source container $src is not running" >&2; exit 2; }
psql_in() { docker exec -i "$1" psql -U postgres -d "${2:-postgres}" -At -F '|' -q -v ON_ERROR_STOP=1; }
major_of() { echo "show server_version_num" | psql_in "$1" | awk '{print int($1 / 10000)}'; }
src_major="$(major_of "$src")"

work="$(mktemp -d)"; id="pgup-$$"; tmp="$id-target"; volume="$id-data"; keep=false
[ "$mode" = cutover ] && volume="$new_volume"
# Removes only what this run made: the temporary server, and the volume unless the run finished and is meant to keep it.
cleanup() {
  if [ -f "$work/volume-created" ] && ! $keep; then docker rm -f "$tmp" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

# Everything that must be the same on both sides, one line per object: "<kind>|<name>|<what it is>".
globals_sql() { cat <<'SQL'
set search_path = pg_catalog;
select 'role|' || r.rolname || '|' || concat_ws(',', r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls,
       r.rolconnlimit, coalesce(r.rolvaliduntil::text, '-'), coalesce(md5(a.rolpassword), '-'))
  from pg_roles r join pg_authid a on a.oid = r.oid where r.rolname !~ '^pg_' order by 1;
select 'member|' || g.rolname || '>' || m.rolname || '|' || am.admin_option
  from pg_auth_members am join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member where m.rolname !~ '^pg_' order by 1;
select 'setting|' || coalesce(d.datname, '*') || '|' || coalesce(r.rolname, '*') || '|' || array_to_string(s.setconfig, ',')
  from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole order by 1;
select 'database|' || datname || '|' || concat_ws(',', pg_encoding_to_char(encoding), datcollate, datctype, datallowconn) from pg_database where not datistemplate order by 1;
SQL
}
database_sql() { cat <<'SQL'
set search_path = pg_catalog;
set datestyle = 'ISO, MDY'; set intervalstyle = 'postgres'; set timezone = 'UTC'; set extra_float_digits = 1; set bytea_output = 'hex';
create temp view user_schemas as select oid, nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema';
create temp view from_extension as select classid, objid from pg_depend where deptype = 'e';
select 'schema|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || ',' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(n.nspacl) a), '-')
  from pg_namespace n join user_schemas u on u.oid = n.oid order by 1;
select 'extension|' || e.extname || '|' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;
select 'relation|' || u.nspname || '.' || c.relname || '|' || concat_ws(',', c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.relpersistence,
       coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-'), coalesce(array_to_string(c.reloptions, ','), '-'))
  from pg_class c join user_schemas u on u.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') order by 1;
select 'column|' || u.nspname || '.' || c.relname || '.' || a.attname || '|' || concat_ws(',', row_number() over (partition by c.oid order by a.attnum),
       format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), a.attidentity, a.attgenerated,
       coalesce((select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x), '-'))
  from pg_attribute a join pg_class c on c.oid = a.attrelid join user_schemas u on u.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f') order by 1;
-- From 18 on a NOT NULL is also a constraint row (contype n); the column line above already states it for every version.
select 'constraint|' || u.nspname || '.' || c.relname || '.' || k.conname || '|' || pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join user_schemas u on u.oid = c.relnamespace where k.contype <> 'n' order by 1;
select 'index|' || i.schemaname || '.' || i.indexname || '|' || i.indexdef from pg_indexes i join user_schemas u on u.nspname = i.schemaname order by 1;
select 'view|' || u.nspname || '.' || c.relname || '|' || md5(pg_get_viewdef(c.oid)) from pg_class c join user_schemas u on u.oid = c.relnamespace where c.relkind in ('v', 'm') order by 1;
select 'function|' || p.oid::regprocedure || '|' || concat_ws(',', p.prokind, case when p.prokind in ('f', 'p') then md5(pg_get_functiondef(p.oid)) else '-' end,
       pg_get_userbyid(p.proowner), coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '-'))
  from pg_proc p join user_schemas u on u.oid = p.pronamespace
  where not exists (select 1 from from_extension e where e.classid = 'pg_proc'::regclass and e.objid = p.oid) order by 1;
select 'trigger|' || u.nspname || '.' || c.relname || '.' || t.tgname || '|' || t.tgenabled::text || ',' || pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join user_schemas u on u.oid = c.relnamespace where not t.tgisinternal order by 1;
select 'policy|' || p.schemaname || '.' || p.tablename || '.' || p.policyname || '|' || concat_ws('|', p.permissive, array_to_string(p.roles, ','), p.cmd, coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
  from pg_policies p order by 1;
select 'sequence|' || s.schemaname || '.' || s.sequencename || '|' || concat_ws(',', coalesce(s.last_value::text, '-'), s.increment_by, s.min_value, s.max_value, s.cycle, s.data_type)
  from pg_sequences s join user_schemas u on u.nspname = s.schemaname order by 1;
select 'enum|' || u.nspname || '.' || t.typname || '|' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_enum e join pg_type t on t.oid = e.enumtypid join user_schemas u on u.oid = t.typnamespace group by u.nspname, t.typname order by 1;
select 'defaultacl|' || coalesce(n.nspname, '*') || '.' || pg_get_userbyid(d.defaclrole) || '.' || d.defaclobjtype::text || '|' || (select string_agg(a::text, ',' order by a::text) from unnest(d.defaclacl) a)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1;
select 'eventtrigger|' || evtname || '|' || evtevent || ',' || evtfoid::regproc || ',' || evtenabled::text from pg_event_trigger order by 1;
select 'publication|' || pubname || '|' || puballtables from pg_publication order by 1;
-- Every table's rows: how many, and a checksum that does not depend on the order they are read in.
select format('select %L || count(*) || '','' || coalesce(md5(string_agg(h, '''' order by h)), ''-'') from (select md5(t::text) as h from %I.%I t) s',
              'rows|' || u.nspname || '.' || c.relname || '|', u.nspname, c.relname)
  from pg_class c join user_schemas u on u.oid = c.relnamespace where c.relkind = 'r' order by u.nspname, c.relname
\gexec
SQL
}
databases_of() { echo "select datname from pg_database where not datistemplate and datallowconn order by 1" | psql_in "$1"; }
inventory() { # <container> <out-file>
  globals_sql | psql_in "$1" > "$2"
  local db; for db in $(databases_of "$1"); do database_sql | psql_in "$1" "$db" | sed "s/^/$db|/" >> "$2"; done
  LC_ALL=C sort -o "$2" "$2"
}
# The line's name without what it is, and never a role's attributes (they end in its password hash's digest).
names() { awk -F'|' '{ if ($1 == "role" || $2 == "role") print $1 "|" $2; else if ($1 ~ /^(role|member|setting|database)$/) print $1 "|" $2; else print $1 "|" $2 "|" $3 }' | LC_ALL=C sort -u; }
other_sessions() { echo "select count(*) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()" | psql_in "$1"; }

# compare <reference-inventory> <copy-inventory> <ignore-names-file>: lists what differs into $work/different; true when nothing does.
compare() { LC_ALL=C comm -3 "$1" "$2" | tr -d '\t' | names | LC_ALL=C comm -23 - "$3" > "$work/different"; [ ! -s "$work/different" ]; }
summary_of() { echo "$(wc -l < "$1" | tr -d ' ') objects compared, $(grep -c '|rows|' "$1" || true) tables, $(grep '|rows|' "$1" | awk -F'|' '{ split($4, v, ","); s += v[1] } END { print s + 0 }') rows"; }

if [ "$mode" = verify ]; then
  other="$new_volume"
  [ "$(docker inspect -f '{{.State.Running}}' "$other" 2>/dev/null)" = true ] || { echo "the container $other is not running" >&2; exit 2; }
  echo "comparing $src (Postgres $src_major) with $other (Postgres $(major_of "$other")) ..."
  inventory "$src" "$work/a"; inventory "$other" "$work/b"; : > "$work/none"
  if compare "$work/a" "$work/b" "$work/none"; then echo "OK: identical: $(summary_of "$work/b")"; exit 0; fi
  echo "NOT IDENTICAL: $(wc -l < "$work/different" | tr -d ' ') object(s) differ:" >&2; head -40 "$work/different" >&2; exit 5
fi

target_major="$(docker run --rm --entrypoint sh "$TARGET_IMAGE" -c 'echo "$PG_MAJOR"')"
[ "$target_major" -gt "$src_major" ] || { echo "the target image is Postgres $target_major and the source is $src_major: nothing to upgrade" >&2; exit 2; }
echo "source: $src (Postgres $src_major)   target: Postgres $target_major   mode: $mode"
if [ "$mode" = cutover ]; then
  ! docker volume inspect "$volume" >/dev/null 2>&1 || { echo "the volume $volume already exists: a cutover only ever fills a new one (remove it yourself if it is a failed attempt)" >&2; exit 3; }
  n="$(other_sessions "$src")"
  [ "$n" = 0 ] || { echo "$n other session(s) are connected to $src: stop the writers first (backend, the data API, workers)" >&2; exit 3; }
  echo "plan: 1. create the volume $volume   2. copy every database and role into Postgres $target_major on it   3. verify the copy, object by object and row by row"
  echo "      4. stop $src (its volume is left exactly as it is: the rollback)   then: deploy the release whose compose file uses $volume"
  if [ "${DRY_RUN:-}" = 1 ]; then echo "DRY_RUN: nothing was changed"; exit 0; fi
  if [ "${YES:-}" != 1 ]; then read -r -p "type GO to move this database to Postgres $target_major: " answer; [ "$answer" = GO ] || { echo "not confirmed: nothing was changed"; exit 1; }; fi
fi

labels=(); [ "$mode" = cutover ] && [ -n "${COMPOSE_PROJECT:-}" ] && labels=(--label "com.docker.compose.project=$COMPOSE_PROJECT" --label "com.docker.compose.volume=${volume#"${COMPOSE_PROJECT}"_}")
docker volume create ${labels[@]+"${labels[@]}"} "$volume" >/dev/null; : > "$work/volume-created"
# The target runs as the data tier runs it (docker-compose.data.yml): read-only root, no capabilities, the postgres user, the 18+ data path.
# It has no network: the copy goes through docker exec. Its first password is random and replaced by the source's own when the roles arrive.
docker run -d --name "$tmp" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 70:70 \
  --tmpfs /tmp --tmpfs /var/run/postgresql -v "$volume:/var/lib/postgresql" -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  "$TARGET_IMAGE" postgres -c max_connections=100 -c shared_buffers=256MB >/dev/null
# The image starts a temporary server to initialise the cluster and then the real one: wait for the real one (it listens on TCP).
for _ in $(seq 1 90); do docker exec "$tmp" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$tmp" pg_isready -h 127.0.0.1 -U postgres >/dev/null || { echo "the Postgres $target_major target did not start:" >&2; docker logs "$tmp" 2>&1 | tail -5 >&2; exit 1; }

echo "reading the source before the copy ..."; inventory "$src" "$work/source-before"
echo "copying (roles, then every database) ..."; started="$(date +%s)"
set +e
docker exec "$src" pg_dumpall -U postgres 2> "$work/dump.err" | docker exec -i "$tmp" psql -U postgres -d postgres -q > /dev/null 2> "$work/restore.err"
codes=("${PIPESTATUS[@]}")
set -e
[ "${codes[0]}" = 0 ] || { echo "the dump of $src failed:" >&2; tail -5 "$work/dump.err" >&2; exit 1; }
# The one expected message: the dump creates the superuser role, which the new cluster already has (its attributes and password are then set).
if grep -E 'ERROR|FATAL' "$work/restore.err" | grep -v -E 'role "postgres" already exists' > "$work/restore.problems"; then
  echo "the restore reported $(wc -l < "$work/restore.problems" | tr -d ' ') error(s):" >&2; head -10 "$work/restore.problems" >&2; exit 1
fi
seconds=$(( $(date +%s) - started ))
echo "reading the source after the copy, and the copy ..."; inventory "$src" "$work/source-after"; inventory "$tmp" "$work/target"

# Lines the source itself changed while it was copied (a live source, in a rehearsal).
LC_ALL=C comm -3 "$work/source-before" "$work/source-after" | tr -d '\t' | names > "$work/moving"
if [ -s "$work/moving" ] && [ "$mode" = cutover ]; then
  echo "the source changed while it was being copied ($(wc -l < "$work/moving" | tr -d ' ') object(s)): a writer is still running. The copy is discarded; nothing else was changed." >&2
  head -10 "$work/moving" >&2; exit 4
fi
if ! compare "$work/source-after" "$work/target" "$work/moving"; then
  echo "NOT IDENTICAL: $(wc -l < "$work/different" | tr -d ' ') object(s) differ between the source and the copy:" >&2; head -40 "$work/different" >&2
  [ "$mode" = cutover ] && echo "the copy is discarded and $src keeps running: nothing was changed" >&2
  exit 5
fi
echo "OK: the copy is identical to the source: $(summary_of "$work/target"), copied in ${seconds}s"
[ ! -s "$work/moving" ] || echo "note: $(wc -l < "$work/moving" | tr -d ' ') object(s) changed on the live source during the copy and were left out of the comparison (a cutover allows none)"

if [ "$mode" = rehearse ]; then
  if [ "${KEEP:-}" = 1 ]; then keep=true; echo "rehearsal done: the copy is kept as container $tmp on volume $volume (remove both when done); the source was only read"
  else echo "rehearsal done: the throwaway copy is removed; the source was only read"; fi
  exit 0
fi
docker stop -t 120 "$tmp" >/dev/null   # a clean shutdown, so the new server starts without recovery
docker rm "$tmp" >/dev/null
keep=true
docker stop -t 120 "$src" >/dev/null
echo "cutover done: $volume holds the database on Postgres $target_major, and $src is stopped with its volume untouched."
echo "next: deploy the release whose compose file mounts $volume. To go back instead: docker start $src (and remove $volume)."

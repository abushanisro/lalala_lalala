#!/usr/bin/env bash
# The Postgres major upgrade, end to end, on throwaway containers (needs Docker): infra/oracle/pg-major-upgrade.sh and the compose
# definition the runbook prescribes (next.compose.yml), against a small database on today's layout (old.compose.yml + fixture.sql).
#   npm run test:pg-upgrade
# It proves: a rehearsal copies and verifies without leaving anything behind; the comparison notices a changed row, a dropped policy
# and a changed password; a release that arrives before the data was moved is refused and loses nothing; the cutover moves the data,
# refuses when it is not safe, and leaves the old volume as the way back; a new installation starts empty on the new version.
set -uo pipefail
cd "$(dirname "$0")/../.."
UP="$PWD/../infra/oracle/pg-major-upgrade.sh"
P="pgup-test-$$"; F="$P-fresh"; WORK="$(mktemp -d)"
old() { docker compose -p "$P" -f test/pg-major-upgrade/old.compose.yml "$@"; }
next() { docker compose -p "$P" -f test/pg-major-upgrade/next.compose.yml "$@"; }
fresh() { docker compose -p "$F" -f test/pg-major-upgrade/next.compose.yml "$@"; }
cleanup() {
  old down -v --remove-orphans >/dev/null 2>&1; next down -v --remove-orphans >/dev/null 2>&1; fresh down -v --remove-orphans >/dev/null 2>&1
  [ -z "${kept:-}" ] || docker rm -f "$kept" >/dev/null 2>&1; [ -z "${kept_volume:-}" ] || docker volume rm "$kept_volume" >/dev/null 2>&1
  docker volume rm "$P-taken" >/dev/null 2>&1; rm -rf "$WORK"
}
trap cleanup EXIT
failed=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (wanted '$2', got '$3')"; failed=1; fi; }
has() { if grep -q -- "$2" "$3"; then echo "ok   $1"; else echo "FAIL $1 (no '$2' in the output)"; sed 's/^/       /' "$3" | tail -6; failed=1; fi; }
sql() { docker exec -i "$1" psql -U postgres -d "${3:-postgres}" -At -q -v ON_ERROR_STOP=1 -c "$2"; }
C="$P-postgres-1"
OLD_IMAGE="$(sed -n 's/^ *image: *//p' test/pg-major-upgrade/old.compose.yml)"

old up -d --wait postgres >/dev/null 2>&1
docker exec -i "$C" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < test/pg-major-upgrade/fixture.sql >/dev/null
rows_before="$(sql "$C" 'select count(*) from public.parts')"; next_id_before="$(sql "$C" "select last_value from public.parts_id_seq")"
check 'the old layout runs Postgres 17 with the fixture loaded' '17 490' "$(sql "$C" "select current_setting('server_version_num')::int / 10000") $rows_before"

# 1. Rehearsal: copies, verifies, removes its copy.
bash "$UP" rehearse "$C" > "$WORK/rehearse.out" 2>&1; check 'a rehearsal succeeds' 0 $?
has 'and reports an identical copy of both databases' 'OK: the copy is identical to the source' "$WORK/rehearse.out"
check 'and leaves no container or volume behind' 0 "$( { docker ps -a --format '{{.Names}}'; docker volume ls --format '{{.Name}}'; } | grep -c -E '^pgup-[0-9]+-(target|data)$')"
check 'and the source still runs, unchanged' "running $rows_before" "$(docker inspect -f '{{.State.Status}}' "$C") $(sql "$C" 'select count(*) from public.parts')"

# 2. The comparison is not vacuous: each kind of difference is found and named.
KEEP=1 bash "$UP" rehearse "$C" > "$WORK/keep.out" 2>&1
kept="$(sed -n 's/.*kept as container \([^ ]*\) on volume \([^ ]*\) .*/\1/p' "$WORK/keep.out")"; kept_volume="$(sed -n 's/.*kept as container \([^ ]*\) on volume \([^ ]*\) .*/\2/p' "$WORK/keep.out")"
bash "$UP" verify "$C" "$kept" > "$WORK/verify.out" 2>&1; check 'a kept copy verifies as identical' 0 $?
sql "$kept" "update public.parts set price = price + 0.0001 where id = 7" >/dev/null
bash "$UP" verify "$C" "$kept" > "$WORK/verify.out" 2>&1; check 'one changed value in one row is a difference' 5 $?
has 'named by its table' 'postgres|rows|public.parts' "$WORK/verify.out"
sql "$kept" "update public.parts set price = price - 0.0001 where id = 7; drop policy own_parts on public.parts" >/dev/null
bash "$UP" verify "$C" "$kept" > "$WORK/verify.out" 2>&1; check 'a dropped policy is a difference' 5 $?
has 'named by its policy' 'postgres|policy|public.parts.own_parts' "$WORK/verify.out"
sql "$kept" "create policy own_parts on public.parts for select to authenticated using (owner = current_setting('test.owner', true)); alter role authenticator password 'another'" >/dev/null
bash "$UP" verify "$C" "$kept" > "$WORK/verify.out" 2>&1; check 'a changed password is a difference' 5 $?
has 'named by its role' '^role|authenticator$' "$WORK/verify.out"
check 'and no password hash or digest is printed' 0 "$(grep -c -i -E 'scram|[0-9a-f]{32}' "$WORK/verify.out")"
sql "$kept" "delete from public.old_quotes where id = 3" archive >/dev/null
bash "$UP" verify "$C" "$kept" > "$WORK/verify.out" 2>&1
has 'a missing row in the second database is found too' 'archive|rows|public.old_quotes' "$WORK/verify.out"
docker rm -f "$kept" >/dev/null 2>&1; docker volume rm "$kept_volume" >/dev/null 2>&1; kept=; kept_volume=

# 3. A release that arrives before the data was moved: the new server refuses to start empty, and nothing is lost.
next up -d postgres >/dev/null 2>&1
for _ in $(seq 1 20); do docker logs "$C" 2>&1 | grep -q 'REFUSING TO START' && break; sleep 1; done
docker logs "$C" > "$WORK/refuse.out" 2>&1
has 'without a cutover the new release refuses to start an empty database' 'REFUSING TO START AN EMPTY DATABASE' "$WORK/refuse.out"
check 'and created no database on the new volume' 0 "$(docker run --rm --entrypoint sh -v "${P}_pgdata19:/v" "$OLD_IMAGE" -c 'find /v -name PG_VERSION | wc -l' 2>/dev/null | tr -d ' ')"
next rm -sf postgres >/dev/null 2>&1; docker volume rm "${P}_pgdata19" >/dev/null 2>&1
old up -d --wait postgres >/dev/null 2>&1
check 'the previous release brings the database back, with its data' "17 $rows_before" "$(sql "$C" "select current_setting('server_version_num')::int / 10000") $(sql "$C" 'select count(*) from public.parts')"

# 4. The cutover refuses when it is not safe, and a dry run changes nothing.
docker exec "$C" psql -U postgres -d postgres -q -c "select pg_sleep(25)" >/dev/null 2>&1 &
sleeper=$!; sleep 2
YES=1 bash "$UP" cutover "$C" "${P}_pgdata19" > "$WORK/busy.out" 2>&1; check 'a cutover refuses while another session is connected' 3 $?
has 'and says to stop the writers' 'stop the writers first' "$WORK/busy.out"
sql "$C" "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(25)%' and pid <> pg_backend_pid()" >/dev/null; wait "$sleeper" 2>/dev/null
docker volume create "$P-taken" >/dev/null
YES=1 bash "$UP" cutover "$C" "$P-taken" > "$WORK/taken.out" 2>&1; check 'a cutover refuses a volume that already exists' 3 $?
DRY_RUN=1 bash "$UP" cutover "$C" "${P}_pgdata19" > "$WORK/dry.out" 2>&1; check 'a dry run succeeds' 0 $?
has 'and prints the plan' 'DRY_RUN: nothing was changed' "$WORK/dry.out"
check 'and creates nothing' 'running 1' "$(docker inspect -f '{{.State.Status}}' "$C") $(docker volume inspect "${P}_pgdata19" >/dev/null 2>&1; echo $?)"
echo no | bash "$UP" cutover "$C" "${P}_pgdata19" > "$WORK/no.out" 2>&1; check 'anything but GO is not a confirmation' 1 $?

# 5. The cutover.
hash_before="$(sql "$C" "select md5(rolpassword) from pg_authid where rolname = 'authenticator'")"
YES=1 COMPOSE_PROJECT="$P" bash "$UP" cutover "$C" "${P}_pgdata19" > "$WORK/cutover.out" 2>&1; check 'the cutover succeeds' 0 $?
has 'after verifying the copy' 'OK: the copy is identical to the source' "$WORK/cutover.out"
check 'the old server is stopped, and its volume is still there' 'exited 0' "$(docker inspect -f '{{.State.Status}}' "$C") $(docker volume inspect "${P}_pgdata" >/dev/null 2>&1; echo $?)"
next up -d --wait postgres > "$WORK/up.out" 2>&1; check 'the new release starts on the moved data' 0 $?
check 'and adopts the volume without complaint' 0 "$(grep -c -i 'not created by' "$WORK/up.out")"
check 'on Postgres 19, with every row' "19 $rows_before" "$(sql "$C" "select current_setting('server_version_num')::int / 10000") $(sql "$C" 'select count(*) from public.parts')"
check 'the sequence carries on from where it was' "$((next_id_before + 1))" "$(sql "$C" "insert into public.parts (owner) values ('carol') returning id" | head -1)"
check "the data API's role keeps its password and its setting" "$hash_before statement_timeout=8s" "$(sql "$C" "select md5(a.rolpassword) || ' ' || array_to_string(s.setconfig, ',') from pg_authid a join pg_db_role_setting s on s.setrole = a.oid where a.rolname = 'authenticator'")"
check 'row-level security still decides what a user sees' '163' "$(sql "$C" "set role authenticated; set test.owner = 'alice'; select count(*) from public.parts")"
check 'the second database came too' 40 "$(sql "$C" 'select count(*) from public.old_quotes' archive)"

# 6. The way back: the old volume was never written to.
next rm -sf postgres >/dev/null 2>&1
old up -d --wait postgres >/dev/null 2>&1
check 'going back to the previous release finds the Postgres 17 data as the cutover left it' "17 $rows_before $next_id_before" \
  "$(sql "$C" "select current_setting('server_version_num')::int / 10000") $(sql "$C" 'select count(*) from public.parts') $(sql "$C" 'select last_value from public.parts_id_seq')"

# 7. A new installation has no old data: it starts empty on the new version.
fresh up -d --wait postgres >/dev/null 2>&1; check 'a new installation starts' 0 $?
check 'empty, on Postgres 19' '19 0' "$(sql "$F-postgres-1" "select current_setting('server_version_num')::int / 10000") $(sql "$F-postgres-1" "select count(*) from information_schema.tables where table_schema = 'public'")"
exit $failed

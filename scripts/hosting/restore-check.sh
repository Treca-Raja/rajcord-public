#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || fail 'Usage: restore-check.sh staging|production'
initialize_host "$1"
lock_environment
load_backup_config
command -v jq >/dev/null || fail 'Install jq on the server.'
work=$(mktemp -d "/var/tmp/tricord-$TRICORD_ENVIRONMENT-restore.XXXXXXXX")
name="tricord-restorecheck-$(openssl rand -hex 6)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Only the private random directory created by this invocation is removed.
  [[ $work == "/var/tmp/tricord-$TRICORD_ENVIRONMENT-restore."* ]] && rm -rf -- "$work"
}
trap cleanup EXIT
restic restore latest --host "tricord-$TRICORD_ENVIRONMENT" --tag "tricord-$TRICORD_ENVIRONMENT" --target "$work" --quiet
[[ -s $work/database.dump ]] || fail 'The off-server snapshot has no database dump.'
pg_image=$(compose config --format json | jq -er '.services.postgres.image')
printf 'POSTGRES_USER=tricord\nPOSTGRES_DB=tricord_restorecheck\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" >"$work/postgres.env"
docker run -d --name "$name" --network none --tmpfs /var/lib/postgresql/data --env-file "$work/postgres.env" "$pg_image" >/dev/null
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$name" pg_isready -U tricord -d tricord_restorecheck >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || fail 'Disposable restore database did not start.'
docker exec -i "$name" pg_restore -U tricord -d tricord_restorecheck --exit-on-error --no-owner --no-privileges <"$work/database.dump"
result=$(docker exec "$name" psql -U tricord -d tricord_restorecheck -At -v ON_ERROR_STOP=1 -c "SELECT count(*) > 0 FROM drizzle.__drizzle_migrations; SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.messages') IS NOT NULL AND to_regclass('public.conversation_reads') IS NOT NULL;")
[[ $result == $'t\nt' ]] || fail 'Restored application schema is incomplete.'
date -u +%s >"$TRICORD_CONFIG_DIR/last-restore-check"
printf 'Off-server backup restored and schema checked in an isolated tmpfs container.\n'

#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || fail 'Usage: backup.sh staging|production'
initialize_host "$1"
lock_environment
backup_database
# Apply retention only to this environment's snapshots, never another host's.
restic forget --quiet --host "tricord-$TRICORD_ENVIRONMENT" --tag "tricord-$TRICORD_ENVIRONMENT" --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6

#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || fail 'Usage: check.sh staging|production'
initialize_host "$1"
lock_environment
curl --fail --silent --show-error --noproxy '*' --max-time 20 --resolve "$public_host:443:127.0.0.1" "https://$public_host/ready" >/dev/null
check_voice
check_turn_tls
openssl x509 -checkend 172800 -noout -in "$TRICORD_CONFIG_DIR/letsencrypt/live/tricord/fullchain.pem" >/dev/null || fail 'Certificate expires within 48 hours.'
[[ ! -e $TRICORD_CONFIG_DIR/letsencrypt/.reload-required ]] || fail 'Certificate service reload is pending.'
[[ -f $TRICORD_CONFIG_DIR/last-backup ]] || fail 'No successful off-server backup recorded.'
backup_time=$(cat "$TRICORD_CONFIG_DIR/last-backup")
[[ $backup_time =~ ^[0-9]+$ ]] || fail 'Invalid backup timestamp.'
(( $(date -u +%s) - backup_time < 90000 )) || fail 'Off-server backup is more than 25 hours old.'
[[ -f $TRICORD_CONFIG_DIR/last-restore-check ]] || fail 'Run the off-server restore check before inviting users.'
restore_time=$(cat "$TRICORD_CONFIG_DIR/last-restore-check")
[[ $restore_time =~ ^[0-9]+$ ]] || fail 'Invalid restore-check timestamp.'
(( $(date -u +%s) - restore_time < 691200 )) || fail 'Off-server restore check is more than eight days old.'
usage=$(df -P /var/lib/docker | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [[ ! $usage =~ ^[0-9]+$ ]] || (( usage >= 85 )); then
  fail 'Docker disk usage is at least 85%, or could not be checked.'
fi
printf 'HTTPS, database, certificate, backup freshness and disk checks passed.\n'

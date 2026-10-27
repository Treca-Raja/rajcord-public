#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 3 ]] || fail 'Usage: deploy.sh staging|production IMAGE_DIGEST COMMIT_SHA'
validate_image "$2"
validate_commit "$3"
export TRICORD_IMAGE=$2
initialize_host "$1"
[[ $release_root == "/opt/tricord/releases/$3" ]] || fail 'Run the release scripts from their matching immutable commit directory.'
lock_environment
for command in docker curl restic flock; do command -v "$command" >/dev/null || fail "Missing server prerequisite: $command"; done
load_backup_config
[[ -s $TRICORD_CONFIG_DIR/letsencrypt/live/tricord/fullchain.pem ]] || fail 'Bootstrap trusted HTTPS before deploying.'
compose config --quiet
compose pull --quiet app postgres livekit proxy
compose up -d --wait --wait-timeout 120 postgres
# Quiesce writes so this dump is the exact recovery point before migration.
compose stop app
backup_database
trap 'printf "%s\n" "Deployment stopped. Inspect the server; no automatic database rollback was attempted." >&2' ERR
compose run --interactive=false -T --rm --no-deps app node dist/migrate.js
compose up -d --wait --wait-timeout 180 app proxy
check_voice
check_turn_tls
curl --fail --silent --show-error --noproxy '*' --max-time 20 --resolve "$public_host:443:127.0.0.1" "https://$public_host/ready" >/dev/null
printf '%s\n' "$TRICORD_IMAGE" >"$TRICORD_CONFIG_DIR/image.next"
printf '%s\n' "$3" >"$TRICORD_CONFIG_DIR/commit.next"
mv -- "$TRICORD_CONFIG_DIR/image.next" "$TRICORD_CONFIG_DIR/image"
mv -- "$TRICORD_CONFIG_DIR/commit.next" "$TRICORD_CONFIG_DIR/commit"
ln -sfn -- "$release_root" "/opt/tricord/$TRICORD_ENVIRONMENT-current.next"
mv -Tf -- "/opt/tricord/$TRICORD_ENVIRONMENT-current.next" "/opt/tricord/$TRICORD_ENVIRONMENT-current"
printf 'Healthy %s deployment: %s\n' "$TRICORD_ENVIRONMENT" "$3"

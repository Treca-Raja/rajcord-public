#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || fail 'Usage: renew.sh staging|production'
initialize_host "$1"
lock_environment
compose run --interactive=false -T --rm --no-deps certbot renew --non-interactive --cert-name tricord --deploy-hook 'touch /etc/letsencrypt/.reload-required'
if [[ -f $TRICORD_CONFIG_DIR/letsencrypt/.reload-required ]]; then
  compose exec -T proxy nginx -t
  compose exec -T proxy nginx -s reload
  # LiveKit reads its TURN TLS certificate at startup. Existing calls may reconnect.
  compose restart livekit
  check_voice
  check_turn_tls
  rm -- "$TRICORD_CONFIG_DIR/letsencrypt/.reload-required"
fi
openssl x509 -checkend 172800 -noout -in "$TRICORD_CONFIG_DIR/letsencrypt/live/tricord/fullchain.pem" || fail 'Certificate expires within 48 hours.'

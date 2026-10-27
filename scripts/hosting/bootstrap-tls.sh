#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=scripts/hosting/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 || $# == 2 ]] || fail 'Usage: bootstrap-tls.sh staging|production [ACME_CONTACT_EMAIL]'
contact_args=(--register-unsafely-without-email)
if [[ $# == 2 ]]; then
  [[ $2 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail 'Supply a valid ACME contact email or omit it.'
  contact_args=(--email "$2")
fi
initialize_host "$1"
lock_environment
[[ ! -e $TRICORD_CONFIG_DIR/letsencrypt/live/tricord ]] || fail 'A certificate already exists; use renew.sh.'
bootstrap_compose up -d proxy
trap 'bootstrap_compose stop proxy' EXIT
certificate_args=(-d "$public_host")
if [[ $public_host == "$public_ip" ]]; then
  certificate_args=(--preferred-profile shortlived --ip-address "$public_ip")
elif [[ $turn_host != "$public_host" ]]; then
  certificate_args+=(-d "$turn_host")
fi
bootstrap_compose run --interactive=false -T --rm certbot certonly --non-interactive --agree-tos "${contact_args[@]}" --webroot --webroot-path /var/www/acme "${certificate_args[@]}" --cert-name tricord
printf 'Certificate issued. Deploy the tested image next.\n'

#!/usr/bin/env bash
# Shared by operator scripts. Runtime configuration stays on the server.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
validate_environment() { [[ ${1:-} == staging || ${1:-} == production ]] || fail 'Use staging or production.'; }
validate_image() { [[ ${1:-} =~ ^ghcr\.io/fakebane/tricord-public@sha256:[0-9a-f]{64}$ ]] || fail 'Use the tested GHCR image by sha256 digest.'; }
validate_commit() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || fail 'Use a full commit SHA.'; }

initialize_host() {
  validate_environment "${1:-}"
  [[ $EUID == 0 ]] || fail 'Run this operator script as root.'
  export TRICORD_ENVIRONMENT=$1
  export TRICORD_CONFIG_DIR=/etc/tricord/$1
  [[ -d $TRICORD_CONFIG_DIR && ! -L $TRICORD_CONFIG_DIR ]] || fail 'Initialize the server runtime directory first.'
  [[ $(cat "$TRICORD_CONFIG_DIR/environment") == "$1" ]] || fail 'Runtime environment marker does not match.'
  [[ $(stat -c %u "$TRICORD_CONFIG_DIR") == 0 && $(stat -c %a "$TRICORD_CONFIG_DIR") == 700 ]] || fail 'Runtime directory must be root-owned with mode 700.'
  if [[ ! -f /etc/tricord/host-environment ]]; then
    (set -o noclobber; printf '%s\n' "$1" >/etc/tricord/host-environment) 2>/dev/null || true
  fi
  [[ $(cat /etc/tricord/host-environment) == "$1" ]] || fail 'This host belongs to the other environment. Use a separate server.'
  public_ip=$(cat "$TRICORD_CONFIG_DIR/public-ip")
  [[ $public_ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail 'Invalid configured public IPv4.'
  public_host=$public_ip
  turn_host=$public_ip
  if [[ -f $TRICORD_CONFIG_DIR/public-host ]]; then public_host=$(cat "$TRICORD_CONFIG_DIR/public-host"); fi
  if [[ -f $TRICORD_CONFIG_DIR/turn-host ]]; then turn_host=$(cat "$TRICORD_CONFIG_DIR/turn-host"); fi
  for hostname in "$public_host" "$turn_host"; do
    [[ $hostname =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ && $hostname != *..* && ${#hostname} -le 253 ]] || fail 'Invalid configured TLS hostname.'
  done
  release_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
  export TRICORD_IMAGE=${TRICORD_IMAGE:-}
  if [[ -z $TRICORD_IMAGE && -f $TRICORD_CONFIG_DIR/image ]]; then
    TRICORD_IMAGE=$(cat "$TRICORD_CONFIG_DIR/image")
  fi
  # Bootstrap and first backup need interpolation before the first release exists.
  TRICORD_IMAGE=${TRICORD_IMAGE:-ghcr.io/fakebane/tricord-public@sha256:0000000000000000000000000000000000000000000000000000000000000000}
  validate_image "$TRICORD_IMAGE"
}

lock_environment() {
  exec 9>"/run/lock/tricord-$TRICORD_ENVIRONMENT.lock"
  flock -w 600 9 || fail 'Another operation holds the environment lock.'
}

compose() { docker compose --project-name "tricord-$TRICORD_ENVIRONMENT" --file "$release_root/infrastructure/hosting/compose.yaml" "$@"; }
bootstrap_compose() { docker compose --project-name "tricord-$TRICORD_ENVIRONMENT" --file "$release_root/infrastructure/hosting/compose.bootstrap.yaml" "$@"; }

check_voice() {
  compose exec -T app node --input-type=module -e '
    import {RoomServiceClient} from "livekit-server-sdk";
    import {setTimeout as delay} from "node:timers/promises";
    const client = new RoomServiceClient(process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await client.listRooms(); ready = true; break; } catch { await delay(1000); }
    }
    if (!ready) { console.error("Private voice control is unavailable."); process.exitCode = 1; }
  '
}

check_turn_tls() {
  local identity_args=(-verify_hostname "$turn_host" -servername "$turn_host")
  if [[ $turn_host == "$public_ip" ]]; then identity_args=(-verify_ip "$public_ip"); fi
  timeout 20 openssl s_client -connect 127.0.0.1:5349 "${identity_args[@]}" -verify_return_error </dev/null >/dev/null 2>&1 || fail 'TURN TLS listener or its certificate is unavailable.'
}

load_backup_config() {
  local config="$TRICORD_CONFIG_DIR/restic.env"
  [[ -f $config && ! -L $config && $(stat -c %u "$config") == 0 && $(stat -c %a "$config") == 600 ]] || fail 'Configure root-owned restic.env (mode 600) and initialize its private repository first.'
  set -a
  # This is a root-managed shell environment file, never supplied by CI.
  # shellcheck source=/dev/null
  source "$config"
  set +a
  case ${RESTIC_REPOSITORY:-} in
    sftp:*|s3:https://*|b2:*|azure:*|gs:*) ;;
    *) fail 'Backups require a private off-server restic repository.' ;;
  esac
  command -v restic >/dev/null || fail 'Install restic on the server.'
}

backup_database() {
  load_backup_config
  local dump_dir dump
  dump_dir=$(mktemp -d "/var/tmp/tricord-$TRICORD_ENVIRONMENT-backup.XXXXXXXX")
  dump="$dump_dir/database.dump"
  if ! compose exec -T postgres pg_dump -U tricord -d tricord --format=custom >"$dump"; then
    rm -f -- "$dump"; rmdir -- "$dump_dir"
    fail 'Database dump failed; deployment stopped.'
  fi
  if ! restic backup --quiet --host "tricord-$TRICORD_ENVIRONMENT" --tag "tricord-$TRICORD_ENVIRONMENT" --stdin --stdin-filename database.dump <"$dump"; then
    rm -f -- "$dump"; rmdir -- "$dump_dir"
    fail 'Off-server backup failed; deployment stopped.'
  fi
  rm -f -- "$dump"; rmdir -- "$dump_dir"
  date -u +%s >"$TRICORD_CONFIG_DIR/last-backup"
  printf 'Encrypted off-server %s backup completed.\n' "$TRICORD_ENVIRONMENT"
}

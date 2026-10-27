#!/usr/bin/env bash
# Generate secrets on the host using the pinned Node runtime, without host Node.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 4 ]] || { printf 'Usage (root): initialize-runtime.sh production|staging PUBLIC_IPV4 WEB_HOST TURN_HOST\n' >&2; exit 1; }
[[ $1 == production || $1 == staging ]] || exit 1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
runtime_image=$(awk '$1=="FROM" && $2 ~ /^node:24-bookworm-slim@sha256:/ {print $2}' "$root/infrastructure/server/Dockerfile")
[[ $runtime_image =~ ^node:24-bookworm-slim@sha256:[a-f0-9]{64}$ ]] || { printf 'Expected the pinned Node runtime in the server Dockerfile.\n' >&2; exit 1; }
[[ ! -e /etc/tricord/$1 ]] || { printf 'Runtime already exists; credentials were not changed.\n' >&2; exit 1; }
install -d -m 700 /etc/tricord
docker run --rm --network none --user 0 --mount "type=bind,source=$root,target=/source,readonly" --mount type=bind,source=/etc/tricord,target=/runtime "$runtime_image" node /source/scripts/hosting/init.mjs "$1" "$2" "/runtime/$1" "$3" "$4"

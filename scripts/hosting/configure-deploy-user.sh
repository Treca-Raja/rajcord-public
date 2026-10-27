#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && -f $1 ]] || { printf 'Usage (root): configure-deploy-user.sh CI_PUBLIC_KEY_FILE\n' >&2; exit 1; }
ssh-keygen -lf "$1" >/dev/null
public_key=$(cat -- "$1")
[[ $public_key == ssh-ed25519\ * && $(wc -l <"$1") -eq 1 ]] || { printf 'Use one dedicated Ed25519 public key.\n' >&2; exit 1; }
if ! id tricord-deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' tricord-deploy
fi
[[ $(getent passwd tricord-deploy | cut -d: -f6) == /home/tricord-deploy ]] || { printf 'Unexpected deployment account home; inspect before changing it.\n' >&2; exit 1; }
install -d -m 700 -o tricord-deploy -g tricord-deploy /home/tricord-deploy/.ssh
authorized=/home/tricord-deploy/.ssh/authorized_keys
touch "$authorized"
if ! grep -qxF "$public_key" "$authorized"; then printf '%s\n' "$public_key" >>"$authorized"; fi
chown tricord-deploy:tricord-deploy "$authorized"
chmod 600 "$authorized"
install -d -m 755 /opt/tricord
install -d -m 755 -o tricord-deploy -g tricord-deploy /opt/tricord/releases
sudoers=/etc/sudoers.d/tricord-deploy
temporary=$(mktemp /etc/sudoers.d/.tricord-deploy.XXXXXXXX)
trap 'rm -f -- "$temporary"' EXIT
printf 'tricord-deploy ALL=(root) NOPASSWD: /usr/bin/bash /opt/tricord/releases/*/scripts/hosting/deploy.sh *\n' >"$temporary"
chmod 440 "$temporary"
visudo -cf "$temporary"
if [[ -e $sudoers ]]; then
  cmp -s "$temporary" "$sudoers" || { printf 'Existing deployment sudo policy differs; inspect it first.\n' >&2; exit 1; }
else
  mv -- "$temporary" "$sudoers"
fi
printf 'Dedicated deployment user and SSH key configured. Treat CI access as privileged.\n'

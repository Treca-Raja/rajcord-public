#!/usr/bin/env bash
# Apply only after an independent SSH key login has succeeded.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && -s /root/.ssh/authorized_keys ]] || { printf 'Verified root key access is required.\n' >&2; exit 1; }
target=/etc/ssh/sshd_config.d/00-tricord-key-only.conf
created=false
if [[ ! -e $target ]]; then
  created=true
  cat >"$target" <<'SSH'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSH
fi
if ! /usr/sbin/sshd -t; then
  if [[ $created == true ]]; then rm -- "$target"; fi
  printf 'Invalid SSH configuration; no reload occurred.\n' >&2
  exit 1
fi
effective_policy=$(/usr/sbin/sshd -T)
grep -qx 'passwordauthentication no' <<<"$effective_policy"
grep -qx 'kbdinteractiveauthentication no' <<<"$effective_policy"
grep -qx 'pubkeyauthentication yes' <<<"$effective_policy"
grep -qx 'permitrootlogin without-password' <<<"$effective_policy"
systemctl reload ssh
printf 'SSH keys remain enabled; remote password and keyboard-interactive authentication disabled.\n'

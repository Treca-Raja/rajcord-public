#!/usr/bin/env bash
# Disposable-container regression; never run on an operator's host.
set -Eeuo pipefail
[[ -f /.dockerenv && ! -S /var/run/docker.sock && -d /fixture/scripts/hosting ]] || exit 1
mkdir -p /root/.ssh /etc/ssh/sshd_config.d
printf 'disposable-public-key-placeholder\n' >/root/.ssh/authorized_keys
cat >/usr/sbin/sshd <<'MOCK'
#!/usr/bin/env bash
if [[ $1 == -t ]]; then [[ ! -f /tmp/ssh-invalid ]]; exit; fi
if [[ -f /tmp/ssh-wrong-policy ]]; then printf 'passwordauthentication yes\n'; else printf 'passwordauthentication no\n'; fi
printf 'kbdinteractiveauthentication no\npubkeyauthentication yes\npermitrootlogin without-password\n'
# Exceed a pipe buffer: a grep -q pipeline under pipefail would exit on SIGPIPE.
for ((line=0;line<8192;line++)); do printf 'unused-configuration-field value\n'; done
MOCK
cat >/usr/local/bin/systemctl <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/ssh-reloads
MOCK
chmod 755 /usr/sbin/sshd /usr/local/bin/systemctl
target=/etc/ssh/sshd_config.d/00-tricord-key-only.conf
touch /tmp/ssh-invalid
if bash /fixture/scripts/hosting/harden-ssh.sh >/dev/null 2>&1; then exit 1; fi
[[ ! -e $target && ! -e /tmp/ssh-reloads ]]
rm /tmp/ssh-invalid
bash /fixture/scripts/hosting/harden-ssh.sh >/dev/null
grep -qx 'reload ssh' /tmp/ssh-reloads
before=$(sha256sum "$target")
bash /fixture/scripts/hosting/harden-ssh.sh >/dev/null
[[ $(sha256sum "$target") == "$before" ]]
rm /tmp/ssh-reloads
touch /tmp/ssh-wrong-policy
if bash /fixture/scripts/hosting/harden-ssh.sh >/dev/null 2>&1; then exit 1; fi
[[ -f $target && ! -e /tmp/ssh-reloads ]]
printf 'PASS: invalid SSH configuration is not reloaded; existing files survive; large policy output cannot cause a SIGPIPE failure.\n'

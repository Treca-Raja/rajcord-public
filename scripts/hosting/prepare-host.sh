#!/usr/bin/env bash
# First-host preparation. Does not deploy the app or initialize a database.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { printf 'This preparation targets Ubuntu 24.04.\n' >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { printf 'Expected the selected x86-64 VPS.\n' >&2; exit 1; }
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if command -v docker >/dev/null && [[ -n $(docker ps -aq) ]] && [[ ! -f /etc/tricord/host-prepared ]]; then
  printf 'Existing containers require operator review before first-host preparation.\n' >&2; exit 1
fi
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
    printf 'Conflicting existing package %s requires review; nothing will be removed.\n' "$package" >&2; exit 1
  fi
done
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq restic ufw openssl iptables unattended-upgrades sudo
install -d -m 755 /etc/apt/keyrings
if [[ ! -f /etc/apt/sources.list.d/docker.sources ]]; then
  [[ ! -e /etc/apt/sources.list.d/docker.list ]] || { printf 'Review the existing Docker repository first.\n' >&2; exit 1; }
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<'SOURCE'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
SOURCE
  chmod 644 /etc/apt/sources.list.d/docker.sources
fi
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
install -d -m 700 /etc/tricord
install -d -m 755 /opt/tricord /opt/tricord/releases
if [[ ! -e /etc/docker/daemon.json ]]; then
  printf '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}\n' >/etc/docker/daemon.json
  chmod 644 /etc/docker/daemon.json
  systemctl restart docker
fi
docker info --format '{{.ServerVersion}}'
docker compose version
restic version

# Host input policy is separate from Docker forwarding; both must be configured.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'Tricord SSH keys'
for port in 80 443 7881 5349; do ufw allow "$port/tcp" comment 'Tricord public service'; done
for port in 3478 7882 50000:50199; do ufw allow "$port/udp" comment 'Tricord public media'; done
ufw --force enable
install -m 755 "$script_directory/firewall.sh" /usr/local/sbin/tricord-docker-firewall
install -d -m 755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/20-tricord-firewall.conf <<'UNIT'
[Service]
ExecStartPost=/usr/local/sbin/tricord-docker-firewall
UNIT
chmod 644 /etc/systemd/system/docker.service.d/20-tricord-firewall.conf
systemctl daemon-reload
/usr/local/sbin/tricord-docker-firewall

# Keep kernel/SSH security updates enabled but do not trigger unplanned reboots.
cat >/etc/apt/apt.conf.d/52tricord-unattended <<'UPDATES'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
UPDATES
chmod 644 /etc/apt/apt.conf.d/52tricord-unattended
date -u +%FT%TZ >/etc/tricord/host-prepared
printf 'Host tools and firewall prepared; SSH authentication policy is unchanged.\n'

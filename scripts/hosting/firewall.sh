#!/usr/bin/env bash
# Keep Docker's forwarding rules and restrict newly forwarded WAN connections.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
wan_interface=${TRICORD_WAN_INTERFACE:-$(ip -4 route show default | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')}
[[ $wan_interface =~ ^[a-zA-Z0-9_.:-]+$ ]] || { printf 'No valid WAN interface found.\n' >&2; exit 1; }

configure_family() {
  local command=$1
  "$command" -w 10 -nL DOCKER-USER >/dev/null 2>&1 || return 0
  if ! "$command" -w 10 -nL TRICORD-INGRESS >/dev/null 2>&1; then
    "$command" -w 10 -N TRICORD-INGRESS
  fi
  # This chain belongs to this script; never flush Docker's or the host's chains.
  "$command" -w 10 -F TRICORD-INGRESS
  "$command" -w 10 -A TRICORD-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for port in 80 443 7881 5349; do
    "$command" -w 10 -A TRICORD-INGRESS -i "$wan_interface" -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport "$port" -j RETURN
  done
  for port in 3478 7882 50000:50199; do
    "$command" -w 10 -A TRICORD-INGRESS -i "$wan_interface" -p udp -m conntrack --ctdir ORIGINAL --ctorigdstport "$port" -j RETURN
  done
  "$command" -w 10 -A TRICORD-INGRESS -i "$wan_interface" -j DROP
  "$command" -w 10 -A TRICORD-INGRESS -j RETURN
  if ! "$command" -w 10 -C DOCKER-USER -j TRICORD-INGRESS >/dev/null 2>&1; then
    "$command" -w 10 -I DOCKER-USER 1 -j TRICORD-INGRESS
  fi
}

iptables -w 10 -nL DOCKER-USER >/dev/null
configure_family iptables
configure_family ip6tables
printf 'Docker WAN forwarding filter configured on %s.\n' "$wan_interface"

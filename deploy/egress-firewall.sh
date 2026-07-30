#!/usr/bin/env bash
set -euo pipefail

readonly CHAIN="EXTRACT_CRAWL_EGRESS"
readonly NETWORK="${CRAWL4AI_DOCKER_NETWORK:-services_default}"
readonly IPTABLES="$(command -v iptables)"

if [[ "${1:-}" != "apply" ]]; then
  echo "usage: $0 apply" >&2
  exit 2
fi

subnet="$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Subnet}}')"
if [[ ! "$subnet" =~ ^[0-9.]+/[0-9]+$ ]]; then
  echo "invalid IPv4 subnet for Docker network $NETWORK: $subnet" >&2
  exit 1
fi

"$IPTABLES" -w -N "$CHAIN" 2>/dev/null || true
"$IPTABLES" -w -F "$CHAIN"
"$IPTABLES" -w -A "$CHAIN" ! -s "$subnet" -j RETURN
for destination in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.0.0/24 \
  192.0.2.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  198.51.100.0/24 \
  203.0.113.0/24 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  "$IPTABLES" -w -A "$CHAIN" -d "$destination" -j REJECT --reject-with icmp-port-unreachable
done
"$IPTABLES" -w -A "$CHAIN" -j RETURN
"$IPTABLES" -w -C DOCKER-USER -j "$CHAIN" 2>/dev/null || \
  "$IPTABLES" -w -I DOCKER-USER 1 -j "$CHAIN"

logger -t extract-egress "restricted $NETWORK ($subnet) from private and non-routable IPv4 destinations"

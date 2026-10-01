#!/usr/bin/env bash
# NETPID WireGuard helper — the ONLY privileged path the worker has.
#
# PREREQUISITE — THE UNIT MUST NOT SET NoNewPrivileges=true
#   The worker reaches this helper through `sudo -n`. NoNewPrivileges makes the
#   kernel refuse setuid binaries, so sudo can never work: the tunnel is never
#   created and the only symptom is
#     sudo: The "no new privileges" flag is set, which prevents sudo from
#     running as root.
#   in the worker log, with no other error. Every other hardening flag in
#   netpid-worker.service is fine and should stay.
#
# INSTALL
#   bash deploy/wireguard-helper.sh --install     # writes /usr/local/sbin/netpid-wg
#   and grant the worker access with a scoped rule in /etc/sudoers.d/netpid-wg:
#     netpid ALL=(root) NOPASSWD: /usr/local/sbin/netpid-wg *
#
# ONE INTERFACE PER ROUTER — WHY NOT A SHARED wg0
#   Each router_tunnels row owns its own key pair AND its own /30. A single
#   shared interface has exactly one private key and one address, so it cannot
#   simultaneously be 10.90.0.1/30, 10.90.1.1/30 and 10.90.2.1/30. Sharing one
#   interface would also mean a single key compromise exposes every router at
#   once, and a rotate on one router would break all the others. So each tunnel
#   gets its own interface, named deterministically from the tunnel id.
#
# PERSISTENCE
#   Peers added with `wg set` live only in the kernel and vanish on reboot.
#   Every change is therefore written to a wg-quick config file and applied
#   with `wg syncconf`, so a reboot restores exactly the intended state.
#
# USAGE
#   netpid-wg apply <tunnel_id> <server_priv|-> <server_pub> <router_pub|-> \
#                   <router_ip> <vps_ip> <port> <keep|rotate>
#   netpid-wg remove <tunnel_id>
#   netpid-wg dump
#   netpid-wg reconcile
#
#   The server private key is passed on STDIN (as "-"), never as an argument,
#   so it never appears in the process list.
set -euo pipefail

WG_ROOT=/etc/wireguard
NETPID_DIR=$WG_ROOT/netpid
# Interface names are capped at 15 characters by the kernel. "nwg-" plus 10 hex
# derived from the tunnel id is 14 characters and is stable per tunnel.
IFACE_PREFIX=nwg-
IFACE_HASH_LEN=10

# A WireGuard key is 32 bytes: 43 base64 characters plus one '='.
is_key()  { [[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]]; }
is_id()   { [[ "$1" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; }
is_ip()   { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
is_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
die() { echo "netpid-wg: $*" >&2; exit 1; }

# Derived, never passed in: the worker cannot choose an interface name, so it
# cannot reach another tunnel's interface by naming it.
iface_for() {
  printf '%s%s' "$IFACE_PREFIX" \
    "$(printf '%s' "$1" | md5sum | cut -c1-"$IFACE_HASH_LEN")"
}

# A fingerprint of what cannot change on a live interface. If it differs from
# the last apply, the interface must be cycled: a private key and an address
# are fixed when the interface is created.
state_file() { echo "$NETPID_DIR/$1.state"; }

is_up() { ip link show "$1" >/dev/null 2>&1; }

# Persistence for the one sysctl a routed tunnel needs, in its own file so a
# reboot restores it without depending on this script running again.
ensure_forwarding() {
  local f=/etc/sysctl.d/99-netpid-wireguard.conf
  if ! grep -q '^net.ipv4.ip_forward=1$' "$f" 2>/dev/null; then
    printf 'net.ipv4.ip_forward=1\n' > "$f"
  fi
  sysctl -q -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
}

write_conf() {
  local iface=$1 priv=$2 vps_ip=$3 port=$4 router_pub=$5 router_ip=$6
  local conf=$WG_ROOT/$iface.conf
  # Written to a temp file then renamed so wg-quick never reads a half-written
  # config, and never sees the private key at a wider mode.
  local tmp; tmp=$(mktemp "$WG_ROOT/.netpid.XXXXXX"); chmod 600 "$tmp"
  {
    echo "[Interface]"
    echo "PrivateKey = $priv"
    echo "ListenPort = $port"
    echo "Address = $vps_ip/32"
    if [ -n "$router_pub" ]; then
      echo ""
      echo "[Peer]"
      echo "PublicKey = $router_pub"
      echo "AllowedIPs = $router_ip/32"
      # Routers sit behind CGNAT often enough that without a keepalive the
      # tunnel only exists while the router happens to initiate.
      echo "PersistentKeepalive = 25"
    fi
  } > "$tmp"
  mv "$tmp" "$conf"
  chmod 600 "$conf"
}

cmd_apply() {
  local tunnel_id=$1 priv=$2 pub=$3 router_pub=$4 router_ip=$5 vps_ip=$6 port=$7 keymode=$8
  is_id "$tunnel_id" || die "bad tunnel id"
  is_key "$pub"      || die "bad server public key"
  is_port "$port"    || die "bad listen port"
  is_ip "$vps_ip"    || die "bad vps tunnel ip"
  [[ "$keymode" == keep || "$keymode" == rotate ]] || die "bad key mode"

  # The private key arrives on stdin, never in argv. A command line is visible
  # to every user on the host through /proc, so passing the key as an argument
  # would leak it to anything running as another user. "-" means "read stdin".
  if [ "$priv" = "-" ]; then
    priv=$(cat)
  fi
  is_key "$priv" || die "bad server private key"
  if [ "$router_pub" != "-" ]; then
    is_key "$router_pub" || die "bad router public key"
    is_ip "$router_ip"   || die "bad router tunnel ip"
  else
    router_pub=""; router_ip=""
  fi

  # The interface must actually present this key pair, or the router would
  # build a peer for a public key the VPS is not using and never handshake.
  local derived; derived=$(printf '%s' "$priv" | wg pubkey 2>/dev/null || true)
  [ "$derived" = "$pub" ] || die "private key does not match the stored public key"

  local iface; iface=$(iface_for "$tunnel_id")
  mkdir -p "$NETPID_DIR"; chmod 700 "$NETPID_DIR"

  # A rotation is explicit: the previous key is discarded, never retained.
  [ "$keymode" = rotate ] && rm -f "$(state_file "$tunnel_id")" || true

  write_conf "$iface" "$priv" "$vps_ip" "$port" "$router_pub" "$router_ip"

  local sf; sf=$(state_file "$tunnel_id")
  local fp
  fp=$(printf '%s|%s|%s|%s' "$priv" "$vps_ip" "$port" "$router_pub" | md5sum | cut -d' ' -f1)
  local changed=1
  if [ -f "$sf" ] && [ "$(cat "$sf")" = "$fp" ] && is_up "$iface"; then
    changed=0
  fi

  # A changed key or address cannot be applied to a live interface.
  if [ "$changed" = 1 ] && is_up "$iface"; then
    wg-quick down "$iface" >/dev/null 2>&1 || true
  fi

  if is_up "$iface"; then
    # Same key and address: reconcile peers without dropping traffic.
    wg syncconf "$iface" <(wg-quick strip "$iface")
  else
    wg-quick up "$iface" >/dev/null
  fi

  printf '%s' "$fp" > "$sf"; chmod 600 "$sf"
  ensure_forwarding

  if [ -z "$router_pub" ]; then
    echo "interface $iface is up; waiting for the router public key"
  else
    echo "tunnel $tunnel_id live on $iface ($router_ip -> $vps_ip:$port)"
  fi
}

cmd_remove() {
  local tunnel_id=$1
  is_id "$tunnel_id" || die "bad tunnel id"
  local iface; iface=$(iface_for "$tunnel_id")
  if is_up "$iface"; then
    wg-quick down "$iface" >/dev/null 2>&1 || true
  fi
  rm -f "$WG_ROOT/$iface.conf" "$(state_file "$tunnel_id")"
  # The UDP port is deliberately left in UFW: with no interface listening the
  # rule is inert, and deleting a port rule by number can remove an operator's
  # unrelated allowance.
  echo "tunnel $tunnel_id removed (interface $iface)"
}

cmd_dump() {
  # Only NETPID-owned interfaces, so an operator's hand-built tunnel is never
  # reported as a NETPID tunnel and never written back to the database.
  local any=0 first=1 c iface
  for c in "$WG_ROOT"/${IFACE_PREFIX}*.conf; do
    [ -e "$c" ] || continue
    iface=$(basename "$c" .conf)
    is_up "$iface" || continue
    # `wg show X dump` prints an interface line then its peers; consecutive
    # calls would repeat the interface column, so peers are merged.
    if [ $first = 1 ]; then wg show "$iface" dump; first=0
    else wg show "$iface" dump | tail -n +2; fi
    any=1
  done
  [ $any = 1 ] || echo ""
}

# Bring back anything a reboot dropped, using the persisted configs. Safe to
# run repeatedly; called before the worker reports on tunnel health.
cmd_reconcile() {
  local restored=0 c iface
  for c in "$WG_ROOT"/${IFACE_PREFIX}*.conf; do
    [ -e "$c" ] || continue
    iface=$(basename "$c" .conf)
    is_up "$iface" && continue
    wg-quick up "$iface" >/dev/null 2>&1 && restored=$((restored + 1))
  done
  ensure_forwarding
  echo "reconciled $restored interface(s)"
}

case "${1:-}" in
  apply)     shift; [ $# -eq 8 ] || die "apply takes 8 arguments";  cmd_apply "$@" ;;
  remove)    shift; [ $# -eq 1 ] || die "remove takes 1 argument";   cmd_remove "$@" ;;
  dump)      shift; [ $# -eq 0 ] || die "dump takes no arguments";   cmd_dump ;;
  reconcile) shift; [ $# -eq 0 ] || die "reconcile takes no arguments"; cmd_reconcile ;;
  *) die "usage: netpid-wg {apply|remove|dump|reconcile}" ;;
esac
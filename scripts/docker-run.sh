#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${PLEXBRIDGE_ENV_FILE:-$repo_dir/.env}"
image="${PLEXBRIDGE_IMAGE:-ghcr.io/themranderson/plexbridge:latest}"
config_dir="${PLEXBRIDGE_CONFIG_DIR_HOST:-$repo_dir/config}"

if [[ ! -f "$env_file" ]]; then
  printf 'Environment file not found: %s\n' "$env_file" >&2
  printf 'Copy .env.example to .env, configure it, then run this script again.\n' >&2
  exit 1
fi

env_value() {
  local name="$1"
  awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

host_port="${PLEXBRIDGE_HOST_PORT:-$(env_value PLEXBRIDGE_HOST_PORT)}"
host_port="${host_port:-32400}"
web_host_port="${PLEXBRIDGE_WEB_HOST_PORT:-$(env_value PLEXBRIDGE_WEB_HOST_PORT)}"
web_host_port="${web_host_port:-80}"
web_container_port="${PLEXBRIDGE_WEB_PORT:-$(env_value PLEXBRIDGE_WEB_PORT)}"
web_container_port="${web_container_port:-32400}"
gdm_port="${PLEXBRIDGE_GDM_PORT:-$(env_value PLEXBRIDGE_GDM_PORT)}"
gdm_port="${gdm_port:-32410}"
gdm_port_2="${PLEXBRIDGE_GDM_PORT_2:-$(env_value PLEXBRIDGE_GDM_PORT_2)}"
gdm_port_2="${gdm_port_2:-32412}"
gdm_port_3="${PLEXBRIDGE_GDM_PORT_3:-$(env_value PLEXBRIDGE_GDM_PORT_3)}"
gdm_port_3="${gdm_port_3:-32413}"
gdm_port_4="${PLEXBRIDGE_GDM_PORT_4:-$(env_value PLEXBRIDGE_GDM_PORT_4)}"
gdm_port_4="${gdm_port_4:-32414}"

ports=(-p "$host_port:32400")
if [[ "$web_host_port" != "$host_port" ]]; then
  ports+=(-p "$web_host_port:$web_container_port")
fi
ports+=(
  -p "$gdm_port:32410/udp"
  -p "$gdm_port_2:32412/udp"
  -p "$gdm_port_3:32413/udp"
  -p "$gdm_port_4:32414/udp"
)

capabilities=()
if (( web_container_port < 1024 )); then capabilities+=(--cap-add NET_BIND_SERVICE); fi

exec docker run \
  --name "${PLEXBRIDGE_CONTAINER_NAME:-plexbridge}" \
  --env-file "$env_file" \
  -e PLEXBRIDGE_CONFIG_DIR=/config \
  "${capabilities[@]}" \
  "${ports[@]}" \
  -v "$config_dir:/config" \
  --restart unless-stopped \
  "$image"

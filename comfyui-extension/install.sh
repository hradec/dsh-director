#!/usr/bin/env bash
# install.sh — rsync dsh-studio-link into every reachable ComfyUI custom_nodes.
# Same pattern as ../comfyui-cache-immutable (see work-memory.md 2026-11-18).
set -u
SRC="$(cd "$(dirname "$0")" && pwd)/"
declare -A TARGETS=(
  [240.1.0.100]="/smb/240.1.0.100/comfyui/ComfyUI/custom_nodes/dsh-studio-link/"
  [240.0.0.242+243]="/mnt/nfsshare/comfyui/ComfyUI/custom_nodes/dsh-studio-link/"   # shared checkout; only when /mnt/nfsshare is mounted
)
for name in "${!TARGETS[@]}"; do
  dst="${TARGETS[$name]}"
  root="$(dirname "$dst")"
  if [ ! -d "$root" ]; then echo "SKIP $name ($root not mounted)"; continue; fi
  rsync -a --delete --exclude '.git' "$SRC" "$dst" && echo "OK $name -> $dst"
done
echo "NOTE: custom_nodes is scanned at boot — a host loads the pack at its NEXT restart (check queue first)."

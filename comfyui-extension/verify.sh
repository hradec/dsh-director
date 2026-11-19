#!/usr/bin/env bash
# verify.sh — check dsh-studio-link is loaded on a ComfyUI host.
# usage: ./verify.sh [host:port]   (default 240.1.0.100:8188)
HOST="${1:-240.1.0.100:8188}"
U="http://$HOST"
for cls in DSStudioAsset DSStudioImage DSStudioPick; do
  out=$(curl -s -m 30 "$U/object_info/$cls")
  if printf '%s' "$out" | grep -q "\"$cls\""; then
    echo "PASS $cls registered (outputs: $(printf '%s' "$out" | grep -o '"output_name": \[[^]]*\]' | head -1))"
  else
    echo "FAIL $cls missing from object_info -> pack not loaded (restart the host?)"
  fi
done
curl -s -m 15 "$U/extensions" | grep -q 'dsh-studio-link' && echo "PASS web extension advertised" || echo "FAIL /extensions has no dsh-studio-link module"

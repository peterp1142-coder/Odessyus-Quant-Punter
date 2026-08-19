#!/bin/bash
# Add nix store node to PATH if available (Replit), otherwise use system node
if [ -d "/nix/store" ]; then
  NODE_BIN="$(find /nix/store -maxdepth 3 -name 'node' -type f -path '*/bin/*' 2>/dev/null | head -1)"
  if [ -n "$NODE_BIN" ]; then
    export PATH="$(dirname "$NODE_BIN"):$PATH"
  fi
fi

node dist-server/index.js

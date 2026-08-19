#!/bin/bash
set -e  # stop immediately on error

echo "[Build] Checking npm..."
if ! command -v npm &> /dev/null; then
  echo "ERROR: npm not found in PATH"
  exit 1
fi

echo "[Build] Installing dependencies..."
npm install --no-audit --no-fund

echo "[Build] Building client (Vite)..."
npm run build

echo "[Build] Building server (TypeScript)..."
npx tsc -p tsconfig.server.json

echo "[Build] Build complete."
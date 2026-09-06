#!/bin/zsh
# ─────────────────────────────────────────────────────────────
# HyperVox – One-Click Startup Script
# Starts HyperVox Application
# ─────────────────────────────────────────────────────────────

cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "        ⚡ HYPERVOX - POWERED BY SAM ⚡         "
echo "  Starting App Interface                       "
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Launch UI (Electron App / Dev server) ──────────────────
if [ ! -d "node_modules" ]; then
  echo "📦 Installing node dependencies..."
  npm install
fi

echo "📱 Launching HyperVox Application..."
npm run app:dev

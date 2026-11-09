#!/usr/bin/env bash
# DeDT integration demo: one digital twin through all four work packages.
# Requires Python 3.11+ (with the WP2 and WP4 requirements) and Node 18+ (npm ci in wp1 and wp3).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
echo "━━ Steps 1–2 · WP2 twin data and WP4 trust layer"; python "$here/twin_trust.py"
echo "━━ Step 3 · WP1 DAO adopts the funding plan"; (cd "$here/../wp1-dao-collaboration" && npx hardhat run scripts/integration-step.js)
echo "━━ Step 4 · WP3 DTVF financing"; (cd "$here/../wp3-ip-nft-fundraising" && npx hardhat run scripts/integration-step.js)
echo "━━ Step 5 · Independent audit of the evidence chain"; python "$here/verify.py"
echo "Report: $here/out/traceability.md"

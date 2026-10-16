#!/usr/bin/env bash
# Ship origin/main to the cluster sv-oke with the shared sv-deploy script (config: deploy.env).
#   scripts/deploy.sh            deploy
#   scripts/deploy.sh --check    what runs now vs. origin/main
# SV_DEPLOY overrides the path to sv-deploy (default: ../../Oracle/deploy/sv-deploy).
set -euo pipefail
cd "$(dirname "$0")/.."
exec "${SV_DEPLOY:-../../Oracle/deploy/sv-deploy}" "$@"

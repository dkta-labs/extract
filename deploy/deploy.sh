#!/usr/bin/env bash
# Deploy hook for the infra control plane.
# Invoked by infra's generic runner with cwd = deploy_path, code already at the
# pinned ref. Contract env: DEPLOY_REF, SERVICE_NAME, PORT.
set -euo pipefail

npm ci --omit=dev
sudo systemctl restart extract

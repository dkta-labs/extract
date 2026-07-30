#!/usr/bin/env bash
# Deploy hook for the infra control plane.
# Invoked by infra's generic runner with cwd = deploy_path, code already at the
# pinned ref. Contract env: DEPLOY_REF, SERVICE_NAME, PORT.
set -euo pipefail

npm ci --omit=dev
sudo install -o root -g root -m 0644 extract.service /etc/systemd/system/extract.service
sudo install -o root -g root -m 0644 extract-egress-firewall.service /etc/systemd/system/extract-egress-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable extract-egress-firewall.service
sudo systemctl restart extract-egress-firewall.service
sudo systemctl restart extract

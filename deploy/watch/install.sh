#!/bin/bash
# 監察チームの収集スクリプトを入れる（任意）。root で、自動デプロイが確かめて入れた /opt/plasmod から写す。
# Claude Code の会話も集めるなら: sudo BRIDGE_USER=<bridge のユーザー> bash deploy/watch/install.sh
set -euo pipefail
REPO=${REPO:-/opt/plasmod}
install -o root -g root -m 755 "$REPO/deploy/watch/plasmod-watch-collect" /usr/local/sbin/plasmod-watch-collect
install -o root -g root -m 644 "$REPO/deploy/watch/plasmod-watch-collect.service" /etc/systemd/system/plasmod-watch-collect.service
install -o root -g root -m 644 "$REPO/deploy/watch/plasmod-watch-collect.timer" /etc/systemd/system/plasmod-watch-collect.timer
# 場所はこの VPS の設定から: Hermes は仲介の設定、Claude Code の会話の記録は BRIDGE_USER（任意）
HERMES_HOME=$(sed -n 's/^HERMES_HOME=//p' /etc/plasmod-broker.conf 2>/dev/null | tail -1)
HISTORY=""
if [ -n "${BRIDGE_USER:-}" ]; then HISTORY="$(getent passwd "$BRIDGE_USER" | cut -d: -f6)/.plasmod-bridge/history"; fi
install -d -m 755 /etc/systemd/system/plasmod-watch-collect.service.d
{
  echo "[Service]"
  [ -n "$HERMES_HOME" ] && echo "Environment=WATCH_HERMES_HOME=$HERMES_HOME"
  [ -n "$HISTORY" ] && echo "Environment=WATCH_BRIDGE_HISTORY=$HISTORY"
  true
} >/etc/systemd/system/plasmod-watch-collect.service.d/paths.conf
systemctl daemon-reload
systemctl enable --now plasmod-watch-collect.timer
systemctl start plasmod-watch-collect.service
ls -l /var/lib/plasmod-watch/

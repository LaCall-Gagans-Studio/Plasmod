#!/bin/bash
# 監察チームの収集スクリプトを入れる。root で、自動デプロイが確かめて入れた /opt/plasmod から写す。
set -euo pipefail
REPO=${REPO:-/opt/plasmod}
install -o root -g root -m 755 "$REPO/deploy/watch/plasmod-watch-collect" /usr/local/sbin/plasmod-watch-collect
install -o root -g root -m 644 "$REPO/deploy/watch/plasmod-watch-collect.service" /etc/systemd/system/plasmod-watch-collect.service
install -o root -g root -m 644 "$REPO/deploy/watch/plasmod-watch-collect.timer" /etc/systemd/system/plasmod-watch-collect.timer
systemctl daemon-reload
systemctl enable --now plasmod-watch-collect.timer
systemctl start plasmod-watch-collect.service
ls -l /var/lib/plasmod-watch/

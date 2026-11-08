#!/bin/bash
# Claude Code の bridge を入れる（任意）。root で:
#   sudo BRIDGE_USER=<Claude Code を動かすユーザー> bash deploy/bridge/install.sh
# そのユーザーで Claude Code にログインしておくこと。アプリのユーザー（plasmod）とは別にする
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
U=${BRIDGE_USER:?BRIDGE_USER に Claude Code を動かすユーザー名を入れる}
[[ $U =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "ユーザー名の形が違う: $U" >&2; exit 2; }
[ "$U" != plasmod ] || { echo "アプリのユーザーとは別にする" >&2; exit 2; }
HOME_DIR=$(getent passwd "$U" | cut -d: -f6)
[ -n "$HOME_DIR" ] || { echo "ユーザー $U がいない" >&2; exit 2; }
fill() { sed -e "s#@BRIDGE_USER@#$U#g" -e "s#@BRIDGE_HOME@#$HOME_DIR#g" "$1"; }
install -d -m 755 /usr/local/lib/plasmod-bridge
install -m 755 "$REPO/bridge/plasmod_bridge.py" "$REPO/bridge/thread_channel.py" /usr/local/lib/plasmod-bridge/
fill "$REPO/deploy/bridge/plasmod-dev.conf.in" >/etc/tmpfiles.d/plasmod-dev.conf
fill "$REPO/deploy/bridge/plasmod-bridge.service.in" >/etc/systemd/system/plasmod-bridge.service
chmod 644 /etc/tmpfiles.d/plasmod-dev.conf /etc/systemd/system/plasmod-bridge.service
systemd-tmpfiles --create /etc/tmpfiles.d/plasmod-dev.conf
systemctl daemon-reload
systemctl enable --now plasmod-bridge
systemctl restart plasmod
echo "入れました（bridge のユーザー: $U）。アプリの一覧に Claude Code が出ます"

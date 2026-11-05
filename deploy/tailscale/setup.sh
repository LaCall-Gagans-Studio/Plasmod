#!/bin/bash
# Tailscale の入口を設置する（TASK-247 段1）。root で 1 回だけ（rootreq で依頼する。INSTALL.md 34）。
# tailscale serve --https=8443 → unix ソケット /run/plasmod/ts.sock → アプリ。
# ソケットは tailscaled（root）とアプリ（plasmod）しか開けないので、VPS の中の他のユーザーは本人を名乗れない。
set -euo pipefail
exec 2>&1
trap 'echo "失敗: $BASH_COMMAND（$LINENO 行目）"' ERR

ENVF=/etc/plasmod/env
SOCK=/run/plasmod/ts.sock
LOGIN=${PLASMOD_TS_LOGIN:?PLASMOD_TS_LOGIN に Tailscale のログイン名を入れる}
PORT=8443

# 1. アプリにソケットを開かせる（/run/plasmod はアプリの持ち物・0750）
install -d -m 0755 /etc/systemd/system/plasmod.service.d
cat >/etc/systemd/system/plasmod.service.d/tailscale.conf <<CONF
[Service]
RuntimeDirectory=plasmod
RuntimeDirectoryMode=0750
Environment=PLASMOD_TAILSCALE_SOCK=$SOCK
CONF

# 2. 許可リストに Tailscale のログイン名を足す（無ければ）。控えを残す
if ! grep -qE "^PLASMOD_ALLOWED_LOGINS=.*(^|[=,])${LOGIN//./\\.}(,|$)" "$ENVF"; then
  cp -p "$ENVF" "$ENVF.bak-$(date +%Y%m%d%H%M%S)"
  if grep -q '^PLASMOD_ALLOWED_LOGINS=' "$ENVF"; then
    sed -i -E "s|^PLASMOD_ALLOWED_LOGINS=(.+)$|PLASMOD_ALLOWED_LOGINS=\\1,$LOGIN|; s|^PLASMOD_ALLOWED_LOGINS=$|PLASMOD_ALLOWED_LOGINS=$LOGIN|" "$ENVF"
  else
    echo "PLASMOD_ALLOWED_LOGINS=$LOGIN" >>"$ENVF"
  fi
fi
grep '^PLASMOD_ALLOWED_LOGINS=' "$ENVF"

# 3. 再起動してソケットができたか
systemctl daemon-reload
systemctl restart plasmod
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.5; done
ls -ld /run/plasmod "$SOCK"
systemctl is-active plasmod

# 4. tailscale serve（443 の dashboard はそのまま）
tailscale serve --bg --https=$PORT "unix:$SOCK"
tailscale serve status

# 5. 中から確かめる（本人のヘッダーが無いので 403 になるのが正しい。200 なら設定がおかしい）
code=$(curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" http://x/api/snapshot)
echo "ヘッダーなしの /api/snapshot: $code（403 が正しい）"
[ "$code" = 403 ]
echo "完了: tailnet から https://$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):$PORT で開ける"

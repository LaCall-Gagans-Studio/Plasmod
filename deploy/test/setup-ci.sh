#!/bin/bash
# まっさらなマシン（GitHub Actions）で setup.sh を流して確かめる。Tailscale と Hermes は偽物に置き換える。
# 本物の Tailscale・Hermes とのつながりは、ここでは確かめられない
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ok() { echo "OK: $*"; }
ng() { echo "NG: $*" >&2; journalctl -u plasmod -n 40 --no-pager >&2 || true; exit 1; }

install -m 755 deploy/test/fake-tailscale /usr/local/bin/tailscale
id hermes >/dev/null 2>&1 || useradd --create-home hermes
sudo -u hermes mkdir -p /home/hermes/.hermes

./setup.sh --check || ng "前提の確認"
./setup.sh </dev/null || ng "1回目の setup.sh"
ok "1回目"

code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$@"; }
check() {
  [ "$(code http://127.0.0.1:8790/api/health)" = 200 ] || ng "health が 200 でない"
  # 本人のヘッダーが無ければ入れない
  [ "$(code http://127.0.0.1:8790/api/snapshot)" = 403 ] || ng "TCP から snapshot が開けてしまう"
  [ "$(code --unix-socket /run/plasmod/ts.sock http://x/api/snapshot)" = 403 ] || ng "ソケットからヘッダーなしで開けてしまう"
  systemctl is-active --quiet plasmod || ng "plasmod が動いていない"
  systemctl is-active --quiet plasmod-rootd || ng "plasmod-rootd が動いていない"
  [ "$(stat -c '%U:%G %a' /etc/plasmod/env)" = "root:plasmod 640" ] || ng "env の権限: $(stat -c '%U:%G %a' /etc/plasmod/env)"
  [ "$(stat -c '%a' /etc/plasmod-rootd)" = 700 ] || ng "rootd の設定の権限"
  sudo -u nobody test ! -r /etc/plasmod/env || ng "ほかのユーザーが env を読める"
  grep -q '^PLASMOD_ALLOWED_LOGINS=ci@example.com$' /etc/plasmod/env || ng "ログインの設定"
  visudo -c >/dev/null || ng "sudoers"
}
check
ok "入った状態"

before=$(sha256sum /etc/plasmod/env)
./setup.sh </dev/null || ng "2回目の setup.sh"
[ "$before" = "$(sha256sum /etc/plasmod/env)" ] || ng "2回目で env が変わった"
check
ok "2回目（何度流しても大丈夫）"

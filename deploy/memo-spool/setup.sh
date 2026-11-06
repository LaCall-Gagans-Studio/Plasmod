#!/bin/bash
# メモの受け渡し（AI → メモ）を設置する。root で 1 回だけ（rootreq で依頼する。INSTALL.md 24）。
# 新しい鍵・グループは作らない。誰が書いたかは依頼ファイルの持ち主（uid）でアプリが決める。
set -euo pipefail
SPOOL=/var/lib/plasmod-spool
ENVF=/etc/plasmod/env

install -d -o root -g root -m 0755 "$SPOOL"
install -d -o plasmod -g plasmod -m 0755 "$SPOOL/memo"
# in: 誰でも置ける・一覧は見られない・他人のファイルは消せない（sticky）
install -d -o plasmod -g plasmod -m 1733 "$SPOOL/memo/in"
# out: 一覧は見られない。返事の名前（ランダムな id）を知っている依頼主だけが読める
install -d -o plasmod -g plasmod -m 0711 "$SPOOL/memo/out"

# アプリの unit は ProtectSystem=strict なので、書ける場所に足す
install -d -m 0755 /etc/systemd/system/plasmod.service.d
cat >/etc/systemd/system/plasmod.service.d/memo-spool.conf <<CONF
[Service]
ReadWritePaths=$SPOOL
CONF

# 設定（秘密ではない）。すでにあれば書かない
grep -q '^PLASMOD_MEMO_SPOOL=' "$ENVF" || echo "PLASMOD_MEMO_SPOOL=$SPOOL/memo" >>"$ENVF"
grep -q '^PLASMOD_MEMO_AGENTS=' "$ENVF" || echo "PLASMOD_MEMO_AGENTS=cc=dev,hermes=hermes" >>"$ENVF"

# CLI は自動デプロイが入れる /opt の写しを指す
ln -sfn /opt/plasmod/deploy/memo-spool/plasmod-memo /usr/local/bin/plasmod-memo
ln -sfn /opt/plasmod/deploy/memo-spool/plasmod-task /usr/local/bin/plasmod-task

systemctl daemon-reload
systemctl restart plasmod
sleep 3
systemctl is-active plasmod
journalctl -u plasmod --since -1min --no-pager | grep 'メモの受け渡し' || echo "（起動の記録に受け渡しの行が無い）"
ls -ld "$SPOOL/memo" "$SPOOL/memo/in" "$SPOOL/memo/out"

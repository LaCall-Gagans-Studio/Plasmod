#!/bin/bash
# 自動デプロイの「手作業が要るデプロイ」の通知が出たら、開発エージェント（cc）がこれを実行して、root の反映を依頼する。
# 実行しても何も起きない。オーナーがアプリで内容を見てパスワードを入れたときだけ、plasmod-apply-held が root で走る。
# 使い方: bash deploy/rootd/request-held.sh        （クローンは /var/lib/plasmod-deploy/repo を cc でも読める前提）
set -euo pipefail
STATE=${STATE:-/var/lib/plasmod-deploy}
REPO=$STATE/repo
LAST=$(cat "$STATE/deployed")
COMMIT=$(git -c safe.directory="$REPO" -C "$REPO" rev-parse origin/main)
[ "$LAST" != "$COMMIT" ] || { echo "反映済み。依頼は要らない"; exit 0; }
HOLD_RE='^(broker/|bridge/|rootd/|deploy/(sudoers|systemd|tmpfiles|autodeploy|rootd|update)/)'
HELD=$(git -c safe.directory="$REPO" -C "$REPO" diff --name-only "$LAST" "$COMMIT" | grep -E "$HOLD_RE" || true)
[ -n "$HELD" ] || { echo "保留の対象は無い。自動デプロイが入れる"; exit 0; }
SUBJECT=$(git -c safe.directory="$REPO" -C "$REPO" log -1 --format=%s "$COMMIT")
APPLY=${APPLY:-/usr/local/sbin/plasmod-apply-held}
[ -x "$APPLY" ] || { echo "$APPLY が無い。初回は管理者が deploy/rootd/apply-held.sh を root で設置する（INSTALL.md 20-1）" >&2; exit 1; }
SCRIPT=$(mktemp); trap 'rm -f "$SCRIPT"' EXIT
# 依頼のスクリプトはこの 1 行だけ。中身は root 所有の $APPLY で、cc は書き換えられない
printf 'COMMIT=%s LAST=%s %s\n' "$COMMIT" "$LAST" "$APPLY" >"$SCRIPT"
rootreq submit --title "Plasmod: 手作業が要る変更を反映（${COMMIT:0:7}）" --timeout 1200 --script "$SCRIPT" --reason "自動デプロイが保留した変更を root で入れる。main の ${COMMIT:0:7}「$SUBJECT」。
保留の対象:
$HELD

スクリプトは COMMIT・LAST を渡して root 所有の $APPLY を呼ぶ 1 行だけ。$APPLY は GitHub の署名とマージした人を確かめてから入れ、最後に自動デプロイでアプリ本体を反映する。"

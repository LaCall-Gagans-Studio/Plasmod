#!/bin/bash
# 自動デプロイのスクリプトを、root を使わずに確かめる。
# 偽の GitHub（ローカルの bare リポジトリ）、偽の web-flow の鍵、偽の systemctl・bun を使う。
# 使い方: bash deploy/autodeploy/test_autodeploy.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
export GNUPGHOME=$T/gnupg; mkdir -m 700 "$GNUPGHOME"
gpg -q --batch --passphrase '' --quick-gen-key "GitHub (web-flow commit signing) <noreply@github.com>" rsa2048 sign never 2>/dev/null
FPR=$(gpg --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')
gpg -q --batch --passphrase '' --quick-gen-key "Mallory <evil@example.com>" rsa2048 sign never 2>/dev/null
EVIL=$(gpg --list-keys --with-colons evil@example.com | awk -F: '/^fpr/{print $10; exit}')
OWNER="1+owner@users.noreply.github.com"
BOT="2+bot[bot]@users.noreply.github.com"

git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
cd "$T/work"
commit() { # commit AUTHOR_EMAIL KEY(or "") FILE MESSAGE
  echo "$4" >"$3"
  git add -A
  local sign=(); [ -n "$2" ] && sign=(-c commit.gpgsign=true -c user.signingkey="$2")
  GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com \
    git "${sign[@]}" -c user.name=x -c user.email="$1" commit -q -m "$4"
  git push -q origin HEAD:main
}

mkdir -p bin app state
cat >bin/systemctl <<'S'
#!/bin/sh
echo "systemctl $*" >>"$LOG"
S
cat >bin/bun <<'S'
#!/bin/sh
echo "bun $*" >>"$LOG"
[ -n "${FAIL_BUILD:-}" ] && [ "$1" = test ] && exit 1
exit 0
S
chmod +x bin/*
export PATH=$T/work/bin:$PATH LOG=$T/log
cat >conf <<C
REPO_URL=$T/origin.git
ALLOWED_AUTHORS="$OWNER"
WEBFLOW_FPR=$FPR
STATE=$T/state
APP=$T/app
BUN=$T/work/bin/bun
HEALTH_URL=file://$T/healthy
APP_ENV=/nonexistent
AS_BUILD=
GIT_SSH_COMMAND=ssh
C
run() { PLASMOD_DEPLOY_CONF=$T/work/conf bash "$HERE/plasmod-deploy" >>"$T/out" 2>&1; }
pass() { echo "ok - $1"; }
fail() { echo "NG - $1"; cat "$T/out"; exit 1; }

commit "$OWNER" "$FPR" a.txt "Merge pull request #1"
BASE=$(git rev-parse HEAD)
run; grep -q "準備が要る" "$T/out" && [ ! -e "$T/state/deployed" ] && pass "初回は今の commit を書くまで何もしない" || fail "初回"
echo "$BASE" >"$T/state/deployed"

commit "$BOT" "" b.txt "bot が main に直接 push"
run; grep -q "オーナーがマージした commit ではない" "$T/out" && [ "$(cat "$T/state/deployed")" = "$BASE" ] && pass "署名なし（bot の push）は入れない" || fail "署名なし"

commit "$OWNER" "$EVIL" c.txt "別の鍵で署名"
run; grep -qF "署名=$EVIL" "$T/out" && pass "GitHub 以外の鍵の署名は入れない" || fail "別の鍵"

commit "$BOT" "$FPR" d.txt "bot がマージ"
run; grep -qF "author=$BOT" "$T/out" && pass "許可していない author は入れない" || fail "author"

: >"$T/healthy"
commit "$OWNER" "$FPR" src.txt "Merge pull request #2"
run; NEW=$(git rev-parse HEAD)
[ "$(cat "$T/state/deployed")" = "$NEW" ] && grep -q "systemctl restart plasmod" "$T/log" && [ -f "$T/app/src.txt" ] && [ ! -e "$T/app/.git" ] \
  && grep -q "bun install --frozen-lockfile --ignore-scripts" "$T/log" && pass "正しくマージされたものは、テストして入れて restart" || fail "デプロイ"

run; [ "$(grep -c 'systemctl restart' "$T/log")" = 1 ] && pass "変わっていなければ何もしない" || fail "二度目"

mkdir -p broker; commit "$OWNER" "$FPR" broker/x "Merge pull request #3（仲介を変える）"
run; grep -q "手作業が要る" "$T/out" && grep -q "broker/x" "$T/out" && [ "$(cat "$T/state/deployed")" = "$NEW" ] && pass "仲介の変更は自動では入れない" || fail "hold"
echo "$(git rev-parse HEAD)" >"$T/state/deployed"   # 管理者が手で入れた想定

FAIL_BUILD=1 commit "$OWNER" "$FPR" e.txt "Merge pull request #4（テストが落ちる）"
FAIL_BUILD=1 run; grep -q "テストかビルドが失敗" "$T/out" && [ ! -f "$T/app/e.txt" ] && pass "テストが落ちたら入れない" || fail "テスト失敗"

rm -f "$T/healthy"
commit "$OWNER" "$FPR" f.txt "Merge pull request #5（起動しない）"
run || true; grep -q "動かなかったので戻した" "$T/out" && [ ! -f "$T/app/f.txt" ] && [ -f "$T/app/src.txt" ] && pass "起動しなければ前の版に戻す" || fail "rollback"

echo "all ok"

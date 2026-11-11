#!/bin/bash
# 自動デプロイが「手作業が要る」と止めた変更（broker・sudoers・systemd・plasmod-rootd 自身など）を root で入れる。
# root 所有の /usr/local/sbin/plasmod-apply-held として置く（初回は管理者が設置。以後はこのスクリプト自身が
# 保留の対象として入れ替える）。rootreq の依頼のスクリプトは次の 1 行だけ（cc が中身を組み立てない）:
#   COMMIT=<40桁> LAST=<40桁> /usr/local/sbin/plasmod-apply-held
# オーナーがアプリで承認したときだけ root で走る（直接は実行しない）。依頼は request-held.sh が作る。
#
# やること:
#   1. COMMIT が、root の clone の origin/main の先頭で、GitHub（web-flow）の署名＋許可した author であることを確かめる
#   2. LAST..COMMIT で変わった「保留の対象」を、種類ごとの決まった場所に入れる（sudoers は visudo -c を通してから）
#   3. 自動で入れられないもの（bridge のパッチなど）が残っていれば、入れずに知らせて止まる（exit 3）
#   4. 自動デプロイを「保留なし」で 1 回走らせ、アプリ本体（/opt）を COMMIT にする
set -euo pipefail

: "${COMMIT:?}" "${LAST:?}"
[[ $COMMIT =~ ^[0-9a-f]{40}$ && $LAST =~ ^[0-9a-f]{40}$ ]] || { echo "apply-held: COMMIT・LAST は 40 桁の小文字 16 進" >&2; exit 1; }
CONF=${PLASMOD_DEPLOY_CONF:-/etc/plasmod-deploy/deploy.conf}
# shellcheck source=/dev/null
. "$CONF"
STATE=${STATE:-/var/lib/plasmod-deploy}
REPO=$STATE/repo
DEST=${DEST:-}                                  # テスト用: 入れ先の接頭辞（本番は空）
SYSTEMCTL=${SYSTEMCTL:-systemctl}
DEPLOY=${DEPLOY:-/usr/local/sbin/plasmod-deploy}
HOLD_RE=${HOLD_RE:-'^(broker/|bridge/|rootd/|deploy/(sudoers|systemd|tmpfiles|autodeploy|rootd|update)/)'}
GNUPGHOME=${GNUPGHOME:-/etc/plasmod-deploy/gnupg}
export GNUPGHOME

die() { echo "apply-held: $*" >&2; exit 1; }

# ---- 1. 入れてよい commit か ----
[ "$(cat "$STATE/deployed")" = "$LAST" ] || die "deployed が $LAST ではない（先に別の反映が済んだ。依頼し直す）"
[ "$(git -C "$REPO" rev-parse origin/main)" = "$COMMIT" ] || die "origin/main が $COMMIT ではない（依頼し直す）"
AUTHOR=$(git -C "$REPO" log -1 --format=%ae "$COMMIT")
COMMITTER=$(git -C "$REPO" log -1 --format=%ce "$COMMIT")
FPR=$(git -C "$REPO" verify-commit --raw "$COMMIT" 2>&1 | awk '$2=="VALIDSIG"{print $3; exit}')
ok=0; for a in $ALLOWED_AUTHORS; do [ "$AUTHOR" = "$a" ] && ok=1; done
[ "$FPR" = "$WEBFLOW_FPR" ] && [ "$COMMITTER" = "noreply@github.com" ] && [ "$ok" = 1 ] || die "オーナーが GitHub の画面でマージした commit ではない"

# ---- 2. 保留の対象を入れる ----
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$COMMIT" | tar -x -C "$TMP"
reload=0; tmpfiles=0; restart_rootd=0; restart_bridge=0; unhandled=()
inst() { # inst MODE FILE 入れ先
  install -D -m "$1" -o root -g root "$TMP/$2" "$DEST$3"
  echo "入れた: $3  <- $2"
}
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ ! -e "$TMP/$f" ]; then unhandled+=("$f（削除された。手で消すか確かめる）"); continue; fi
  case $f in
    broker/plasmod-broker) inst 755 "$f" /usr/local/bin/plasmod-broker ;;
    deploy/sudoers/plasmod)
      visudo -cf "$TMP/$f" >/dev/null || die "sudoers の文法が不正。何も入れていない"
      inst 440 "$f" /etc/sudoers.d/plasmod ;;
    deploy/systemd/*.service) inst 644 "$f" "/etc/systemd/system/$(basename "$f")"; reload=1 ;;
    deploy/tmpfiles/*.conf) inst 644 "$f" "/etc/tmpfiles.d/$(basename "$f")"; tmpfiles=1 ;;
    deploy/autodeploy/plasmod-deploy) inst 755 "$f" /usr/local/sbin/plasmod-deploy ;;
    deploy/autodeploy/*.service|deploy/autodeploy/*.timer) inst 644 "$f" "/etc/systemd/system/$(basename "$f")"; reload=1 ;;
    deploy/autodeploy/deploy.conf.example|deploy/autodeploy/test_*) ;;   # 設置用の見本・テスト。入れない
    bridge/plasmod_bridge.py|bridge/thread_channel.py) inst 755 "$f" "/usr/local/lib/plasmod-bridge/$(basename "$f")"; restart_bridge=1 ;;
    bridge/test_*|bridge/run_tests.sh) ;;
    rootd/plasmod-rootd) inst 755 "$f" /usr/local/sbin/plasmod-rootd; restart_rootd=1 ;;
    rootd/rootreq) inst 755 "$f" /usr/local/bin/rootreq ;;
    rootd/test_*) ;;
    deploy/rootd/plasmod-rootd.service) inst 644 "$f" /etc/systemd/system/plasmod-rootd.service; reload=1; restart_rootd=1 ;;
    deploy/rootd/apply-held.sh) inst 755 "$f" /usr/local/sbin/plasmod-apply-held ;;   # 自分自身（install は別 inode に置き換えるので、実行中でも壊れない）
    deploy/update/plasmod-update) inst 755 "$f" /usr/local/sbin/plasmod-update ;;
    deploy/rootd/*) ;;                                                    # 見本・依頼用の request-held.sh。入れない
    *) unhandled+=("$f") ;;
  esac
done < <(git -C "$REPO" diff --name-only "$LAST" "$COMMIT" | grep -E "$HOLD_RE" || true)
[ "$reload" = 1 ] && $SYSTEMCTL daemon-reload
[ "$tmpfiles" = 1 ] && [ -z "$DEST" ] && systemd-tmpfiles --create
[ "$restart_bridge" = 1 ] && $SYSTEMCTL restart plasmod-bridge

# ---- 3. 自動では入れられないもの ----
if [ "${#unhandled[@]}" -gt 0 ]; then
  echo "apply-held: 次は自動では入れられない。別に root 作業を依頼すること:" >&2
  printf '  %s\n' "${unhandled[@]}" >&2
  exit 3
fi

# ---- 4. アプリ本体（/opt）を COMMIT にする ----
HOLD_RE='^$' "$DEPLOY"
[ "$(cat "$STATE/deployed")" = "$COMMIT" ] || die "アプリの反映が終わっていない（$STATE/build.log と journalctl -u plasmod-deploy を見る）"
echo "反映した: $COMMIT"

# plasmod-rootd 自身を入れ替えたときは、この結果を記録してから再起動する（今動いているのは plasmod-rootd の子なので、
# 先に再起動すると結果が「中断」になる）
if [ "$restart_rootd" = 1 ]; then
  systemd-run --quiet --on-active=5 --unit="plasmod-rootd-restart-$(date +%s)" "$SYSTEMCTL" restart plasmod-rootd
  echo "plasmod-rootd は 5 秒後に再起動する"
fi

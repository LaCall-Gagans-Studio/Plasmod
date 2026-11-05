#!/bin/bash
# Plasmod を VPS に入れる。Ubuntu 22.04 以降、root で実行する。何度流しても大丈夫。
#
#   前提: Tailscale にログイン済み（tailscale up）／Hermes を入れてある
#   使い方: sudo ./setup.sh [--login you@example.com] [--hermes-user hermes] [--hermes-home パス] [--no-hermes-api] [--check]
#     --login          アプリを開けるログイン（Tailscale）。省略するとこの VPS のログイン
#     --hermes-user    Hermes を動かすユーザー（既定 hermes）
#     --hermes-home    Hermes のフォルダ（既定 そのユーザーのホーム/.hermes）
#     --no-hermes-api  Hermes の API キーを足さない（自分で設定する）
#     --check          前提を調べるだけ。何も変えない
set -euo pipefail

BUN_VERSION=1.4.2
APP=plasmod
OPT=/opt/$APP
ETC=/etc/$APP
HERMES_USER=hermes
HERMES_HOME=""
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOGIN=""
HERMES_API=1
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --login) LOGIN=${2:?--login にログイン名が要る}; shift 2 ;;
    --hermes-user) HERMES_USER=${2:?--hermes-user にユーザー名が要る}; shift 2 ;;
    --hermes-home) HERMES_HOME=${2:?--hermes-home にパスが要る}; shift 2 ;;
    --no-hermes-api) HERMES_API=0; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | cut -c3-; exit 0 ;;
    *) echo "知らない指定: $1" >&2; exit 2 ;;
  esac
done

[[ $HERMES_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "ユーザー名の形が違う: $HERMES_USER" >&2; exit 2; }
USER_HOME=$(getent passwd "$HERMES_USER" | cut -d: -f6 || true)
[ -n "$HERMES_HOME" ] || HERMES_HOME=${USER_HOME:-/home/$HERMES_USER}/.hermes
[[ $HERMES_HOME == /* && $HERMES_HOME != *[[:space:]\'\"]* ]] || { echo "Hermes のフォルダの形が違う: $HERMES_HOME" >&2; exit 2; }

step() { printf '\n== %s\n' "$*"; }
die() { echo "止めます: $*" >&2; exit 1; }

ts_json() { tailscale status --json; }
ts_field() { ts_json | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

check() {
  local bad=0
  say() { printf '  %-22s %s\n' "$1" "$2"; }
  if command -v tailscale >/dev/null && [ "$(ts_field "d.get('BackendState','')" 2>/dev/null)" = Running ]; then
    say "Tailscale" "OK（$(ts_field "d['Self']['DNSName'].rstrip('.')")）"
  else
    say "Tailscale" "NG: 入れて tailscale up する"; bad=1
  fi
  if id "$HERMES_USER" >/dev/null 2>&1; then say "ユーザー $HERMES_USER" "OK"; else say "ユーザー $HERMES_USER" "NG: Hermes を $HERMES_USER ユーザーに入れる"; bad=1; fi
  if [ "$(id -u)" = 0 ]; then
    if [ -d "$HERMES_HOME" ]; then say "Hermes" "OK（$HERMES_HOME）"; else say "Hermes" "NG: $HERMES_HOME が無い"; bad=1; fi
  else
    say "Hermes" "root でないと確かめられない"
  fi
  for c in python3 curl git rsync sudo unzip openssl; do
    command -v "$c" >/dev/null || say "$c" "無い（入れます）"
  done
  return $bad
}

if [ "$CHECK" = 1 ]; then
  step "前提の確認（何も変えません）"
  check && echo "このまま入れられます" || { echo "NG を直してください"; exit 1; }
  exit 0
fi

[ "$(id -u)" = 0 ] || die "root で実行してください（sudo ./setup.sh）"
step "前提の確認"
check || die "前提が足りません"

step "必要なものを入れる"
need=()
for c in python3 curl git rsync sudo unzip openssl; do command -v "$c" >/dev/null || need+=("$c"); done
if [ "${#need[@]}" -gt 0 ]; then apt-get update -qq && apt-get install -y -qq "${need[@]}"; fi
if ! command -v bun >/dev/null || [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  T=$(mktemp -d)
  BUN_ZIP="bun-linux-$(uname -m | sed 's/x86_64/x64/').zip"
  BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  curl -fsSL -o "$T/$BUN_ZIP" "$BUN_URL/$BUN_ZIP"
  curl -fsSL -o "$T/SHASUMS256.txt" "$BUN_URL/SHASUMS256.txt"
  (cd "$T" && grep " $BUN_ZIP\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun のチェックサムが合わない"
  unzip -q "$T/$BUN_ZIP" -d "$T"
  install -m 755 -o root -g root "$T"/bun-linux-*/bun /usr/local/bin/bun
  rm -rf "$T"
fi

step "ユーザーと置き場所"
id "$APP" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$APP" --shell /usr/sbin/nologin "$APP"
id plasmod-build >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin plasmod-build
install -d -m 750 -o root -g "$APP" "$ETC"
install -d -m 755 -o root -g root "$OPT"

step "ビルド（権限の無いユーザーで）"
B=$(mktemp -d)
trap 'rm -rf "$B"' EXIT
rsync -a --exclude .git --exclude node_modules --exclude dist "$SRC/" "$B/src/"
install -d -o plasmod-build "$B/home"
chown -R plasmod-build "$B/src"
chmod 755 "$B"
sudo -u plasmod-build env HOME="$B/home" TMPDIR="$B/home" bash -c "cd '$B/src' && bun install --frozen-lockfile --ignore-scripts && bun node_modules/vite/bin/vite.js build"
rsync -a --delete --chown=root:root --chmod=D755,F644 "$B/src/" "$OPT/"

step "仲介と sudoers"
install -m 755 -o root -g root "$OPT/broker/plasmod-broker" /usr/local/bin/plasmod-broker
# Hermes の場所は仲介の設定に書く（root が置く。仲介はこれを読むだけ）
{
  echo "HERMES_USER_HOME=$USER_HOME"
  echo "HERMES_HOME=$HERMES_HOME"
} >/etc/plasmod-broker.conf
chmod 644 /etc/plasmod-broker.conf
sed "s/(hermes)/($HERMES_USER)/" "$OPT/deploy/sudoers/plasmod" >/etc/sudoers.d/plasmod
chmod 440 /etc/sudoers.d/plasmod
visudo -c >/dev/null || { rm -f /etc/sudoers.d/plasmod; die "sudoers の文法が不正"; }

step "設定"
[ -n "$LOGIN" ] || LOGIN=$(ts_field "d['User'][str(d['Self']['UserID'])]['LoginName']")
HOSTNAME_TS=$(ts_field "d['Self']['DNSName'].rstrip('.')")
if [ ! -e "$ETC/env" ]; then
  umask 027
  cat >"$ETC/env" <<ENV
PLASMOD_PORT=8790
PLASMOD_ALLOWED_LOGINS=$LOGIN
PLASMOD_PUBLIC_URL=https://$HOSTNAME_TS:8443
PLASMOD_NOTIFY_URL=http://127.0.0.1:8790/notify-relay
PLASMOD_NOTIFY_TOKEN=$(openssl rand -hex 32)
PLASMOD_BROKER_CMD=sudo -n -u $HERMES_USER /usr/local/bin/plasmod-broker
ENV
  umask 022
  chown root:"$APP" "$ETC/env"
  echo "  $ETC/env を作りました（ログイン: $LOGIN）"
else
  echo "  $ETC/env はあるので、そのまま使います"
fi

if [ "$HERMES_API" = 1 ]; then
  step "Hermes の API キー（無いプロファイルにだけ足す）"
  changed=0
  for d in "$HERMES_HOME" "$HERMES_HOME"/profiles/*/; do
    [ -d "$d" ] || continue
    f=${d%/}/.env
    if ! sudo -u "$HERMES_USER" grep -q '^API_SERVER_KEY=' "$f" 2>/dev/null; then
      sudo -u "$HERMES_USER" bash -c "umask 077; { echo API_SERVER_ENABLED=true; echo API_SERVER_KEY=\$(openssl rand -hex 32); } >>'$f'"
      echo "  足しました: $f"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then
    units=$(systemctl list-units --type=service --all --plain --no-legend 'hermes-gateway*' | awk '{print $1}')
    if [ -n "$units" ]; then
      # shellcheck disable=SC2086
      systemctl restart $units
      echo "  再起動しました: $units"
    else
      echo "  gateway のサービスが見つかりません。Hermes の gateway を再起動してください"
    fi
  fi
fi

step "root 作業の承認（plasmod-rootd）"
install -m 755 -o root -g root "$OPT/rootd/plasmod-rootd" /usr/local/sbin/plasmod-rootd
install -m 755 -o root -g root "$OPT/rootd/rootreq" /usr/local/bin/rootreq
install -m 644 -o root -g root "$OPT/deploy/rootd/plasmod-rootd.service" /etc/systemd/system/plasmod-rootd.service
install -d -m 700 /etc/plasmod-rootd
if [ ! -e /etc/plasmod-rootd/config ]; then
  req=$HERMES_USER
  id cc >/dev/null 2>&1 && req="cc $req"
  printf 'REQUESTERS=%s\nAPPROVER=%s\nHERMES_USER=%s\nHERMES_HOME=%s\nHERMES_BIN=%s\n' "$req" "$APP" "$HERMES_USER" "$HERMES_HOME" "$USER_HOME/.local/bin/hermes" >/etc/plasmod-rootd/config
  chmod 600 /etc/plasmod-rootd/config
fi
if [ ! -e /etc/plasmod-rootd/passwd ]; then
  if [ -t 0 ]; then
    echo "  root 作業を承認するときのパスワードを決めてください（ほかと使い回さない）"
    /usr/local/sbin/plasmod-rootd set-password
  else
    echo "  あとで設定してください: sudo /usr/local/sbin/plasmod-rootd set-password"
  fi
fi

step "サービス"
install -m 644 -o root -g root "$OPT/deploy/systemd/plasmod.service" /etc/systemd/system/plasmod.service
systemctl daemon-reload
systemctl enable --now plasmod-rootd
systemctl enable plasmod
systemctl restart plasmod
for _ in $(seq 1 30); do
  curl -fsS -m 2 -o /dev/null http://127.0.0.1:8790/api/health && break
  sleep 1
done
curl -fsS -m 2 -o /dev/null http://127.0.0.1:8790/api/health || die "アプリが起動しません: journalctl -u plasmod -n 30"

step "Tailscale の入口"
PLASMOD_TS_LOGIN=$LOGIN bash "$OPT/deploy/tailscale/setup.sh"

step "できました"
echo "  開く: https://$HOSTNAME_TS:8443"
echo "  （Tailscale につないだ端末で、$LOGIN のログインだけが開けます）"
echo "  Android アプリは GitHub の Releases から。最初の画面に上の住所を入れてください"

# 入れ方と運用

Plasmod は VPS の上で動きます。使うのは **VPS・Hermes・Tailscale・この GitHub リポジトリ** だけです。

## 前提

- Ubuntu 22.04 以降の VPS（root で操作できること）
- [Tailscale](https://tailscale.com/): VPS でログイン済み（`tailscale up`）。スマホや PC も同じ tailnet に入れる
- [Hermes Agent](https://github.com/NousResearch/hermes-agent): 既定は `hermes` ユーザーの `~/.hermes`。違う場所なら `--hermes-user`・`--hermes-home` で指定する

外のインターネットにポートは開けません。入口は Tailscale だけです。

## 入れる

```sh
git clone <このリポジトリ> plasmod && cd plasmod
sudo ./setup.sh --check   # 前提を調べるだけ。何も変えない
sudo ./setup.sh
```

`setup.sh` がやること（何度流しても大丈夫です）:

1. Bun とビルドに要るものを入れる
2. 専用のユーザーを作り、権限の無いユーザーでビルドして `/opt` に置く
3. 仲介（決まった操作だけを Hermes に頼む）と sudoers を入れる
4. 設定ファイルを作る。開けるのはこの VPS の Tailscale のログインだけ（`--login` で変更）
5. Hermes の各プロファイルに API キーが無ければ足して、gateway を再起動する（`--no-hermes-api` で止める）
6. root 作業の承認（plasmod-rootd）を入れ、承認用のパスワードを決める
7. アプリを起動して、Tailscale の入口を開く

終わると住所（`https://<machine>.<tailnet>.ts.net:8443`）が出ます。

## 最初にすること

アプリを開くと、初回の案内が出ます（呼び名、エージェント、チーム、通知とアプリ）。あとからは **設定** で変えられます。エージェントは Hermes のプロファイルから自動で見つかります。

Android アプリは [Releases](../../../releases) から入れて、最初の画面に住所を入れます。

## 個人の設定とデータの置き場所

どれも VPS の中です。GitHub には上がりません。

| 場所 | 中身 |
|---|---|
| `/etc/plasmod/env` | 設定と秘密の値（root とアプリだけが読める） |
| `/var/lib/plasmod/` | タスク・メモ・判断の記録・呼び名・顔の画像 |
| `/etc/plasmod-rootd/` | 承認のパスワード（root だけが読める） |
| `/opt/plasmod/` | アプリ本体。個人の情報は入らない |

**バックアップ**: `/var/lib/plasmod/` を守ってください。VPS のスナップショットか定期バックアップをおすすめします。

## 設定（`/etc/plasmod/env`）

ふつうは変える必要がありません。変えたら `sudo systemctl restart plasmod`。開けるログインは、アプリの **設定 → VPS → 許可リスト** からも変えられます（root のパスワードが要り、アプリは自動で再起動します）。一覧と例は [deploy/env.example](../deploy/env.example)。

| 名前 | 意味 |
|---|---|
| `PLASMOD_ALLOWED_LOGINS` | 開けるログイン（カンマ区切り）。画面からも変えられる |
| `PLASMOD_HERMES_API` | Hermes の API を自分で指定するとき。無ければ自動で見つける |
| `PLASMOD_PROFILES` | エージェントの一覧を固定するとき（[例](../deploy/profiles.example.json)）。無ければ自動 |
| `PLASMOD_OWNER_NAME`・`PLASMOD_DEVELOPER`・`PLASMOD_REPO_URL` | 呼び名の既定、設定に出す開発者とリポジトリ |
| `PLASMOD_GITHUB_TOKEN`・`PLASMOD_GITHUB_OWNER` | 開発の画面で PR を見るとき（読み取り専用のトークン） |
| `PLASMOD_TASK_PREFIX` | タスク番号の頭（既定 `TASK`） |

## 切り替えられるモデル（`/etc/plasmod-models.json`）

エージェントの設定で選べるモデルの許可リストです。setup.sh が空（`{}`）で作ります。中身はアプリの **設定 → VPS → 許可リスト** で足すのがかんたんです（「いまのモデルを加える」で、各エージェントが今使っているモデルを1押しで入れられます）。手で書くときの形:

```json
{
  "default": [
    { "provider": "nous", "model": "anthropic/claude-sonnet-4.6", "label": "Sonnet" }
  ]
}
```

キーは Hermes のプロファイル名、`provider` と `model` は Hermes の `model.provider`・`model.default` と同じ書き方です。仲介が毎回読むので、再起動は要りません。プロバイダーのログイン（API キーやサブスク）は Hermes 側で済ませておいてください。

## 任意の部品

無くても動きます。使うときだけ入れます。

| 部品 | 入れ方 |
|---|---|
| エージェントのスキル | `deploy/hermes-skills/` を Hermes の skills に置く。更新は `rootreq action skill.sync` |
| 見回りの登録（メールなど） | `inbox-card` スキルが手順。何を見回るかは、自分のエージェントに決めさせる。無くても手でタスクを足せる |
| エージェントからメモ・タスクを使う | `sudo bash deploy/memo-spool/setup.sh` |
| 監察チームの週次データ | `sudo bash deploy/watch/install.sh` |
| 開発エージェント（Claude Code） | 下の「開発エージェント」 |
| 自動デプロイ | 下の「自動デプロイ」 |

### 開発エージェント

Claude Code をアプリのセッションから使う部品です。`bridge/` にあります。

- 専用のユーザーで Claude Code を動かし、`bridge/plasmod_bridge.py` をサービスにする
- `/run/plasmod-dev/app.sock` を、そのユーザーが作りアプリだけが入れるようにする（`deploy/tmpfiles/`）
- 呼び名は `BRIDGE_AGENT_NAME`・`BRIDGE_OWNER_NAME`
- テストは `bash bridge/run_tests.sh`

ソケットがあると、アプリの一覧に自動で出ます。

### 自動デプロイ

GitHub の画面でマージされた commit だけを、署名を確かめて `/opt` に入れます。

1. `deploy/autodeploy/deploy.conf.example` を `/etc/plasmod-deploy/deploy.conf` に置いて、リポジトリとあなたのアカウントを書く
2. 読み取り専用の deploy key を作って GitHub に登録する。`plasmod-build` ユーザーを作る
3. `deploy/autodeploy/` の本体と timer を入れて有効にする

root に関わる変更（`broker/`・`bridge/`・`rootd/`・`deploy/` の一部）は自動では入りません。アプリの root 作業の承認で入れます（`deploy/rootd/request-held.sh`）。

## VPS を調べる・直す

| コマンド | 内容 | 承認 |
|---|---|---|
| `rootreq inspect 項目` | サービス・ログ・Hermes の設定やコードを読む。秘密らしい値は伏せる。`rootreq -h` に一覧 | 不要 |
| `rootreq action 部品 引数` | 決まった変更（再起動・cron の停止・MCP の有効化・許可した設定・スキルの更新）。下見と控えつき。`undo` で戻せる | パスワード |
| `rootreq submit --script ファイル` | 自由なスクリプト | パスワード |
| アプリの **設定 → root 作業の承認 → コマンドを実行する** | オーナーが自分で打つ | パスワード |

依頼できるのは `hermes` と開発エージェントのユーザーです。承認できるのはアプリを通したオーナーだけで、依頼した本人は承認できません。

パスワードの変更: `sudo /usr/local/sbin/plasmod-rootd set-password`（5回間違えると15分ロック。変えると解除）。

## 困ったとき

```sh
systemctl status plasmod plasmod-rootd
journalctl -u plasmod -n 50
curl -s http://127.0.0.1:8790/api/health         # {"ok":true}
sudo tailscale serve status
```

- **VPS の中から開くと 403**: 正しい動きです。VPS 自身からのアクセスは通しません
- **エージェントが出ない**: Hermes の `.env` に `API_SERVER_KEY` があるか。足したら gateway とアプリを再起動
- **承認できない**: Tailscale のログインが `PLASMOD_ALLOWED_LOGINS` にあるか

## アンインストール

```sh
sudo tailscale serve --https=8443 off
sudo systemctl disable --now plasmod plasmod-rootd
sudo rm -rf /opt/plasmod /etc/plasmod /etc/plasmod-rootd /var/lib/plasmod /var/lib/plasmod-rootd
sudo rm -f /etc/sudoers.d/plasmod /etc/systemd/system/plasmod.service /etc/systemd/system/plasmod-rootd.service \
  /usr/local/bin/plasmod-broker /usr/local/bin/rootreq /usr/local/sbin/plasmod-rootd
sudo userdel plasmod; sudo userdel plasmod-build
```

Hermes の `.env` に足した `API_SERVER_KEY` は残ります。

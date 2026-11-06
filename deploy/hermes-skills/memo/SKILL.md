---
name: memo
description: オーナーのメモ（Plasmod のメモ。プロジェクトとタグ付き）を plasmod-memo で探す・読む・書く・追記する。調べものの結果を残す、オーナーのメモを文脈として読む、頼まれてメモにする、とき
---

# メモを読み書きする（plasmod-memo）

オーナーのアプリのメモは、`plasmod-memo` で読み書きできる。鍵は要らない（誰が書いたかは OS のユーザーで記録される）。hermes の中では、自分のプロファイル名を `--as` で名乗る。

```bash
plasmod-memo --as default list -q "宿"              # 探す（題・本文・タグ・プロジェクト）
plasmod-memo --as default list -p 夏の旅行 -t 旅  # プロジェクト・タグで絞る
plasmod-memo --as default show 12                    # 読む
plasmod-memo --as default new --title "宿の比較" -p 夏の旅行 -t 旅 -t 調べもの <<'MD'
## 候補
- A 宿 — 6,000円
MD
plasmod-memo --as default append 12 <<'MD'
（10/24 ハブのエージェント）B 宿は満室だった
MD
plasmod-memo --as default edit 12 -t 旅 -t 予約済み     # タグを置き換える
```

## 決まり

- オーナーの書いた本文を書き換えない。足すときは `append`（誰がいつ足したか、本文に一言入れる）
- 新しく作るのは、頼まれたとき・調べた結果を残すとき。プロジェクトは今あるものを `list` で確かめてから使う（似た名前を増やさない）
- 消す（アーカイブ）はできない。要らなそうなら、オーナーに伝える
- 秘密（パスワード・鍵・トークン）はメモに書かない
- 地図・表・タブなどリッチに見せたいときは、本文に ```html の箱を書ける（隔離した枠で表示。スクリプトと style は中に書く。外部のスクリプト・通信は使えない。画像は https か data:。別のメモへのリンクは href="#/memo/12"）
- メモは入れ子にできる（`new --parent 12`、`edit 13 --parent 12`、外すのは `--no-parent`）
- メモの番号の表記は `MEMO-12`（`show 12` で読むメモ）。本文に `[[MEMO-12]]` と書くと、そのメモへのつながりになる

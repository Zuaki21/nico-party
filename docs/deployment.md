# 本番の運用

メンテナー向けです。本番は、画面（client）を Cloudflare Workers、サーバー（server）を Docker で動かしています。

| PREFIX（URL Mapping） | 本番の TARGET |
|---|---|
| `/` | `nico-party.zuaki.dev`（Cloudflare Workers。静的ファイル） |
| `/srv` | `nico-party-api.zuaki.dev`（サーバー。Cloudflare Tunnel） |

ニコニコ用の `/external/...` は、[開発の手順](development.md) の「URL Mapping」の表と同じものを登録しています。

## 反映の手順

1. `client/package.json` の `version` を進める（設定画面と読み込み画面の左下に「ver x.x.x」と出るので、反映できたかはそれで確かめる）
2. [確認用のコマンド](development.md#確認用のコマンド) を通す
3. main に push する
4. **画面**: `cd client && npm run deploy`（ビルドして `wrangler deploy`）
5. **サーバー**（変更があるときだけ）: `deploy/oci/docker-compose.yml`（サーバー本体 + cloudflared）をビルドし直して入れ替える。
   今の本番は OCI の VM 上の Coolify で、Coolify からデプロイする（Webhook は使っていないので、push だけでは反映されない）

部屋は、サーバーが停止するときに `/data/rooms.json` に書き出され、起動後に部屋へ最初に接続が来たときに読み込まれる。
入れ替えのときは全員の接続が一度切れ、画面が自動で繋ぎ直す。

## サーバーの環境変数

秘密は環境変数で渡す（値をリポジトリに入れない）。

| 名前 | 内容 |
|---|---|
| `DISCORD_CLIENT_ID` | Discord アプリの ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 のクライアントシークレット |
| `PASS_SECRET` | 通行証の署名の鍵。長いランダムな文字列。変えると発行済みの通行証が全部無効になる（開いたままの画面は再読み込みが必要） |
| `DISCORD_BOT_TOKEN` | 任意。部屋の参加者の確認に使う（Developer Portal の Bot のページで発行） |
| `TUNNEL_TOKEN` | Cloudflare Tunnel のトークン（公開ホスト名 → `http://app:8787`） |

`DISCORD_CLIENT_ID`・`DISCORD_CLIENT_SECRET`・`PASS_SECRET` が未登録だと、ログイン・検索・部屋がすべて 500 になる。
本番には `ALLOW_ANON_WS` を設定しない（設定されていても、接続元がローカルでなければ効かない）。

## 不具合の報告とログ

- 画面の「不具合を報告」で送られた記録は、サーバーの `/data/client-logs.jsonl` に 1 行 1 件で追記される（8MB を超えたら `.1` に回す）。
  報告 ID で探す: `docker exec <サーバーのコンテナ> grep <報告ID> /data/client-logs.jsonl`
- 記録には、直近 400 行の動作（接続・状態の変化・通知・エラー・プレイヤーのエラーの内容）と、利用環境（UA・画面の大きさ・H.264 / AAC の再生可否）が入る。
  通行証は送る前に伏せる。動画のタイトルと検索語は入れない。Discord のユーザー ID と表示名は入る
- サーバーの動き（入室・退出・追加の失敗・通知）は、1 行 1 件の JSON で標準出力に出る

## セキュリティ上の前提

- 部屋の通行証は、画面が申告した部屋（Activity の instanceId）に対して発行する。
  発行の前に、Discord の Activity インスタンス取得 API（`DISCORD_BOT_TOKEN` が要る）で、その人が参加者か確かめる。参加者でないと分かったときだけ 403。
  ボットトークンが未登録のとき・Discord に確かめられなかったときは、確かめずに通す（Discord 側の事情で、正規の利用者がログインできなくなるのを避けるため）
- 通行証の有効期間は 24 時間。画面は 6 時間ごとに取り直す
- 中継・検索・報告・部屋への接続には、それぞれ回数や量の上限がある

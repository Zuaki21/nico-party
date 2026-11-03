# NicoParty

ボイスチャンネルのメンバーでニコニコ動画を同時視聴する Discord Activity。

- 使い方・案内: https://nico-party.zuaki.dev
- 不具合の報告・要望: [Issues](https://github.com/Zuaki21/nico-party/issues)（開発への参加は [CONTRIBUTING.md](CONTRIBUTING.md)）

非公式のアプリです。ニコニコ動画・Discord の運営とは関係ありません。

- 再生・一時停止・シークを全員に同期
- URL を入れて再生リストに追加。視聴済み・再生中も残り、ドラッグで並べ替えできる
- リピート（再生リスト全体 / 1曲）とシャッフル。部屋の全員で共通
- キーワード検索（ニコニコのスナップショット検索 API。1 日 1 回更新なので投稿直後の動画は出ない）
- 再生リストと再生中の動画に、追加した人の Discord のアイコンを表示
- 他の人の操作（シーク・動画の切り替え・追加・削除）を、動画の上に通知
- PiP 表示中は動画だけを表示
- 設定画面（テーマ、UI サイズ、日本語 / 英語、ステータスに視聴中の動画を表示するか、操作の通知）。設定は各自の画面だけに効く
- 不具合の報告（設定画面から。直近の動作の記録を送り、報告 ID が出る）

## 構成

```
client/   Vite + TypeScript。Activity の画面と同期処理。Cloudflare Workers が静的ファイルとして配信する（client/wrangler.toml）
server/   Node（OCI の VM で Docker + Coolify。Cloudflare Tunnel 経由で公開）
            /api/token      Discord OAuth のコードをトークンに交換
            /api/search     キーワード検索（スナップショット検索 API を 10 分キャッシュ）
            /api/log        不具合の報告（画面の動作の記録）を受け取り、報告 ID を返す
            /ws/:instanceId 部屋（= Activity のインスタンス）ごとの WebSocket。部屋の状態はメモリに持ち、停止するときだけファイルに書き出す
            /nico/*         ニコニコ埋め込みプレイヤーの中継（URL を Discord プロキシ経由に書き換える）
            /healthz        生存確認
shared/   クライアントとサーバーで共有するメッセージ定義
deploy/oci/   OCI にデプロイする docker-compose（サーバー本体 + cloudflared）
```

Discord 内では、クライアントは `/`（Cloudflare）から読み込まれ、サーバーへは `/.proxy/srv/...`（URL Mapping の `/srv`）で届く。
Activity 内では Discord のプロキシ以外への通信が CSP でブロックされる。
そのためサーバーが埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を `/.proxy/external/<host を -- で連結>` に書き換えて返す。
動画のセグメントは Discord のプロキシが直接ニコニコから取得するので、サーバーは通らない。

## セットアップ

1. Discord Developer Portal でアプリを作り、Activities を有効にする
2. `.env.example` を `.env` に、`server/.dev.vars.example` を `server/.dev.vars` にコピーして値を入れる
3. `client` と `server` でそれぞれ `npm install`

### Discord の URL Mapping

ポータルはワイルドカード（`{a}--{b}`）を受け付けないので、使うドメインを1つずつ登録する。

| PREFIX | TARGET |
|---|---|
| `/` | `nico-party.zuaki.dev`（Cloudflare。静的ファイル。開発中は cloudflared の URL） |
| `/srv` | `nico-party-api.zuaki.dev`（OCI のサーバー。Cloudflare Tunnel。開発中は `/` と同じ cloudflared の URL でもよい） |
| `/external/assets--embed--res--nimg--jp` | `assets.embed.res.nimg.jp` |
| `/external/img--cdn--nimg--jp` | `img.cdn.nimg.jp` |
| `/external/nicovideo--cdn--nimg--jp` | `nicovideo.cdn.nimg.jp` |
| `/external/img--nicoprofile--nimg--jp` | `img.nicoprofile.nimg.jp` |
| `/external/nvapi--nicovideo--jp` | `nvapi.nicovideo.jp` |
| `/external/public--nvcomment--nicovideo--jp` | `public.nvcomment.nicovideo.jp` |
| `/external/www--nicovideo--jp` | `www.nicovideo.jp` |
| `/external/asset--domand--nicovideo--jp` | `asset.domand.nicovideo.jp` |
| `/external/delivery--domand--nicovideo--jp` | `delivery.domand.nicovideo.jp` |

## 開発

```sh
cd server && npm run dev             # Node のサーバー（8787。server/.dev.vars を読む）
cd client && npx vite                # /api, /ws, /nico は 8787 にプロキシされる
cloudflared tunnel --protocol http2 --url http://127.0.0.1:5173
```

- cloudflared は QUIC がタイムアウトする環境があるので `--protocol http2` を付けている
- トンネルの URL を URL Mapping の `/` と `/srv` に登録して、Discord から Activity を起動する（開発中の Vite は `/srv/...` を 8787 に中継する）
- 開発中は Activity 内のログが `client/dev.log` に書き出される（本番でも画面の中に直近の記録を貯めていて、不具合の報告で送られる）
- 通常のブラウザで `http://127.0.0.1:5173` を開くと、全タブ共通の部屋で同期だけを確認できる

## 確認用のコマンド

Discord の中でしか確かめられない動きを、手元で確かめるためのもの。変更したら、デプロイの前に実行する。

```sh
cd client && npm run check:sync              # 同期エンジンの挙動が、記録と変わっていないか
cd client && npm run check:sync -- --update  # 意図して挙動を変えたときに、記録を作り直す
cd server && npm run check                   # 型・再生の状態遷移・中継・部屋・通行証など
```

- `check:sync`（`client/src/player/sync`）: 偽のプレイヤー・偽の時計で、途中参加・開始待ち・ユーザー操作・動画の切り替え・
  読み込み失敗・時計のずれ・プレイヤーの癖（再生通知が来ない・シークが効かない）など 47 の場面を流して、プレイヤーとサーバーへの呼び出しを
  時刻つきで記録と比べる。どの場面も、終わったあとにミュートが元に戻り、覆いが外れ、タイマーが残らないことも確かめる
- `server/scripts/check-playback.cjs`: 次へ・前へ・ジャンプ・リピート・シャッフル・削除・追加などの状態遷移（`server/src/room/playback.ts`）。
  時刻・ID・乱数を固定して確かめる
- `server/scripts/check-nico.cjs`: 中継の書き換えルール。書き換えた URL に、必ず通行証が入ることを確かめる
- `server/scripts/check-room.cjs`: Room クラス（接続数の上限と追い出し・入室しない接続の掃除・アラーム・入室と退出・配信の順序・量の制限）。保存先と WebSocket を代用品にして動かす
- `server/scripts/check-host.cjs`: 部屋の置き場（接続・生存確認・退出後の破棄）と、停止時の書き出し・起動後の読み込み
- `server/scripts/check-misc.cjs`: メッセージの検証・通行証・読み込み失敗の記録・量の制限・保存先・本文の読み取り上限・中継の経路・並べ替え

ローカルで WebSocket に通行証なしで入るには、`server/.dev.vars` に `ALLOW_ANON_WS=true` を書く（本番では設定しない）。

## デプロイ

反映のたびに `client/package.json` の `version` を進める。設定画面と読み込み画面の左下に「ver x.x.x」と出るので、反映できたかはそれで確認できる。

- **フロント**: `cd client && npm run deploy`（ビルドして `wrangler deploy`。Cloudflare Workers の静的ファイル配信）
- **サーバー**: `deploy/oci/docker-compose.yml`（サーバー本体 + cloudflared）を Docker で動かす。今の本番は OCI の VM 上の Coolify で、main に push してから Coolify でデプロイする
  （Webhook は使っていないので、push だけでは反映されない）。
  部屋は、停止するときに `/data/rooms.json` に書き出され、起動後に部屋へ最初に接続が来たときに読み込まれる

サーバーの秘密は環境変数で渡す（値をリポジトリに入れない）。

| 名前 | 内容 |
|---|---|
| `DISCORD_CLIENT_ID` | Discord アプリの ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 のクライアントシークレット |
| `PASS_SECRET` | 通行証の署名の鍵。長いランダムな文字列。変えると発行済みの通行証が全部無効になる |
| `DISCORD_BOT_TOKEN` | 任意。部屋の参加者の確認に使う（Developer Portal の Bot のページで発行） |
| `TUNNEL_TOKEN` | Cloudflare Tunnel のトークン（公開ホスト名 → `http://app:8787`） |

未登録のままだと、ログイン・検索・部屋がすべて 500 になる。

### 不具合の報告とログ

- 画面の「不具合を報告」で送られた記録は、サーバーの `/data/client-logs.jsonl` に 1 行 1 件で追記される（8MB を超えたら `.1` に回す）。
  報告 ID で探す: `docker exec <サーバーのコンテナ> grep <報告ID> /data/client-logs.jsonl`
- 記録には、通行証・動画のタイトル・検索語は入れない（通行証は送る前に伏せる）。Discord のユーザー ID と表示名は入る
- サーバーの動き（入室・退出・追加の失敗・通知）は、1 行 1 件の JSON で標準出力に出る

## セキュリティ上の前提

- 部屋の通行証は、クライアントが申告した部屋（Activity の instanceId）に対して発行される。発行の前に、Discord の Activity インスタンス取得 API（ボットトークン `DISCORD_BOT_TOKEN` が要る）で、その人が参加者か確かめる。参加者でないと分かったときだけ 403。ボットトークンが未登録のとき・Discord に確かめられなかったときは確かめずに通す（Discord 側の事情で、正規の利用者がログインできなくなるのを避けるため）
- デプロイ前に、本番の環境変数に `ALLOW_ANON_WS` が入っていないことを確かめる（入っていても、接続元がローカルでなければ無効）
- 通行証の有効期間は 24 時間。クライアントは 6 時間ごとに取り直す

## 制限

- チャンネルの設定で外部での再生が禁止されている動画（埋め込みページが `externally_unwatchable` を返すもの）は再生できない
- 埋め込みプレイヤーの postMessage API は非公式なので、ニコニコ側の仕様変更で動かなくなる可能性がある

## ライセンス

[MIT License](LICENSE)。

## クレジット

ニコニコ埋め込みプレイヤーの中継は [kikoune](https://github.com/sevenc-nanashi/kikoune)（MIT License）の方式を移植したもの。
再生数・コメント数のアイコンは [Lucide](https://lucide.dev)（ISC License）。
ライセンス本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。

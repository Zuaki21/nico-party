# NicoParty

ボイスチャンネルのメンバーでニコニコ動画を同時視聴する Discord Activity。

- 再生・一時停止・シークを全員に同期
- URL を入れて再生リストに追加。視聴済み・再生中も残り、ドラッグで並べ替えできる
- リピート（再生リスト全体 / 1曲）とシャッフル。部屋の全員で共通
- キーワード検索（ニコニコのスナップショット検索 API。1 日 1 回更新なので投稿直後の動画は出ない）
- PiP 表示中は動画だけを表示
- 設定画面（テーマ、UI サイズ、日本語 / 英語、Discord に視聴中の動画を表示するか）。設定は各自の画面だけに効く

## 構成

```
client/   Vite + TypeScript。Activity の画面と同期処理
server/   Cloudflare Worker + Durable Objects
            /               Discord から（?frame_id 付きで）開かれたら Activity 本体、それ以外は案内ページ
            /api/token      Discord OAuth のコードをトークンに交換
            /api/search     キーワード検索（スナップショット検索 API を 10 分キャッシュ）
            /ws/:instanceId 部屋（= Activity のインスタンス）ごとの WebSocket
            /nico/*         ニコニコ埋め込みプレイヤーの中継（URL を Discord プロキシ経由に書き換える）
shared/   クライアントとサーバーで共有するメッセージ定義
```

Activity 内では Discord のプロキシ以外への通信が CSP でブロックされる。
そのため Worker が埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を `/.proxy/external/<host を -- で連結>` に書き換えて返す。
動画のセグメントは Discord のプロキシが直接ニコニコから取得するので、Worker は通らない。

## セットアップ

1. Discord Developer Portal でアプリを作り、Activities を有効にする
2. `.env.example` を `.env` に、`server/.dev.vars.example` を `server/.dev.vars` にコピーして値を入れる
3. `client` と `server` でそれぞれ `npm install`

### Discord の URL Mapping

ポータルはワイルドカード（`{a}--{b}`）を受け付けないので、使うドメインを1つずつ登録する。

| PREFIX | TARGET |
|---|---|
| `/` | Worker のドメイン（開発中は cloudflared の URL） |
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
cd client && npx vite build          # wrangler dev が配信する dist を作っておく
cd server && npx wrangler dev --ip 127.0.0.1 --port 8787
cd client && npx vite                # /api, /ws, /nico は 8787 にプロキシされる
cloudflared tunnel --protocol http2 --url http://127.0.0.1:5173
```

- cloudflared は QUIC がタイムアウトする環境があるので `--protocol http2` を付けている
- トンネルの URL を URL Mapping の `/` に登録して、Discord から Activity を起動する
- 開発中は Activity 内のログが `client/dev.log` に書き出される
- 通常のブラウザで `http://127.0.0.1:5173` を開くと、全タブ共通の部屋で同期だけを確認できる

## 確認用のコマンド

Discord の中でしか確かめられない動きを、手元で確かめるためのもの。変更したら、デプロイの前に実行する。

```sh
cd client && npm run check:sync              # 同期エンジンの挙動が、記録と変わっていないか
cd client && npm run check:sync -- --update  # 意図して挙動を変えたときに、記録を作り直す
cd server && npm run check                   # 型・再生の状態遷移・中継の書き換えルール
```

- `check:sync`（`client/src/player/sync`）: 偽のプレイヤー・偽の時計で、途中参加・開始待ち・ユーザー操作・動画の切り替え・
  読み込み失敗・時計のずれ・プレイヤーの癖（再生通知が来ない・シークが効かない）など 36 の場面を流して、プレイヤーとサーバーへの呼び出しを
  時刻つきで記録と比べる。どの場面も、終わったあとにミュートが元に戻り、覆いが外れ、タイマーが残らないことも確かめる
- `server/scripts/check-playback.cjs`: 次へ・前へ・ジャンプ・リピート・シャッフル・削除・追加などの状態遷移（`server/src/room/playback.ts`）。
  時刻・ID・乱数を固定して確かめる
- `server/scripts/check-nico.cjs`: 中継の書き換えルール。書き換えた URL に、必ず通行証が入ることを確かめる
- `server/scripts/check-misc.cjs`: メッセージの検証・通行証・読み込み失敗の記録・量の制限・保存先・本文の読み取り上限・中継の経路・並べ替え

ローカルで WebSocket に通行証なしで入るには、`server/.dev.vars` に `ALLOW_ANON_WS=true` を書く（本番では設定しない）。

## デプロイ

反映のたびに `client/package.json` の `version` を進める。設定画面の左下に「ver x.x.x」と出るので、反映できたかはそれで確認できる。

```sh
cd client && npx vite build
cd server && npx wrangler deploy
npx wrangler secret put DISCORD_CLIENT_SECRET   # 初回のみ
npx wrangler secret put PASS_SECRET             # 初回のみ（通行証の署名の鍵。長いランダムな文字列。変えると発行済みの通行証が全部無効になる）
```

デプロイ後、URL Mapping の `/` を `<name>.<subdomain>.workers.dev` にする。

## 制限

- チャンネルの設定で外部での再生が禁止されている動画（埋め込みページが `externally_unwatchable` を返すもの）は再生できない
- 埋め込みプレイヤーの postMessage API は非公式なので、ニコニコ側の仕様変更で動かなくなる可能性がある

## クレジット

ニコニコ埋め込みプレイヤーの中継は [kikoune](https://github.com/sevenc-nanashi/kikoune)（MIT License）の方式を移植したもの。
ライセンス本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。

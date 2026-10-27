# NicoParty

ボイスチャンネルのメンバーでニコニコ動画を同時視聴する Discord Activity。

- 再生・一時停止・シークを全員に同期
- URL を入れてキューに追加。視聴済み・再生中も残り、ドラッグで並べ替えできる
- キーワード検索（ニコニコのスナップショット検索 API。1 日 1 回更新なので投稿直後の動画は出ない）
- PiP 表示中は動画だけを表示

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

## デプロイ

```sh
cd client && npx vite build
cd server && npx wrangler deploy
npx wrangler secret put DISCORD_CLIENT_SECRET   # 初回のみ
```

デプロイ後、URL Mapping の `/` を `<name>.<subdomain>.workers.dev` にする。

## 制限

- チャンネルの設定で外部での再生が禁止されている動画（埋め込みページが `externally_unwatchable` を返すもの）は再生できない
- 埋め込みプレイヤーの postMessage API は非公式なので、ニコニコ側の仕様変更で動かなくなる可能性がある

## クレジット

ニコニコ埋め込みプレイヤーの中継は [kikoune](https://github.com/sevenc-nanashi/kikoune)（MIT License）の方式を移植したもの。
ライセンス本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。

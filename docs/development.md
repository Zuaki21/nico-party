# 手元で動かす

確かめ方は 2 段階あります。ほとんどの修正は、1 の「ブラウザだけで確かめる」で足ります。

1. **ブラウザだけで確かめる**: Discord のアプリもトンネルも要りません。同期・再生リスト・検索・通知・不具合の報告を試せます
2. **Discord の中で確かめる**: 自分用の Discord アプリを作ります。Discord の中でしか起きないこと（ログイン、アイコン、PiP、ステータス表示、中継を通した再生）を確かめるとき

どちらも、送る前に [確認用のコマンド](#確認用のコマンド) を通してください。
Discord の中でしか確かめられない変更は、最後にメンテナーが本番に近い環境で確かめます。

## 必要なもの

- Node.js 22 以上と npm
- （Discord の中で確かめるときだけ）Discord のアカウントと、自分が管理者のサーバー（テスト用）、[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

## 1. ブラウザだけで確かめる

リポジトリの一番上で、次を実行します。

```sh
cp server/.dev.vars.example server/.dev.vars
(cd server && npm install)
(cd client && npm install)
```

`server/.dev.vars` は、例のファイルのままで動きます（`PASS_SECRET` と `ALLOW_ANON_WS=true` だけ使います。Discord の値は空のままでよい）。

ターミナルを 2 つ開いて、それぞれで起動します。

```sh
cd server && npm run dev   # サーバー（http://127.0.0.1:8787）
cd client && npm run dev   # 画面（http://127.0.0.1:5173。/api・/ws・/nico はサーバーに中継される）
```

ブラウザで http://localhost:5173 を開きます。タブを複数開くと、全タブが同じ部屋（`local-dev`）に入り、別の人として扱われます。

- 開くと、サーバーが開発用の通行証を発行します（`/api/dev-token`）。これで検索と不具合の報告も使えます。
  発行するのは `ALLOW_ANON_WS=true` で、しかも手元から直接つないだとき（トンネルやプロキシを通っていない、127.0.0.1 からの接続）だけです。本番では 404 になります
- 動画は、中継を通さずにニコニコの埋め込みをそのまま使います（中継の動きは、Discord の中で確かめます）
- アイコン、ステータス表示、PiP など Discord に頼る部分は動きません
- `localhost` で開けないときは http://127.0.0.1:5173 を使ってください。ただし `127.0.0.1` では、ニコニコの埋め込みがエラーになることがあります
  （画面の確認は `127.0.0.1`、再生の確認は `localhost` が確実です）

## 2. Discord の中で確かめる

自分用の Discord アプリを作り、手元のサーバーをトンネルで Discord から見えるようにします。
流れは Discord 公式の [Building an Activity](https://discord.com/developers/docs/activities/building-an-activity) と同じです。

### アプリを作る（初回だけ）

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application
2. **OAuth2**: Client ID と Client Secret を控える。Redirects に `https://127.0.0.1` を 1 つ登録する（Activity では使われないが、登録が必要）
3. **Activities → Settings**: Activities を有効にする
4. 値を入れる
   - リポジトリの一番上の `.env`（`.env.example` をコピー）: `VITE_DISCORD_CLIENT_ID`
   - `server/.dev.vars`: `DISCORD_CLIENT_ID` と `DISCORD_CLIENT_SECRET`（`DISCORD_BOT_TOKEN` は任意）

### トンネルを張る（起動のたび）

サーバーと画面を 1. と同じように起動してから、画面をトンネルで公開します。

```sh
cloudflared tunnel --protocol http2 --url http://127.0.0.1:5173
```

- `https://xxxx.trycloudflare.com` のような URL が出ます。**起動するたびに変わる**ので、そのたびに下の URL Mapping の `/` と `/srv` を登録し直します
- `--protocol http2` は、QUIC がタイムアウトする環境があるため付けています
- 画面からサーバーへの通信は `/.proxy/srv/api/...` のように送られ、Discord が `/srv` を外してトンネルの先の `/api/...` に届けます。Vite は `/api`・`/ws`・`/nico` をサーバー（8787）に中継するので、`/` と `/srv` は同じトンネルの URL でかまいません

### URL Mapping（Activities → URL Mappings）

ポータルはワイルドカードを受け付けないので、1 件ずつ登録します。`/` と `/srv` 以外は、一度登録すれば変わりません。

| PREFIX | TARGET |
|---|---|
| `/` | トンネルの URL のホスト名（`xxxx.trycloudflare.com`） |
| `/srv` | 同じトンネルのホスト名 |
| `/external/assets--embed--res--nimg--jp` | `assets.embed.res.nimg.jp` |
| `/external/img--cdn--nimg--jp` | `img.cdn.nimg.jp` |
| `/external/nicovideo--cdn--nimg--jp` | `nicovideo.cdn.nimg.jp` |
| `/external/img--nicoprofile--nimg--jp` | `img.nicoprofile.nimg.jp` |
| `/external/nvapi--nicovideo--jp` | `nvapi.nicovideo.jp` |
| `/external/public--nvcomment--nicovideo--jp` | `public.nvcomment.nicovideo.jp` |
| `/external/www--nicovideo--jp` | `www.nicovideo.jp` |
| `/external/asset--domand--nicovideo--jp` | `asset.domand.nicovideo.jp` |
| `/external/delivery--domand--nicovideo--jp` | `delivery.domand.nicovideo.jp` |

再生できない・画像が出ないときは、まずこの登録の漏れを疑ってください（ニコニコ側の新しいドメインが増えていることもあります）。

### 起動する

テスト用のサーバーのボイスチャンネルに入り、Activity の一覧から自分のアプリを選びます。
開発中のアプリは、アプリの持ち主（とアプリのチームのメンバー）にだけ表示されます。
一覧に出ないときは、Discord の「設定 → 詳細設定 → 開発者モード」をオンにしてください。

- 画面の中のログは、`client/dev.log` に書き出されます（Discord の中では開発者ツールを開きにくいため）
- `ALLOW_ANON_WS=true` のままでも、Discord の中からの接続はトンネルを通るので、通行証なしの接続や開発用のログインは使えません（ローカルの接続だけが対象）

## コードの読み始め

| 場所 | 役割 |
|---|---|
| `shared/protocol.ts` | 画面とサーバーがやり取りするメッセージの型。まずここを読むと全体が見える |
| `client/src/app.ts` | 画面の入口。起動（Discord のログイン）・部屋との接続・プレイヤー・同期を結びつける |
| `client/src/net/` | サーバーとの通信（WebSocket の接続と再接続・時計合わせ・API）と、Discord（ログイン・ステータス表示） |
| `client/src/player/` | ニコニコの埋め込みプレイヤーの操作と、同期エンジン（`sync/`） |
| `client/src/ui/` | 画面の各部分（再生リスト・検索・設定・通知など）。`ui.ts` が骨組み |
| `client/src/core/` | 文言（`i18n/`）・ログ・保存など、全体で使う小物 |
| `server/src/node/main.ts` → `routes.ts` | サーバーの入口と、HTTP の振り分け |
| `server/src/room/room.ts` | 部屋。届いたメッセージごとの処理。再生の状態遷移そのものは `playback.ts` |
| `server/src/nico/` | ニコニコの埋め込みプレイヤーの中継と、動画情報・検索の取得 |
| `server/src/pass.ts`・`auth.ts` | 通行証（Discord でログインした人であることを示す、署名つきの文字列）と、それを使った認可 |

## 確認用のコマンド

Discord の中でしか起きない動きを、手元で確かめるためのものです。Discord もネットワークも要りません。

リポジトリの一番上で実行します。

```sh
(cd client && npm run check)
(cd server && npm run check)
```

GitHub でも、push と Pull Request のたびに同じものが自動で流れます（`.github/workflows/check.yml`）。

- `client` の `npm run check`: 型と、次の確認をまとめて実行します
  - `check:units`: 時計のずれの推定（`client/src/net/clock.ts`）と、プレイヤーの中のリンクを本当の URL に戻す処理（`client/src/core/urls.ts`）
  - `check:sync`（`client/src/player/sync`）: 偽のプレイヤー・偽の時計で、途中参加・開始待ち・ユーザー操作・動画の切り替え・
    読み込み失敗・時計のずれ・プレイヤーの癖（再生通知が来ない・シークが効かない）など 47 の場面を流し、プレイヤーとサーバーへの呼び出しを
    時刻つきで記録（`client/scripts/sync-check/expected.json`）と比べます。どの場面も、終わったあとにミュートが戻り、覆いが外れ、タイマーが残らないことも確かめます。
    同期の挙動を意図して変えたときは `npm run check:sync -- --update` で記録を作り直し、その差分も一緒に送ってください
- `server` の `npm run check`: 型と、次の単体テストをまとめて実行します
  - `check-playback.cjs`: 次へ・前へ・ジャンプ・リピート・シャッフル・削除・追加などの状態遷移（`server/src/room/playback.ts`）
  - `check-nico.cjs`: 中継の書き換えルール。書き換えた URL に、必ず通行証が入ること
  - `check-room.cjs`: 部屋（接続数の上限と追い出し・入室しない接続の掃除・入室と退出・配信の順序・量の制限・操作の通知）
  - `check-host.cjs`: 部屋の置き場（接続・生存確認・退出後の破棄）と、停止時の書き出し・起動後の読み込み
  - `check-misc.cjs`: メッセージの検証・通行証・開発用のログイン・量の制限・保存先・本文の読み取り上限・中継の経路・並べ替え
- `server` の `npm run load`: 多数の部屋・接続での入室と配信の負荷テスト（必要なときだけ）

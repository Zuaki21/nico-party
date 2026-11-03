# NicoParty

ボイスチャンネルのメンバーでニコニコ動画を同時視聴する Discord Activity

- インストール: [Discord に追加](https://discord.com/oauth2/authorize?client_id=1563868455646531737)（サーバーか、自分のアカウントに追加できます）
- 使い方・案内: https://nico-party.zuaki.dev
- 不具合の報告・要望: [Issues](https://github.com/Zuaki21/nico-party/issues)

非公式のアプリです。ニコニコ動画・Discord の運営とは関係ありません。

## できること

- 再生・一時停止・シークを全員に同期
- URL を入れて再生リストに追加。視聴済み・再生中も残り、ドラッグで並べ替えできる
- リピート（再生リスト全体 / 1曲）とシャッフル。部屋の全員で共通
- キーワード検索（ニコニコのスナップショット検索 API。1 日 1 回更新なので投稿直後の動画は出ない）
- 再生リストと再生中の動画に、追加した人の Discord のアイコンを表示
- 他の人の操作（シーク・動画の切り替え・追加・削除）を、動画の上に通知
- PiP 表示中は動画だけを表示
- 設定画面（テーマ、UI サイズ、日本語 / 英語、ステータスに視聴中の動画を表示するか、操作の通知）。設定は各自の画面だけに効く
- 不具合の報告（設定画面から。直近の動作の記録を送り、報告 ID が出る）

## ドキュメント

| 文書 | 内容 |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | 不具合の報告・要望・Pull Request の送り方 |
| [docs/development.md](docs/development.md) | 手元で動かす方法（ブラウザだけで確かめる / Discord の中で確かめる）、コードの読み始め、確認用のコマンド |
| [docs/deployment.md](docs/deployment.md) | （メンテナー向け）本番への反映、サーバーの環境変数、不具合の報告の探し方、セキュリティ上の前提 |

## 構成

```
client/       Vite + TypeScript。Activity の画面と同期処理。本番は Cloudflare Workers が静的ファイルとして配信する
server/       Node + ws。本番は Docker で動かし、Cloudflare Tunnel で公開する
                /api/token      Discord OAuth のコードをトークンに交換し、通行証を発行する
                /api/search     キーワード検索（スナップショット検索 API を 10 分キャッシュ）
                /api/log        不具合の報告（画面の動作の記録）を受け取り、報告 ID を返す
                /api/dev-token  開発用のログイン（ローカルでだけ使える。docs/development.md）
                /ws/:instanceId 部屋（= Activity のインスタンス）ごとの WebSocket
                /nico/*         ニコニコ埋め込みプレイヤーの中継
                /healthz        生存確認
shared/       クライアントとサーバーで共有するメッセージ定義
deploy/oci/   サーバーを動かす docker-compose（サーバー本体 + cloudflared）
scripts/      確認用のスクリプトの共通部分（TypeScript を変換して読み込む）
```

### 動く仕組み

- **部屋**: Activity のインスタンスごとに 1 つ。サーバーが再生状態と再生リストをメモリに持ち、WebSocket で全員に配る。
  停止するときだけファイルに書き出し、起動後に読み込む
- **同期**: サーバーが「どの動画を、いつ、どの位置から再生しているか」を持ち、各自の画面（`client/src/player/sync`）が時計のずれを補正して合わせる
- **通行証**: Discord でログインした人に、サーバーが HMAC 署名つきの通行証を発行する。部屋・中継・検索・報告は、通行証がないと使えない
- **中継**: Activity の中では、Discord のプロキシ以外への通信が CSP で止められる。
  そのためサーバーが、ニコニコの埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を `/.proxy/external/<host を -- で連結>`（Discord の URL Mapping）に書き換えて返す。
  動画のセグメントは、Discord のプロキシが直接ニコニコから取得する（サーバーは通らない）

## 制限

- チャンネルの設定で外部での再生が禁止されている動画（埋め込みページが `externally_unwatchable` を返すもの）は再生できない
- 埋め込みプレイヤーの postMessage API は非公式なので、ニコニコ側の仕様変更で動かなくなる可能性がある
- 動画は H.264 なので、H.264 を再生できない環境（一部の Linux 版 Discord など）では再生できない

## ライセンス

[MIT License](LICENSE)

## クレジット

- ニコニコ埋め込みプレイヤーの中継は [kikoune](https://github.com/sevenc-nanashi/kikoune)（MIT License）の方式を移植したもの
- 再生数・コメント数のアイコンは [Lucide](https://lucide.dev)（ISC License）

ライセンス本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照

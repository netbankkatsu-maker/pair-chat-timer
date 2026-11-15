# Pair — ふたりの時間

招待制・2人用の汎用チャットと共有タイマー。日本語とスマートフォンに対応しています。

## 利用方法

1. 表示名を入力して「部屋をつくる」。
2. 招待リンクを相手に送る。作成者はページを開いたままにする。
3. 相手の参加リクエストを承認する。
4. チャットを送り、作成者が共有タイマーを操作する。両者が停止でき、参加者は「完了」を記録できる。

招待リンクを知っている人は参加をリクエストできます。承認する相手を確認してください。ページ再読み込みで作成者の部屋は終了します。最長2時間で終了します。ブラウザがバックグラウンドで通信を止めた場合も接続を失い、タイマーが停止することがあります。

## データ

ログイン、広告、解析、データベースへの書き込みはありません。Cloudflare Workerのメモリ上で接続情報とタイマーを管理し、チャットは受信画面にだけ表示します（最大200件）。会話本文はサーバー側に蓄積しません。招待と操作情報を含むWebSocket通信はCloudflareを経由します。ページを閉じる・再読み込みすることで画面上の会話は失われます。招待キーはURLフラグメントで渡し、読み込み後にアドレスバーから除去します。

## ローカル開発

Node.js 22以降。

```sh
npm ci
npm run dev
```

http://localhost:8787 を2つのブラウザで開きます。

別のターミナルで、実際のWebSocketを使う統合テストを実行できます。

```sh
npm test
npm run build
npx wrangler deploy --config worker/wrangler.jsonc --dry-run
```

## Cloudflareへの公開

Cloudflare Pagesが画面とAPI入口、別WorkerのDurable Objectが部屋とWebSocket接続を担当します。SQLite対応の名前空間を作成しますが、アプリはストレージへの読み書きを行いません。実行中は通常のWebSocketを使用するため、利用時間・リクエスト数はCloudflareの契約プランの利用量に含まれます。

```sh
npx wrangler login
npm run deploy:worker
npx wrangler pages project create pair-chat-timer --production-branch main --force
npm run deploy:pages
```

Pagesプロジェクトの初回作成だけ `--force` を指定し、新しいWorkersへの自動移行を避けます。作成済みプロジェクトの更新には指定しません。

Pages設定は `wrangler.jsonc`、Worker設定は `worker/wrangler.jsonc`。同じCloudflareアカウントに配置します。Pagesには `ROOMS` → `pair-chat-timer-api` の `Room` クラスのバインディングが必要で、設定ファイルで宣言済みです。Worker単体の公開URLは無効にしています。以後は `npm run deploy:worker` と `npm run deploy:pages` で更新します。

本番テストは以下。空の試験用ルームだけ作成・終了します。

```sh
TEST_ORIGIN=https://pair-chat-timer.pages.dev npm test
```

## 仕様

- 作成者：時間設定、開始、一時停止、リセット、参加承認。
- 両者：チャット、完了、停止、退出。
- 第3者、無効な招待、不正な操作を拒否。
- 4秒ごとの接続確認、約16秒の通信断で停止。
- 画面はサーバー時刻に合わせて残り時間を描画。サーバーで終了と操作順序を確定。
- 1メッセージ1,000文字、表示名20文字、タイマー10秒～60分（画面ではプリセット）、ルーム2時間。

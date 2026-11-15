# Pair — ふたりの時間

2人用の汎用チャットと共有タイマー。スマートフォン対応。会話欄だけをスクロールし、操作を1画面に配置します。

## 利用方法

1. 管理者用リンクでブラウザを認証する。
2. 表示名を入力して部屋を作成し、招待リンクを相手に送る。
3. 相手の参加リクエストを承認する。
4. チャットを送り、作成者がタイマーを操作する。両者が完了・停止できる。

部屋・招待を作成できるのは管理者として認証されたブラウザだけです。通常URLを他の人が開いても作成できません。管理者認証は署名付きのHttpOnly・Secure・SameSite=Strict Cookieで30日間保持します。管理者用リンクは相手に共有しないでください。

招待は参加承認後に無効となり、退出後も同じリンクを再利用できません。再招待には作成者の「新しい招待リンクを発行」を使います。承認前に見送ったリクエストは招待の使用には数えません。

作成者はページを開いたまま使用します。再読み込みで部屋は終了します。最長2時間。ブラウザがバックグラウンドで通信を止めた場合も切断・停止することがあります。

## データ

参加者のログイン、広告、解析、データベースへの書き込みはありません。Cloudflareのメモリ上で接続情報とタイマーを管理し、会話本文はサーバーに蓄積しません。受信画面は最大200件を保持し、再読み込みすると失われます。通信はCloudflareを経由します。招待・管理者キーはURLフラグメントで渡し、読み込み後にアドレスバーから除去します。

## ローカル開発

Node.js 22以降。

```sh
npm ci
printf 'OWNER_KEY="local-test-owner-key"\n' > worker/.dev.vars
npm run dev
```

管理者側は `http://localhost:8787/#owner=local-test-owner-key` を開きます。参加者側は発行された招待リンクを開きます。このキーはローカル専用です。

別のターミナルで実際のWebSocketを使う統合テストを実行します。

```sh
npm test
npm run build
npx wrangler deploy --config worker/wrangler.jsonc --dry-run
```

## Cloudflareへの公開

Pagesが画面・API入口、別WorkerのDurable Objectが部屋とWebSocketを担当します。SQLite対応の名前空間を作成しますが、ストレージには読み書きしません。通常のWebSocketを使うため、利用時間・リクエスト数はCloudflare契約プランの利用量に含まれます。

```sh
npx wrangler login
npm run deploy:worker
npx wrangler pages project create pair-chat-timer --production-branch main --force
npx wrangler pages secret put OWNER_KEY --project-name pair-chat-timer
npm run deploy:pages
```

OWNER_KEYには十分に長いランダム値を設定します。管理者だけが `https://pair-chat-timer.pages.dev/#owner=<OWNER_KEY>` を開いて認証します。キーはGitに登録しないでください。

初回プロジェクト作成時だけ `--force` を指定し、Workersへの自動移行を避けます。作成済みプロジェクトでは指定しません。

Pages設定は `wrangler.jsonc`、Worker設定は `worker/wrangler.jsonc`。同一アカウントに配置します。Pagesの `ROOMS` は `pair-chat-timer-api` の `Room` クラスに接続します。Worker単体の公開URLは無効です。以後は `npm run deploy:worker` と `npm run deploy:pages` で更新します。

本番テストには環境変数 `TEST_ORIGIN` と `TEST_OWNER_KEY` が必要です。キーをログや履歴に出さない方法で渡してください。テストは空の試験用ルームを作成・終了します。

## 仕様

- 管理者：部屋作成と招待発行。
- 作成者：時間設定、開始、一時停止、リセット、参加承認。
- 両者：チャット、完了、停止、退出。
- 管理者認証なしの作成、第三者、使用済み招待、不正な操作を拒否。
- 4秒ごとの接続確認、約16秒の通信断で停止。
- サーバー時刻を基準に残り時間を描画し、サーバー側で操作順と終了を確定。
- メッセージ1,000文字、表示名20文字、タイマー10秒～60分（画面はプリセット）、部屋2時間。

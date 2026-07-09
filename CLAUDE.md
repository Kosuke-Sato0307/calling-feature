# CLAUDE.md

このリポジトリで作業する AI エージェント（および開発者）向けのガイドです。
別セッションでも文脈を引き継げるよう、要点をまとめています。

## このプロジェクトは何か

**Callin** — LINE の音声通話のような Web アプリ。無料版 Cloudflare Workers **のみ**で動作。
PC・タブレット・スマホのブラウザ対応。ユーザーは開発初心者のため、
GitHub / Cloudflare の操作は逐一わかりやすく案内する方針。

詳細な設計は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、
デプロイ手順は [`docs/DEPLOY.md`](docs/DEPLOY.md) を参照。

## 確定している方針（勝手に変えない）

- **Cloudflare Pages は使わない**。1 つの Worker で静的配信＋API＋Durable Object を兼ねる。
- **音声通話 + テキストチャット**（ビデオ通話は未実装。拡張候補）。
  チャットは既読表示つき。通話履歴はチャット内に残す（`messages` テーブルに集約、保存90日）。
- **ログインはパスワードなし**。初回に表示名を入力→ランダムID発行→localStorage 保存。
  別端末からは `ID + 表示名` の一致でログイン（`POST /api/login`）。
- **NAT越えは無料の公開 STUN のみ**（Google STUN）。TURN は未使用。
- **ビルドステップなし**の素の HTML/CSS/JS（初心者が読める構成を維持）。
- **Durable Object は SQLite バックエンド**（`new_sqlite_classes`）。無料プランで動かす必須条件。

## 構成

```
wrangler.jsonc     # Worker設定: assets(静的配信) + durable_objects(HUB) + migrations(v1)
src/worker.js      # Workerエントリ + Hub Durable Object（API + WebSocket中継 + SQLite）
public/
  index.html       # 全画面を含むSPA（.screen / .modal を表示切替）
  app.js           # クライアント全ロジック（state オブジェクトに集約）
  style.css        # テーマカラーは --theme 変数で全体反映
docs/ARCHITECTURE.md
docs/DEPLOY.md
```

## よく使うコマンド

```bash
npm install     # 依存インストール（wrangler）
npm run dev     # ローカル開発サーバー（http://localhost:8787）
npm run deploy  # 手動デプロイ（通常は git push で自動デプロイ）
```

## 動作の要点（コードを触る前に）

- Worker の `fetch`: `/api/*` と `/ws` → `env.HUB`（`idFromName("global")` の単一DO）へ。
  それ以外 → `env.ASSETS.fetch`（静的ファイル）。
- **全ユーザーが単一の Hub DO に集約**される。WebSocket は userId をタグにして受け入れ、
  `state.getWebSockets(userId)` でオンライン判定・宛先ルーティング。
- 友だちは**双方向登録**（`friends` に2行）。
- **チャット**は `messages` テーブル（`kind` で text/call を区別）。送信・既読は HTTP、
  リアルタイム配信は WebSocket の `chat-message` / `messages-read`。
  **通話履歴は発信者側だけが記録**（`recordCall`）して二重記録を防ぐ。
  古いメッセージは DO の alarm で日次削除（90日）。
- WebSocket メッセージの `from` は**必ずサーバー側で上書き**（なりすまし防止）。
- 切断時の presence 判定は `isOnlineExcluding(userId, ws)` で**閉じかけの socket を除外**する
  （Hibernation の close ハンドラ中はまだ自分が一覧に残るため。ここは過去にハマった箇所）。

## 検証方法

- API: `npm run dev` 後、`curl` で `/api/register` `/api/login` `/api/user/:id`
  `/api/friends`（POST/GET）を確認。チャットは `/api/messages`（GET/POST）
  `/api/messages/read` `/api/messages/call` を確認。
- シグナリング: Node 標準の `WebSocket` で2クライアント接続し、`presence` と
  `call-invite`/`call-accept`/`offer` の中継、切断時の `online:false` を確認
  （過去の検証スクリプトの考え方は ARCHITECTURE の通話フロー参照）。
- 実際の音声接続（WebRTC）はブラウザ2つ（別タブ/別端末）で手動確認が必要。
  ヘッドレスでは音声そのものは検証不可。
- コミット前に必ず動作確認する。テストが通らない状態でコミットしない。

## 開発フロー / Git

- 開発ブランチ: **`claude/line-calling-app-4urn4x`**。ここで開発・コミット・プッシュ。
- コミットメッセージ・ドキュメント・コメントは**日本語**で書く。
- PR は**明示的に依頼された時だけ**作成する。
- プッシュすると Cloudflare が自動デプロイ（連携済み）。

## 今後の拡張候補（未実装）

- ビデオ通話 / グループ通話 / 着信音 / プッシュ通知
- チャットの画像・スタンプ送信（現状はテキストのみ）
- TURN サーバー（Cloudflare Realtime）で繋がりやすさ向上
- 本格的な認証（トークン/パスワード）

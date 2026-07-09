# アーキテクチャ / 設計メモ

Callin の内部設計をまとめたドキュメントです。別セッションで開発を引き継ぐ際は、
まずここと [`../CLAUDE.md`](../CLAUDE.md) を読んでください。

## 全体像

```
   ┌─────────────┐        HTTPS / WSS        ┌──────────────────────────┐
   │  ブラウザ A   │◀───────────────────────▶│   Cloudflare Worker       │
   │ (public/*)   │                          │   (src/worker.js)         │
   └──────┬───────┘                          │                          │
          │                                  │  ・静的ファイル配信 (ASSETS) │
          │   WebRTC 音声 (P2P)               │  ・API ルーティング          │
          │  ◀─────────────────────▶         │  ・/ws, /api/* → Hub DO     │
          │                                  │                          │
   ┌──────┴───────┐                          │   ┌────────────────────┐ │
   │  ブラウザ B   │◀───────────────────────▶│   │ Hub Durable Object  │ │
   │ (public/*)   │        HTTPS / WSS        │   │  (SQLite + WS中継)   │ │
   └──────────────┘                          │   └────────────────────┘ │
                                             └──────────────────────────┘
```

- **音声データそのもの**はブラウザ同士が WebRTC で直接やり取りします（サーバーを通りません）。
- **Worker / Durable Object** は「相手を探す・接続情報を橋渡しする・オンライン状態を配る」役割です。

## なぜこの構成か

- **Cloudflare Pages を使わない要件** → Worker の [Static Assets 機能](https://developers.cloudflare.com/workers/static-assets/) で
  `public/` をそのまま配信。フロントもバックも 1 つの Worker で完結。
- **無料プランで状態を持ちたい** → 2026 年から **SQLite バックエンドの Durable Object が無料プランで利用可能**。
  ユーザー・友だち情報の永続化と、WebSocket 接続の集約（シグナリング中継）を 1 つの DO が担う。
- **リアルタイムな着信・オンライン通知** → WebSocket（Durable Object の Hibernation API）。

## リクエストの振り分け（src/worker.js の `fetch`）

| パス | 処理 |
| --- | --- |
| `/api/*` | Hub Durable Object（`idFromName("global")`）へ転送 |
| `/ws` | 同上（WebSocket にアップグレード） |
| その他 | `env.ASSETS.fetch()` で静的ファイルを返す |

Durable Object は常に **同じ 1 インスタンス（"global"）** を使います。
全ユーザーが同じ DO に集まることで、WebSocket 中継とデータ参照がシンプルになります。

## データモデル（Hub Durable Object 内の SQLite）

```sql
-- ユーザー
CREATE TABLE users (
  id         TEXT PRIMARY KEY,  -- ランダム8桁ID（紛らわしい文字を除外）
  name       TEXT NOT NULL,     -- 表示名
  color      TEXT NOT NULL,     -- テーマカラー (#RRGGBB)
  created_at INTEGER NOT NULL
);

-- 友だち関係（双方向に2行入れる）
CREATE TABLE friends (
  user_id    TEXT NOT NULL,
  friend_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- チャットメッセージ（テキストと通話履歴を同じテーブルに保存）
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   TEXT NOT NULL,       -- 送信者ID（通話履歴では発信者）
  receiver_id TEXT NOT NULL,       -- 受信者ID（通話履歴では着信者）
  kind        TEXT NOT NULL,       -- 'text'（本文）/ 'call'（通話履歴 JSON）
  body        TEXT NOT NULL,       -- text: 本文 / call: {"result","duration"}
  created_at  INTEGER NOT NULL,
  read_at     INTEGER              -- 既読時刻。NULL = 未読
);
```

友だち追加時は `(A,B)` と `(B,A)` の **2 行** を入れ、両者の一覧に相手が出るようにしています。

### チャット・通話履歴

- **1メッセージ = 1行**。テキストも通話履歴も同じ `messages` テーブルに入れ、`kind` で区別します。
- **通話履歴は発信者側だけが記録**します（二重記録を防ぐため）。結果 `result` は
  `answered`（`duration` 秒つき）/ `missed` / `rejected` / `canceled` / `failed`。
  受信者側の画面では送信者が自分でないため「着信」「不在着信」等として表示されます。
- **既読**は、相手がトークを開いたときに `read_at` を一括で更新し、送信者へ `messages-read` を配信します。
- **保存期間は 90 日**。Durable Object の [Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/)
  で日次に走らせ、古いメッセージを自動削除して無料枠のストレージを圧迫しないようにしています。

## HTTP API

| メソッド・パス | 内容 | レスポンス |
| --- | --- | --- |
| `POST /api/register` | `{name, color}` で登録、ランダムID発行 | `{id, name, color}` |
| `POST /api/login` | `{id, name}` が一致すればログイン（別端末復元） | `{id, name, color}` / 401 / 404 |
| `GET /api/user/:id` | ID でユーザー検索 | `{id, name, color}` / 404 |
| `PATCH /api/user/:id` | `{name?, color?}` でプロフィール更新 | `{id, name, color}` |
| `POST /api/friends` | `{userId, friendId}` で友だち追加（双方向） | `{ok, friend}` |
| `GET /api/friends?userId=` | 友だち一覧（オンライン・未読数・直近メッセージ付き） | `{friends: [...]}` |
| `GET /api/messages?userId=&peerId=` | 2者間の会話履歴（古い順・最新300件） | `{messages: [...]}` |
| `POST /api/messages` | `{from, to, text}` でテキスト送信 | `{message}` |
| `POST /api/messages/call` | `{from, to, result, duration}` で通話履歴を記録 | `{message}` |
| `POST /api/messages/read` | `{userId, peerId}` で相手からのメッセージを既読化 | `{ok}` |

## WebSocket（`/ws?userId=`）

- 接続時に `state.acceptWebSocket(ws, [userId])` で **userId をタグ**として保持（Hibernation 対応）。
- オンライン判定は `state.getWebSockets(userId)` に接続があるかで行う。
- 接続・切断時に、その人の友だち全員へ `presence` を配信。
  - ⚠️ 切断ハンドラ（`webSocketClose`）実行中は、閉じかけの socket がまだ一覧に残るため、
    `isOnlineExcluding(userId, ws)` で **自分自身を除外**して判定している。

### メッセージ種別（`to` で宛先を指定）

中継系（宛先ユーザーの WebSocket へそのまま転送。`from` はサーバー側で必ず付与）:

- `call-invite` … 発信（`fromName` に発信者名を含める）
- `call-accept` / `call-reject` / `call-cancel` / `call-end` … 通話制御
- `offer` / `answer` / `ice` … WebRTC のシグナリング（SDP・ICE candidate）

サーバー発の通知:

- `presence` … `{userId, online}` オンライン状態の変化
- `friend-added` … 誰かが自分を友だち追加した（一覧再取得を促す）
- `call-unavailable` … 発信先がオフラインで届かなかった
- `chat-message` … `{message}` 新着メッセージ（テキスト or 通話履歴）
- `messages-read` … `{by}` 相手が自分のメッセージを既読にした（既読表示を更新）
- `pong` … `ping` への応答（接続維持）

## 通話フロー（発信 → 通話中）

```
発信者A                         サーバー(Hub)                     着信者B
  │  マイク取得                                                     │
  │  call-invite(to=B) ─────────▶ 中継 ─────────▶ call-invite(from=A) │  着信モーダル表示
  │                                                                │  マイク取得・応答
  │  ◀───────── call-accept(from=B) ◀──────── call-accept(to=A)      │
  │  RTCPeerConnection作成                                          │
  │  offer ─────────────────────▶ 中継 ─────────────────────▶ offer  │
  │  ◀──────────────── answer ◀──────────────── answer               │
  │  ◀────────── ice ──────────▶（双方向に交換）◀────────── ice ─────▶ │
  │  ══════════ WebRTC P2P 音声接続確立（サーバーを介さない）═══════════ │
```

- WebRTC 設定: `stun:stun.l.google.com:19302` ほか Google の公開 STUN。
- `RTCPeerConnection.connectionState === "connected"` で通話開始（タイマー開始）。
- ミュートは `localStream` の音声トラックの `enabled` を切り替えるだけ（送信を止める）。

## フロントエンド（public/）

- **状態管理**は `app.js` の `state` オブジェクトに集約（フレームワーク不使用）。
- 画面は 1 つの HTML 内で `.screen` / `.modal` の表示切替で遷移。
- ログイン情報（`{id, name, color}`）は `localStorage`（キー `callin_user`）に保存。
- テーマカラーは `--theme` CSS 変数を JS で差し替えて全体に反映。

## 既知の制約・今後の拡張候補

- **STUN のみ**なので対称型 NAT 等では繋がらないことがある → Cloudflare Realtime の TURN 追加が候補。
- **認証が簡易**（ID + 表示名）。本格運用するならトークン/パスワード方式へ。
- ビデオ通話・グループ通話・プッシュ通知などは未実装（拡張しやすい構造）。
  チャット・既読・通話履歴は実装済み（`messages` テーブル）。
- 全ユーザーが単一 DO に集約されるため、超大規模には向かない（個人〜小規模想定）。

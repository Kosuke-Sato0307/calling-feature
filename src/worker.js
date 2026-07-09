// ============================================================================
// LINE通話風アプリ - Cloudflare Worker エントリ + Hub Durable Object
//
// この 1 ファイルで以下を担います:
//   1. Worker エントリ: リクエストを振り分ける（API/WebSocket → DO、その他 → 静的ファイル）
//   2. Hub Durable Object: ユーザー・友だち情報の保存（SQLite）と、
//      通話のシグナリング（WebSocket 中継）
//
// 設計の詳細は docs/ARCHITECTURE.md を参照してください。
// ============================================================================

/**
 * Worker のエントリポイント。
 * - /api/* と /ws は単一の Hub Durable Object（"global"）へ転送
 * - それ以外はフロントエンドの静的ファイル（public/）を返す
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API・WebSocket は Durable Object に処理を任せる
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      // 常に同じ 1 つの DO インスタンス（"global"）に集約する
      const id = env.HUB.idFromName("global");
      const stub = env.HUB.get(id);
      return stub.fetch(request);
    }

    // それ以外は静的アセット（HTML/CSS/JS）を配信
    return env.ASSETS.fetch(request);
  },
};

// ============================================================================
// Hub Durable Object
// ============================================================================

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    // テーブルを初期化（存在しなければ作成）
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // アイコン画像（サムネイルの data URL）用の列を追加。既存 DB には
    // CREATE TABLE IF NOT EXISTS では列が増えないため、冪等に ALTER する。
    try {
      this.sql.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
    } catch (e) {
      // 既に列がある場合は "duplicate column name" 等で失敗するので無視する
    }
    // 拡大表示用の高画質アイコン（元画像に近い大きめの data URL）。
    // 一覧では小さい avatar を使い、拡大時だけ avatar_full を取りに行くことで
    // 友だち一覧のレスポンスを軽く保つ。列が無い既存 DB へは冪等に ALTER する。
    try {
      this.sql.exec("ALTER TABLE users ADD COLUMN avatar_full TEXT");
    } catch (e) {
      // 既に列がある場合は無視する
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS friends (
        user_id    TEXT NOT NULL,
        friend_id  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_id)
      );
    `);

    // チャットメッセージ（テキスト・通話履歴を同じテーブルに保存）。
    //   kind = 'text' … 通常のテキストメッセージ（body に本文）
    //   kind = 'call' … 通話履歴（body に JSON: {"result","duration"}）
    //   read_at = NULL … 受信者がまだ確認していない（未読）
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'text',
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        read_at     INTEGER
      );
    `);
    // 2 者間の会話を時系列で引くための索引と、未読件数を数えるための索引。
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id, id)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (receiver_id, sender_id, read_at)"
    );

    // 古いメッセージを自動削除するための日次アラームを（未設定なら）仕掛ける。
    // constructor は同期関数のため await せず、設定済みかどうかだけ確認して予約する。
    this.state.storage.getAlarm().then((at) => {
      if (at === null) this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }).catch(() => {});
  }

  // --------------------------------------------------------------------------
  // 日次アラーム: 保存期間を過ぎたメッセージを削除し、次回を予約する。
  // （無料枠のストレージを圧迫しないよう、古い履歴は自動的に消える）
  // --------------------------------------------------------------------------
  async alarm() {
    const cutoff = Date.now() - MESSAGE_RETENTION_MS;
    try {
      this.sql.exec("DELETE FROM messages WHERE created_at < ?", cutoff);
    } catch {
      // 削除に失敗しても次回に再挑戦するだけなので無視する
    }
    this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }

  // --------------------------------------------------------------------------
  // HTTP / WebSocket の入口
  // --------------------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket 接続（シグナリング・オンライン状態）
    if (url.pathname === "/ws") {
      return this.handleWebSocket(request, url);
    }

    try {
      // --- ユーザー登録 ---
      if (url.pathname === "/api/register" && request.method === "POST") {
        return this.handleRegister(request);
      }
      // --- 名前＋ID でログイン（別端末からの復元） ---
      if (url.pathname === "/api/login" && request.method === "POST") {
        return this.handleLogin(request);
      }
      // --- 友だち追加 ---
      if (url.pathname === "/api/friends" && request.method === "POST") {
        return this.handleAddFriend(request);
      }
      // --- 友だち一覧 ---
      if (url.pathname === "/api/friends" && request.method === "GET") {
        return this.handleListFriends(url);
      }
      // --- チャット: 会話履歴の取得 ---
      if (url.pathname === "/api/messages" && request.method === "GET") {
        return this.handleListMessages(url);
      }
      // --- チャット: テキスト送信 ---
      if (url.pathname === "/api/messages" && request.method === "POST") {
        return this.handleSendMessage(request);
      }
      // --- チャット: 既読にする ---
      if (url.pathname === "/api/messages/read" && request.method === "POST") {
        return this.handleMarkRead(request);
      }
      // --- チャット: 通話履歴を記録する ---
      if (url.pathname === "/api/messages/call" && request.method === "POST") {
        return this.handleRecordCall(request);
      }
      // --- 拡大表示用の高画質アイコン取得 ( /api/user/:id/avatar ) ---
      const avatarMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/avatar$/);
      if (avatarMatch && request.method === "GET") {
        return this.handleGetAvatar(decodeURIComponent(avatarMatch[1]));
      }
      // --- ユーザー検索 / プロフィール更新 ( /api/user/:id ) ---
      const userMatch = url.pathname.match(/^\/api\/user\/([^/]+)$/);
      if (userMatch) {
        const targetId = decodeURIComponent(userMatch[1]);
        if (request.method === "GET") return this.handleGetUser(targetId);
        if (request.method === "PATCH") return this.handleUpdateUser(targetId, request);
      }
    } catch (err) {
      return json({ error: "server_error", message: String(err) }, 500);
    }

    return json({ error: "not_found" }, 404);
  }

  // --------------------------------------------------------------------------
  // ユーザー登録
  // --------------------------------------------------------------------------
  async handleRegister(request) {
    const body = await safeJson(request);
    const name = (body.name || "").trim();
    const color = normalizeColor(body.color);
    const avatarCheck = normalizeAvatar(body.avatar);
    const avatarFullCheck = normalizeAvatar(body.avatarFull, AVATAR_FULL_MAX_LEN);

    if (!name) return json({ error: "name_required" }, 400);
    if (name.length > 30) return json({ error: "name_too_long" }, 400);
    if (!avatarCheck.ok) return json({ error: avatarCheck.error }, 400);
    if (!avatarFullCheck.ok) return json({ error: avatarFullCheck.error }, 400);
    const avatar = avatarCheck.value;
    const avatarFull = avatarFullCheck.value;

    // 一意なランダム ID を生成（衝突したら作り直す）
    let id = generateId();
    for (let i = 0; i < 5; i++) {
      const exists = [...this.sql.exec("SELECT id FROM users WHERE id = ?", id)];
      if (exists.length === 0) break;
      id = generateId();
    }

    const now = Date.now();
    this.sql.exec(
      "INSERT INTO users (id, name, color, avatar, avatar_full, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name,
      color,
      avatar,
      avatarFull,
      now
    );

    return json({ id, name, color, avatar });
  }

  // --------------------------------------------------------------------------
  // 名前＋ID ログイン（パスワードなし・別端末からの復元用）
  // --------------------------------------------------------------------------
  async handleLogin(request) {
    const body = await safeJson(request);
    const id = (body.id || "").trim();
    const name = (body.name || "").trim();

    if (!id || !name) return json({ error: "id_and_name_required" }, 400);

    const rows = [...this.sql.exec("SELECT id, name, color, avatar FROM users WHERE id = ?", id)];
    if (rows.length === 0) return json({ error: "not_found" }, 404);

    const user = rows[0];
    // 名前が一致した場合のみログインを許可する
    if (user.name !== name) return json({ error: "name_mismatch" }, 401);

    return json({ id: user.id, name: user.name, color: user.color, avatar: user.avatar ?? null });
  }

  // --------------------------------------------------------------------------
  // ユーザー検索（ID 検索）
  // --------------------------------------------------------------------------
  handleGetUser(id) {
    const rows = [...this.sql.exec("SELECT id, name, color, avatar FROM users WHERE id = ?", id)];
    if (rows.length === 0) return json({ error: "not_found" }, 404);
    const u = rows[0];
    return json({ id: u.id, name: u.name, color: u.color, avatar: u.avatar ?? null });
  }

  // --------------------------------------------------------------------------
  // プロフィール（名前・テーマカラー）更新
  // --------------------------------------------------------------------------
  async handleUpdateUser(id, request) {
    const rows = [...this.sql.exec("SELECT id, name, color, avatar, avatar_full FROM users WHERE id = ?", id)];
    if (rows.length === 0) return json({ error: "not_found" }, 404);

    const body = await safeJson(request);
    const current = rows[0];
    const name = body.name !== undefined ? String(body.name).trim() : current.name;
    const color = body.color !== undefined ? normalizeColor(body.color) : current.color;

    if (!name) return json({ error: "name_required" }, 400);
    if (name.length > 30) return json({ error: "name_too_long" }, 400);

    // avatar は指定があれば更新（null で「頭文字に戻す」）。未指定なら現状維持。
    let avatar = current.avatar ?? null;
    let avatarFull = current.avatar_full ?? null;
    if (body.avatar !== undefined) {
      const avatarCheck = normalizeAvatar(body.avatar);
      if (!avatarCheck.ok) return json({ error: avatarCheck.error }, 400);
      avatar = avatarCheck.value;
      // アイコンを消したら高画質版も一緒に消す（残しておくと拡大時に幽霊画像が出る）
      if (avatar === null) avatarFull = null;
    }
    // 拡大表示用の高画質版。未指定なら現状維持（名前だけ変更した保存で消えないように）。
    if (body.avatarFull !== undefined) {
      const avatarFullCheck = normalizeAvatar(body.avatarFull, AVATAR_FULL_MAX_LEN);
      if (!avatarFullCheck.ok) return json({ error: avatarFullCheck.error }, 400);
      avatarFull = avatarFullCheck.value;
    }

    this.sql.exec(
      "UPDATE users SET name = ?, color = ?, avatar = ?, avatar_full = ? WHERE id = ?",
      name,
      color,
      avatar,
      avatarFull,
      id
    );
    return json({ id, name, color, avatar });
  }

  // --------------------------------------------------------------------------
  // 拡大表示用の高画質アイコンを取得する。
  // 高画質版が無いユーザー（未アップロード or 旧データ）は小さい avatar で代用する。
  // --------------------------------------------------------------------------
  handleGetAvatar(id) {
    const rows = [...this.sql.exec("SELECT avatar, avatar_full FROM users WHERE id = ?", id)];
    if (rows.length === 0) return json({ error: "not_found" }, 404);
    const u = rows[0];
    return json({ avatar: u.avatar_full ?? u.avatar ?? null });
  }

  // --------------------------------------------------------------------------
  // 友だち追加（双方向に登録）
  // --------------------------------------------------------------------------
  async handleAddFriend(request) {
    const body = await safeJson(request);
    const userId = (body.userId || "").trim();
    const friendId = (body.friendId || "").trim();

    if (!userId || !friendId) return json({ error: "ids_required" }, 400);
    if (userId === friendId) return json({ error: "cannot_add_self" }, 400);

    // 両者が実在するか確認
    const u = [...this.sql.exec("SELECT id FROM users WHERE id = ?", userId)];
    const f = [...this.sql.exec("SELECT id, name, color, avatar FROM users WHERE id = ?", friendId)];
    if (u.length === 0) return json({ error: "user_not_found" }, 404);
    if (f.length === 0) return json({ error: "friend_not_found" }, 404);

    const now = Date.now();
    // 双方向に登録（相手の一覧にも自分が出るように）
    this.sql.exec(
      "INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
      userId,
      friendId,
      now
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
      friendId,
      userId,
      now
    );

    // 相手がオンラインなら、友だちリスト更新を促す通知を送る
    this.sendTo(friendId, { type: "friend-added", from: userId });

    return json({ ok: true, friend: f[0] });
  }

  // --------------------------------------------------------------------------
  // 友だち一覧（各友だちの情報 + オンライン状態）
  // --------------------------------------------------------------------------
  handleListFriends(url) {
    const userId = (url.searchParams.get("userId") || "").trim();
    if (!userId) return json({ error: "userId_required" }, 400);

    const rows = [
      ...this.sql.exec(
        `SELECT u.id AS id, u.name AS name, u.color AS color, u.avatar AS avatar
         FROM friends f
         JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ?
         ORDER BY f.created_at ASC`,
        userId
      ),
    ];

    const friends = rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      avatar: r.avatar ?? null,
      online: this.isOnline(r.id),
      unread: this.countUnread(userId, r.id),
      lastMessage: this.lastMessageWith(userId, r.id),
    }));

    // 直近のやり取りがある友だちを上に並べる（LINE のトーク一覧のように）。
    friends.sort((a, b) => {
      const ta = a.lastMessage ? a.lastMessage.at : 0;
      const tb = b.lastMessage ? b.lastMessage.at : 0;
      return tb - ta;
    });

    return json({ friends });
  }

  // --------------------------------------------------------------------------
  // チャット: 会話履歴の取得（userId と peerId の 2 者間、古い順）
  // --------------------------------------------------------------------------
  handleListMessages(url) {
    const userId = (url.searchParams.get("userId") || "").trim();
    const peerId = (url.searchParams.get("peerId") || "").trim();
    if (!userId || !peerId) return json({ error: "ids_required" }, 400);

    // 上限（最新 MESSAGE_PAGE 件）を id 降順で取り、古い順に並べ直して返す。
    const rows = [
      ...this.sql.exec(
        `SELECT id, sender_id, receiver_id, kind, body, created_at, read_at
         FROM messages
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY id DESC
         LIMIT ?`,
        userId,
        peerId,
        peerId,
        userId,
        MESSAGE_PAGE
      ),
    ];
    rows.reverse();
    return json({ messages: rows.map(rowToMessage) });
  }

  // --------------------------------------------------------------------------
  // チャット: テキストメッセージの送信
  // --------------------------------------------------------------------------
  async handleSendMessage(request) {
    const body = await safeJson(request);
    const from = (body.from || "").trim();
    const to = (body.to || "").trim();
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!from || !to) return json({ error: "ids_required" }, 400);
    if (!text) return json({ error: "text_required" }, 400);
    if (text.length > MESSAGE_MAX_LEN) return json({ error: "text_too_long" }, 400);
    // 友だち同士でないとやり取りできない
    if (!this.areFriends(from, to)) return json({ error: "not_friends" }, 403);

    const message = this.insertMessage(from, to, "text", text);
    // 相手がオンラインなら即配信（オフラインでも履歴として保存済み）
    this.sendTo(to, { type: "chat-message", message });
    return json({ message });
  }

  // --------------------------------------------------------------------------
  // チャット: 通話履歴の記録（発信者側から result と duration を受け取る）
  // --------------------------------------------------------------------------
  async handleRecordCall(request) {
    const body = await safeJson(request);
    const from = (body.from || "").trim();
    const to = (body.to || "").trim();
    const result = (body.result || "").trim();
    const duration = Number.isFinite(body.duration) ? Math.max(0, Math.floor(body.duration)) : 0;

    if (!from || !to) return json({ error: "ids_required" }, 400);
    if (!CALL_RESULTS.includes(result)) return json({ error: "invalid_result" }, 400);
    if (!this.areFriends(from, to)) return json({ error: "not_friends" }, 403);

    const payload = JSON.stringify({ result, duration });
    const message = this.insertMessage(from, to, "call", payload);
    this.sendTo(to, { type: "chat-message", message });
    return json({ message });
  }

  // --------------------------------------------------------------------------
  // チャット: 相手からのメッセージをすべて既読にする
  // --------------------------------------------------------------------------
  async handleMarkRead(request) {
    const body = await safeJson(request);
    const userId = (body.userId || "").trim();
    const peerId = (body.peerId || "").trim();
    if (!userId || !peerId) return json({ error: "ids_required" }, 400);

    const now = Date.now();
    this.sql.exec(
      "UPDATE messages SET read_at = ? WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL",
      now,
      userId,
      peerId
    );
    // 送信者（相手）がオンラインなら「既読になった」と通知して既読表示を更新させる
    this.sendTo(peerId, { type: "messages-read", by: userId });
    return json({ ok: true });
  }

  // --- チャット関連のヘルパー -------------------------------------------------

  /** メッセージを1件保存し、クライアント向けの形に整えて返す */
  insertMessage(from, to, kind, body) {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO messages (sender_id, receiver_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)",
      from,
      to,
      kind,
      body,
      now
    );
    // DO は単一スレッドで動くため、直後の last_insert_rowid() は今の INSERT の id。
    const id = [...this.sql.exec("SELECT last_insert_rowid() AS id")][0].id;
    return rowToMessage({
      id,
      sender_id: from,
      receiver_id: to,
      kind,
      body,
      created_at: now,
      read_at: null,
    });
  }

  /** userId から見た peerId からの未読件数 */
  countUnread(userId, peerId) {
    const rows = [
      ...this.sql.exec(
        "SELECT COUNT(*) AS n FROM messages WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL",
        userId,
        peerId
      ),
    ];
    return rows.length ? Number(rows[0].n) : 0;
  }

  /** userId と peerId の直近1件（一覧のプレビュー用） */
  lastMessageWith(userId, peerId) {
    const rows = [
      ...this.sql.exec(
        `SELECT id, sender_id, receiver_id, kind, body, created_at, read_at
         FROM messages
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY id DESC LIMIT 1`,
        userId,
        peerId,
        peerId,
        userId
      ),
    ];
    if (rows.length === 0) return null;
    const m = rowToMessage(rows[0]);
    return { text: messagePreview(m), at: m.createdAt, mine: m.from === userId, kind: m.kind };
  }

  /** 2 者が友だち関係にあるか */
  areFriends(a, b) {
    const rows = [
      ...this.sql.exec("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?", a, b),
    ];
    return rows.length > 0;
  }

  // --------------------------------------------------------------------------
  // WebSocket: 接続受け入れ（Hibernation API を使用）
  // --------------------------------------------------------------------------
  handleWebSocket(request, url) {
    const userId = (url.searchParams.get("userId") || "").trim();
    if (!userId) return new Response("userId required", { status: 400 });

    const user = [...this.sql.exec("SELECT id FROM users WHERE id = ?", userId)];
    if (user.length === 0) return new Response("user not found", { status: 404 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // userId をタグとして紐付けて受け入れる（Hibernation 対応）
    this.state.acceptWebSocket(server, [userId]);

    // 自分の友だちに「オンラインになった」と通知
    this.broadcastPresence(userId, true);

    return new Response(null, { status: 101, webSocket: client });
  }

  // --------------------------------------------------------------------------
  // WebSocket: メッセージ受信 → 宛先へ中継
  // --------------------------------------------------------------------------
  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const fromId = this.tagOf(ws);
    if (!fromId) return;

    // 疎通確認用の ping
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // 中継するシグナリング／通話制御メッセージ
    const relayTypes = [
      "call-invite",
      "call-accept",
      "call-reject",
      "call-cancel",
      "call-end",
      "offer",
      "answer",
      "ice",
    ];

    if (relayTypes.includes(data.type) && data.to) {
      // 送信元を必ず付与して宛先へ転送（なりすまし防止のため from は上書き）
      const payload = { ...data, from: fromId };
      const delivered = this.sendTo(data.to, payload);

      // 相手がオフラインで届かない場合は、発信者に通知
      if (!delivered && data.type === "call-invite") {
        ws.send(JSON.stringify({ type: "call-unavailable", to: data.to }));
      }
    }
  }

  // --------------------------------------------------------------------------
  // WebSocket: 切断 → オフライン通知
  // --------------------------------------------------------------------------
  async webSocketClose(ws) {
    const userId = this.tagOf(ws);
    if (userId) {
      // close ハンドラ実行中はまだ ws 自身が getWebSockets に残るため除外して判定
      this.broadcastPresence(userId, this.isOnlineExcluding(userId, ws));
    }
  }

  async webSocketError(ws) {
    const userId = this.tagOf(ws);
    if (userId) {
      this.broadcastPresence(userId, this.isOnlineExcluding(userId, ws));
    }
  }

  // --------------------------------------------------------------------------
  // ヘルパー
  // --------------------------------------------------------------------------

  /** WebSocket に紐付いた userId（タグ）を取得 */
  tagOf(ws) {
    const tags = this.state.getTags(ws);
    return tags && tags.length > 0 ? tags[0] : null;
  }

  /** そのユーザーがオンライン（接続中）か */
  isOnline(userId) {
    return this.state.getWebSockets(userId).length > 0;
  }

  /** 指定した socket を除いて、そのユーザーがまだオンラインか（切断処理中の判定用） */
  isOnlineExcluding(userId, excludeWs) {
    return this.state.getWebSockets(userId).some((s) => s !== excludeWs);
  }

  /** 指定ユーザーの全接続へメッセージを送信。1 件でも届けば true */
  sendTo(userId, obj) {
    const sockets = this.state.getWebSockets(userId);
    const text = JSON.stringify(obj);
    let delivered = false;
    for (const s of sockets) {
      try {
        s.send(text);
        delivered = true;
      } catch {
        // 送信失敗は無視
      }
    }
    return delivered;
  }

  /** あるユーザーのオンライン状態を、その友だち全員へ通知 */
  broadcastPresence(userId, online) {
    const friends = [
      ...this.sql.exec("SELECT friend_id FROM friends WHERE user_id = ?", userId),
    ];
    const payload = { type: "presence", userId, online };
    for (const row of friends) {
      this.sendTo(row.friend_id, payload);
    }
  }
}

// ============================================================================
// ユーティリティ関数
// ============================================================================

/** JSON レスポンスを返す */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** リクエストボディを安全に JSON パース（失敗時は空オブジェクト） */
async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// メッセージ関連の定数
const MESSAGE_MAX_LEN = 2000;          // テキスト1件の最大文字数
const MESSAGE_PAGE = 300;              // 会話履歴で一度に返す最大件数（最新から）
const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 保存期間（90日）
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;       // 自動削除アラームの間隔（1日）
const CALL_RESULTS = ["answered", "missed", "rejected", "canceled", "failed"]; // 通話結果

/**
 * SQLite の1行をクライアント向けのメッセージ表現に変換する。
 *   共通: { id, from, to, kind, createdAt, read }
 *   text: { ..., text }
 *   call: { ..., call: { result, duration } }
 */
function rowToMessage(r) {
  const base = {
    id: r.id,
    from: r.sender_id,
    to: r.receiver_id,
    kind: r.kind,
    createdAt: r.created_at,
    read: r.read_at != null,
  };
  if (r.kind === "call") {
    let call = { result: "answered", duration: 0 };
    try {
      const parsed = JSON.parse(r.body);
      call = { result: parsed.result, duration: parsed.duration || 0 };
    } catch {}
    return { ...base, call };
  }
  return { ...base, text: r.body };
}

/** 一覧のプレビュー用に、メッセージを短い文字列にする */
function messagePreview(m) {
  if (m.kind === "call") return "通話";
  return m.text || "";
}

/** 読みやすいランダム ID を生成（紛らわしい文字を除いた 8 桁） */
function generateId() {
  // 0/O, 1/I/L などの紛らわしい文字を除外
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

/** テーマカラーを検証（#RRGGBB 形式のみ許可、それ以外は既定色） */
function normalizeColor(color) {
  const DEFAULT = "#5b8cff";
  if (typeof color !== "string") return DEFAULT;
  const c = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT;
}

// 一覧表示用サムネイルの上限（data URL 文字数）。約75KB相当。
// クライアント側で 128px の小さなサムネイルに変換して送る想定。
const AVATAR_MAX_LEN = 100_000;
// 拡大表示用の高画質アイコンの上限（data URL 文字数）。約300KB相当。
// クライアント側で長辺 800px 程度に収めた画像を送る想定。
const AVATAR_FULL_MAX_LEN = 400_000;

/**
 * アイコン画像（data URL）を検証する。maxLen で許容サイズを切り替える。
 * 戻り値 { ok, value, error }:
 *   - 未設定（null/空）      → { ok:true, value:null }
 *   - data:image/ で始まる   → { ok:true, value:文字列 }（上限内のとき）
 *   - 上限超過               → { ok:false, error:"avatar_too_large" }
 *   - それ以外の不正な値     → { ok:false, error:"avatar_invalid" }
 */
function normalizeAvatar(v, maxLen = AVATAR_MAX_LEN) {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "avatar_invalid" };
  if (!v.startsWith("data:image/")) return { ok: false, error: "avatar_invalid" };
  if (v.length > maxLen) return { ok: false, error: "avatar_too_large" };
  return { ok: true, value: v };
}

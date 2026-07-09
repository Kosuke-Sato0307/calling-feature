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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS friends (
        user_id    TEXT NOT NULL,
        friend_id  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_id)
      );
    `);
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

    if (!name) return json({ error: "name_required" }, 400);
    if (name.length > 30) return json({ error: "name_too_long" }, 400);
    if (!avatarCheck.ok) return json({ error: avatarCheck.error }, 400);
    const avatar = avatarCheck.value;

    // 一意なランダム ID を生成（衝突したら作り直す）
    let id = generateId();
    for (let i = 0; i < 5; i++) {
      const exists = [...this.sql.exec("SELECT id FROM users WHERE id = ?", id)];
      if (exists.length === 0) break;
      id = generateId();
    }

    const now = Date.now();
    this.sql.exec(
      "INSERT INTO users (id, name, color, avatar, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      color,
      avatar,
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
    const rows = [...this.sql.exec("SELECT id, name, color, avatar FROM users WHERE id = ?", id)];
    if (rows.length === 0) return json({ error: "not_found" }, 404);

    const body = await safeJson(request);
    const current = rows[0];
    const name = body.name !== undefined ? String(body.name).trim() : current.name;
    const color = body.color !== undefined ? normalizeColor(body.color) : current.color;

    if (!name) return json({ error: "name_required" }, 400);
    if (name.length > 30) return json({ error: "name_too_long" }, 400);

    // avatar は指定があれば更新（null で「頭文字に戻す」）。未指定なら現状維持。
    let avatar = current.avatar ?? null;
    if (body.avatar !== undefined) {
      const avatarCheck = normalizeAvatar(body.avatar);
      if (!avatarCheck.ok) return json({ error: avatarCheck.error }, 400);
      avatar = avatarCheck.value;
    }

    this.sql.exec("UPDATE users SET name = ?, color = ?, avatar = ? WHERE id = ?", name, color, avatar, id);
    return json({ id, name, color, avatar });
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
    }));

    return json({ friends });
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

// アイコン画像の上限（サムネイルの data URL 文字数）。約75KB相当。
// クライアント側で 128px の小さなサムネイルに変換して送る想定。
const AVATAR_MAX_LEN = 100_000;

/**
 * アイコン画像（サムネイルの data URL）を検証する。
 * 戻り値 { ok, value, error }:
 *   - 未設定（null/空）      → { ok:true, value:null }
 *   - data:image/ で始まる   → { ok:true, value:文字列 }（上限内のとき）
 *   - 上限超過               → { ok:false, error:"avatar_too_large" }
 *   - それ以外の不正な値     → { ok:false, error:"avatar_invalid" }
 */
function normalizeAvatar(v) {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "avatar_invalid" };
  if (!v.startsWith("data:image/")) return { ok: false, error: "avatar_invalid" };
  if (v.length > AVATAR_MAX_LEN) return { ok: false, error: "avatar_too_large" };
  return { ok: true, value: v };
}

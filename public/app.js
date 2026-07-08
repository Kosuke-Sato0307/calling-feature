// ============================================================================
// Callin - クライアントロジック
//   - 登録 / ログイン（名前＋ID）
//   - 友だち検索・追加・一覧
//   - WebSocket でオンライン状態とシグナリングを受信
//   - WebRTC で音声通話（発信・着信・ミュート・スピーカー・終了）
// ============================================================================

"use strict";

// ---------- 定数 ----------
const STORAGE_KEY = "callin_user";
const THEME_COLORS = [
  "#5b8cff", "#22c55e", "#a855f7", "#ec4899",
  "#f59e0b", "#ef4444", "#06b6d4", "#14b8a6",
  "#8b5cf6", "#f43f5e", "#eab308", "#64748b",
];
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ---------- アプリ状態 ----------
const state = {
  me: null,          // { id, name, color }
  ws: null,          // WebSocket
  wsReady: false,
  reconnectTimer: null,
  pingTimer: null,
  friends: [],       // 友だち一覧
  regColor: THEME_COLORS[0],
  setColor: THEME_COLORS[0],

  // 通話関連
  call: null,        // { peerId, peerName, role: 'caller'|'callee', state }
  pc: null,          // RTCPeerConnection
  localStream: null,
  pendingCandidates: [], // remoteDescription 前に届いた ICE を退避
  muted: false,
  speakerOn: false,
  timerInterval: null,
  callStartAt: 0,
};

// ---------- 要素取得ヘルパー ----------
const $ = (id) => document.getElementById(id);

// ============================================================================
// 起動処理
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
  buildColorGrids();
  bindEvents();

  const saved = loadUser();
  if (saved) {
    state.me = saved;
    enterApp();
  } else {
    showScreen("register");
  }
});

// ============================================================================
// テーマカラー
// ============================================================================
function applyTheme(color) {
  const c = color || THEME_COLORS[0];
  document.documentElement.style.setProperty("--theme", c);
  document.documentElement.style.setProperty("--theme-soft", hexToSoft(c, 0.16));
}
function hexToSoft(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildColorGrids() {
  buildGrid($("reg-colors"), (c) => {
    state.regColor = c;
    applyTheme(c);
  }, () => state.regColor);
  buildGrid($("set-colors"), (c) => {
    state.setColor = c;
    applyTheme(c);
  }, () => state.setColor);
}

function buildGrid(container, onPick, getCurrent) {
  container.innerHTML = "";
  THEME_COLORS.forEach((c) => {
    const sw = document.createElement("div");
    sw.className = "color-swatch";
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener("click", () => {
      onPick(c);
      [...container.children].forEach((el) =>
        el.classList.toggle("selected", el.dataset.color === c)
      );
    });
    container.appendChild(sw);
  });
  // 初期選択を反映
  const cur = getCurrent();
  [...container.children].forEach((el) =>
    el.classList.toggle("selected", el.dataset.color === cur)
  );
}

// ============================================================================
// 画面切替
// ============================================================================
function showScreen(name) {
  ["register", "login", "main"].forEach((s) => {
    $("screen-" + s).classList.toggle("active", s === name);
  });
}

function openModal(id) { $(id).classList.add("active"); }
function closeModal(id) { $(id).classList.remove("active"); }

// ============================================================================
// localStorage
// ============================================================================
function saveUser(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}
function loadUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearUser() {
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================================================
// API 呼び出し
// ============================================================================
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ============================================================================
// イベント登録
// ============================================================================
function bindEvents() {
  // --- 登録 ---
  $("reg-submit").addEventListener("click", handleRegister);
  $("reg-name").addEventListener("keydown", (e) => { if (e.key === "Enter") handleRegister(); });
  $("to-login").addEventListener("click", (e) => { e.preventDefault(); showScreen("login"); });
  $("to-register").addEventListener("click", (e) => { e.preventDefault(); showScreen("register"); });

  // --- ログイン ---
  $("login-submit").addEventListener("click", handleLogin);
  $("login-name").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });

  // --- メイン ---
  $("me-id").addEventListener("click", () => copyText(state.me.id, "IDをコピーしました"));
  $("search-btn").addEventListener("click", handleSearch);
  $("search-id").addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearch(); });
  $("refresh-friends").addEventListener("click", loadFriends);

  // --- 設定 ---
  $("open-settings").addEventListener("click", openSettings);
  $("settings-cancel").addEventListener("click", () => closeModal("settings-modal"));
  $("settings-save").addEventListener("click", handleSaveSettings);
  $("logout-btn").addEventListener("click", handleLogout);

  // --- 通話 ---
  $("cancel-call").addEventListener("click", cancelOutgoing);
  $("accept-call").addEventListener("click", acceptIncoming);
  $("reject-call").addEventListener("click", rejectIncoming);
  $("end-call").addEventListener("click", () => endCall(true));
  $("btn-mute").addEventListener("click", toggleMute);
  $("btn-speaker").addEventListener("click", toggleSpeaker);

  // --- 接続の復帰（iOS の前面復帰・ネットワーク切替で WS を取りこぼさない）---
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ensureWsAlive();
  });
  window.addEventListener("focus", ensureWsAlive);
  window.addEventListener("pageshow", ensureWsAlive);
  window.addEventListener("online", ensureWsAlive);
}

// ============================================================================
// 登録・ログイン・ログアウト
// ============================================================================
async function handleRegister() {
  const name = $("reg-name").value.trim();
  const err = $("reg-error");
  err.textContent = "";
  if (!name) { err.textContent = "表示名を入力してください"; return; }

  setBusy($("reg-submit"), true);
  const { ok, data } = await api("/api/register", {
    method: "POST",
    body: JSON.stringify({ name, color: state.regColor }),
  });
  setBusy($("reg-submit"), false);

  if (!ok) { err.textContent = "登録に失敗しました。時間をおいて再度お試しください。"; return; }

  state.me = { id: data.id, name: data.name, color: data.color };
  saveUser(state.me);
  enterApp();
  showToast(`ようこそ、${data.name} さん！ あなたのID: ${data.id}`);
}

async function handleLogin() {
  const id = $("login-id").value.trim().toUpperCase();
  const name = $("login-name").value.trim();
  const err = $("login-error");
  err.textContent = "";
  if (!id || !name) { err.textContent = "ID と表示名の両方を入力してください"; return; }

  setBusy($("login-submit"), true);
  const { ok, status, data } = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ id, name }),
  });
  setBusy($("login-submit"), false);

  if (!ok) {
    if (status === 404) err.textContent = "このIDのユーザーは見つかりませんでした";
    else if (status === 401) err.textContent = "表示名がIDと一致しません";
    else err.textContent = "ログインに失敗しました";
    return;
  }

  state.me = { id: data.id, name: data.name, color: data.color };
  saveUser(state.me);
  enterApp();
  showToast(`おかえりなさい、${data.name} さん！`);
}

function handleLogout() {
  if (!confirm("ログアウトしますか？ このIDと表示名で再度ログインできます。\nID: " + state.me.id)) return;
  teardownCall(false);
  closeWs();
  clearUser();
  state.me = null;
  state.friends = [];
  closeModal("settings-modal");
  $("reg-name").value = "";
  showScreen("register");
}

// ============================================================================
// メイン画面へ入る
// ============================================================================
function enterApp() {
  applyTheme(state.me.color);
  state.setColor = state.me.color;

  $("me-name").textContent = state.me.name;
  $("me-id").textContent = "ID: " + state.me.id;
  const av = $("me-avatar");
  av.textContent = initial(state.me.name);
  av.style.background = state.me.color;

  showScreen("main");
  connectWs();
  loadFriends();
}

// ============================================================================
// 友だち検索・追加・一覧
// ============================================================================
async function handleSearch() {
  const id = $("search-id").value.trim().toUpperCase();
  const box = $("search-result");
  box.innerHTML = "";
  if (!id) return;
  if (id === state.me.id) {
    box.innerHTML = `<p class="result-note">自分自身は追加できません。</p>`;
    return;
  }

  const { ok, data } = await api("/api/user/" + encodeURIComponent(id));
  if (!ok) {
    box.innerHTML = `<p class="result-note">ID「${escapeHtml(id)}」のユーザーは見つかりませんでした。</p>`;
    return;
  }

  const already = state.friends.some((f) => f.id === data.id);
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div class="avatar" style="background:${data.color}">${escapeHtml(initial(data.name))}</div>
    <div class="friend-body">
      <div class="friend-name">${escapeHtml(data.name)}</div>
      <div class="friend-id">ID: ${escapeHtml(data.id)}</div>
    </div>`;
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.textContent = already ? "追加済み" : "追加";
  btn.disabled = already;
  btn.addEventListener("click", () => addFriend(data.id, btn));
  card.appendChild(btn);
  box.appendChild(card);
}

async function addFriend(friendId, btn) {
  if (btn) setBusy(btn, true);
  const { ok, data } = await api("/api/friends", {
    method: "POST",
    body: JSON.stringify({ userId: state.me.id, friendId }),
  });
  if (btn) setBusy(btn, false);

  if (!ok) {
    showToast("追加に失敗しました: " + (data.error || ""));
    return;
  }
  if (btn) { btn.textContent = "追加済み"; btn.disabled = true; }
  showToast(`${data.friend ? data.friend.name : "友だち"} を追加しました`);
  loadFriends();
}

async function loadFriends() {
  const { ok, data } = await api("/api/friends?userId=" + encodeURIComponent(state.me.id));
  if (!ok) return;
  state.friends = data.friends || [];
  renderFriends();
}

function renderFriends() {
  const list = $("friends-list");
  const empty = $("friends-empty");
  list.innerHTML = "";

  if (state.friends.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  state.friends.forEach((f) => {
    const li = document.createElement("li");
    li.className = "friend-item";
    li.innerHTML = `
      <div class="friend-avatar-wrap">
        <div class="avatar" style="background:${f.color}">${escapeHtml(initial(f.name))}</div>
        <span class="presence-dot ${f.online ? "online" : ""}"></span>
      </div>
      <div class="friend-body">
        <div class="friend-name">${escapeHtml(f.name)}</div>
        <div class="friend-id" data-copy="${escapeHtml(f.id)}">ID: ${escapeHtml(f.id)} 📋</div>
        <div class="friend-status ${f.online ? "online" : "offline"}">
          ${f.online ? "● オンライン" : "○ オフライン"}
        </div>
      </div>`;

    // ID コピー
    li.querySelector(".friend-id").addEventListener("click", () =>
      copyText(f.id, "IDをコピーしました")
    );

    // 通話ボタン
    const callBtn = document.createElement("button");
    callBtn.className = "call-icon-btn";
    callBtn.innerHTML = "📞";
    callBtn.title = f.online ? "通話する" : "オフラインのため通話できません";
    callBtn.disabled = !f.online;
    callBtn.addEventListener("click", () => startCall(f));
    li.appendChild(callBtn);

    list.appendChild(li);
  });
}

// ============================================================================
// 設定
// ============================================================================
function openSettings() {
  $("set-name").value = state.me.name;
  state.setColor = state.me.color;
  $("set-error").textContent = "";
  // カラーグリッドの選択状態を更新
  [...$("set-colors").children].forEach((el) =>
    el.classList.toggle("selected", el.dataset.color === state.me.color)
  );
  openModal("settings-modal");
}

async function handleSaveSettings() {
  const name = $("set-name").value.trim();
  const err = $("set-error");
  err.textContent = "";
  if (!name) { err.textContent = "表示名を入力してください"; return; }

  setBusy($("settings-save"), true);
  const { ok, data } = await api("/api/user/" + encodeURIComponent(state.me.id), {
    method: "PATCH",
    body: JSON.stringify({ name, color: state.setColor }),
  });
  setBusy($("settings-save"), false);

  if (!ok) { err.textContent = "保存に失敗しました"; return; }

  state.me = { ...state.me, name: data.name, color: data.color };
  saveUser(state.me);
  applyTheme(state.me.color);
  $("me-name").textContent = state.me.name;
  const av = $("me-avatar");
  av.textContent = initial(state.me.name);
  av.style.background = state.me.color;
  closeModal("settings-modal");
  showToast("設定を保存しました");
}

// ============================================================================
// WebSocket（シグナリング・presence）
// ============================================================================
function connectWs() {
  closeWs();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?userId=${encodeURIComponent(state.me.id)}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.wsReady = true;
    // 定期 ping で接続維持
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => wsSend({ type: "ping" }), 25000);
    // 再接続直後は presence がずれている可能性があるので友だち一覧を取り直す
    if (state.me) loadFriends();
  });

  ws.addEventListener("message", (e) => handleSignal(JSON.parse(e.data)));

  ws.addEventListener("close", () => {
    state.wsReady = false;
    clearInterval(state.pingTimer);
    // ログイン中なら再接続を試みる
    if (state.me) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWs, 2500);
    }
  });

  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}

// WS が切れていれば即座に張り直す（iOS の前面復帰・ネットワーク切替対策）。
// iOS Safari はタブが非アクティブ／画面ロックになると WebSocket を切断するため、
// 復帰イベントで再接続しないと着信（call-invite）を取りこぼしてしまう。
function ensureWsAlive() {
  if (!state.me) return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    connectWs();
  }
}

function closeWs() {
  clearTimeout(state.reconnectTimer);
  clearInterval(state.pingTimer);
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
    state.ws = null;
  }
  state.wsReady = false;
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ============================================================================
// シグナリング受信ハンドラ
// ============================================================================
async function handleSignal(msg) {
  switch (msg.type) {
    case "pong":
      break;

    case "presence":
      updatePresence(msg.userId, msg.online);
      break;

    case "friend-added":
      // 相手が自分を友だち追加した → 一覧を更新
      loadFriends();
      break;

    case "call-invite":
      onIncomingCall(msg);
      break;

    case "call-accept":
      onCallAccepted(msg);
      break;

    case "call-reject":
      onCallRejected(msg);
      break;

    case "call-cancel":
      onCallCanceled(msg);
      break;

    case "call-end":
      onRemoteEnd(msg);
      break;

    case "call-unavailable":
      showToast("相手がオフラインのため通話できませんでした");
      teardownCall(false);
      break;

    case "offer":
      await onOffer(msg);
      break;

    case "answer":
      await onAnswer(msg);
      break;

    case "ice":
      await onIce(msg);
      break;
  }
}

function updatePresence(userId, online) {
  const f = state.friends.find((x) => x.id === userId);
  if (f) {
    f.online = online;
    renderFriends();
  }
}

// ============================================================================
// 通話 - 発信側
// ============================================================================
async function startCall(friend) {
  if (state.call) { showToast("すでに通話中です"); return; }
  if (!friend.online) { showToast("相手がオフラインです"); return; }

  // iOS で相手の音声を鳴らせるよう、タップの瞬間に再生を解錠しておく
  primeRemoteAudio();

  // 先にマイクを取得（許可が下りてから発信）
  const gotMic = await ensureLocalStream();
  if (!gotMic) return;

  state.call = { peerId: friend.id, peerName: friend.name, peerColor: friend.color, role: "caller", state: "calling" };

  // 発信中モーダル表示
  $("calling-name").textContent = friend.name;
  setAvatar($("calling-avatar"), friend.name, friend.color);
  openModal("calling-modal");

  wsSend({ type: "call-invite", to: friend.id, fromName: state.me.name });
}

function cancelOutgoing() {
  if (state.call && state.call.role === "caller") {
    wsSend({ type: "call-cancel", to: state.call.peerId });
  }
  teardownCall(false);
}

function onCallAccepted(msg) {
  if (!state.call || state.call.peerId !== msg.from) return;
  // 相手が応答 → こちらから offer を作って送る
  state.call.state = "connecting";
  closeModal("calling-modal");
  startInCallUI();
  createAndSendOffer();
}

function onCallRejected(msg) {
  if (!state.call || state.call.peerId !== msg.from) return;
  showToast(`${state.call.peerName} さんが応答できません`);
  teardownCall(false);
}

// ============================================================================
// 通話 - 着信側
// ============================================================================
function onIncomingCall(msg) {
  // すでに通話中なら自動で拒否（話中）
  if (state.call) {
    wsSend({ type: "call-reject", to: msg.from });
    return;
  }

  const name = msg.fromName || "不明なユーザー";
  const friend = state.friends.find((f) => f.id === msg.from);
  const color = friend ? friend.color : "#5b8cff";

  state.call = { peerId: msg.from, peerName: name, peerColor: color, role: "callee", state: "ringing" };

  $("incoming-name").textContent = name;
  setAvatar($("incoming-avatar"), name, color);
  openModal("incoming-modal");
}

async function acceptIncoming() {
  if (!state.call || state.call.role !== "callee") return;

  // iOS で相手の音声を鳴らせるよう、タップの瞬間に再生を解錠しておく
  primeRemoteAudio();

  const gotMic = await ensureLocalStream();
  if (!gotMic) {
    wsSend({ type: "call-reject", to: state.call.peerId });
    teardownCall(false);
    return;
  }

  state.call.state = "connecting";
  closeModal("incoming-modal");
  // PeerConnection を用意して待ち受け（offer は発信側から届く）
  setupPeerConnection();
  startInCallUI();
  wsSend({ type: "call-accept", to: state.call.peerId });
}

function rejectIncoming() {
  if (state.call && state.call.role === "callee") {
    wsSend({ type: "call-reject", to: state.call.peerId });
  }
  teardownCall(false);
}

function onCallCanceled(msg) {
  if (state.call && state.call.peerId === msg.from) {
    showToast(`${state.call.peerName} さんが発信をキャンセルしました`);
    teardownCall(false);
  }
}

// ============================================================================
// WebRTC 本体
// ============================================================================
// iOS Safari 対策: 相手の音声を鳴らせるよう、ユーザー操作の瞬間に
// remoteAudio の再生を「解錠」しておく。ここで一度 play() しておくと、
// 後から ontrack で srcObject を差し替えても再生が継続できる。
function primeRemoteAudio() {
  const audio = $("remoteAudio");
  try {
    audio.muted = false;
    audio.play().catch(() => {});
  } catch {}
}

async function ensureLocalStream() {
  if (state.localStream) return true;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return true;
  } catch (err) {
    showToast("マイクを使用できません。ブラウザの許可設定を確認してください。");
    return false;
  }
}

function setupPeerConnection() {
  if (state.pc) return state.pc;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;
  state.pendingCandidates = [];

  // ローカル音声トラックを追加
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  }

  // 相手の音声を受信 → audio 要素へ
  pc.addEventListener("track", (e) => {
    const audio = $("remoteAudio");
    audio.srcObject = e.streams[0];
    // iOS Safari は srcObject をセットしただけでは再生されないため明示的に play()。
    // 発信/応答ボタン（ユーザー操作）で primeRemoteAudio() 済みなのでここで再生が通る。
    audio.play().catch(() => {});
  });

  // ICE candidate を相手へ送る
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && state.call) {
      wsSend({ type: "ice", to: state.call.peerId, candidate: e.candidate });
    }
  });

  // 接続状態の監視
  pc.addEventListener("connectionstatechange", () => {
    if (!state.call) return;
    const st = pc.connectionState;
    if (st === "connected") {
      onCallConnected();
    } else if (st === "failed") {
      // 接続確立に失敗（別ネットワーク間で STUN のみだと起きやすい）。
      // 通話中でも接続前でも、状態を確実に片付けて相手にも終了を伝える。
      // ここで片付けないと state.call が残り、以後の着信が「話中」扱いで
      // 自動拒否され、ポップアップが出なくなる。
      showToast(
        state.call.state === "in-call"
          ? "通話が切断されました"
          : "相手とうまく接続できませんでした（ネットワーク環境が原因の場合があります）"
      );
      endCall(true);
    } else if (st === "closed") {
      if (state.call.state === "in-call") {
        showToast("通話が切断されました");
      }
      teardownCall(false);
    }
    // "disconnected" は一時的な揺らぎのことが多いので、ここでは即切断しない
    // （回復すれば "connected"、駄目なら "failed" に遷移する）
  });

  return pc;
}

async function createAndSendOffer() {
  const pc = setupPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "offer", to: state.call.peerId, sdp: offer });
}

async function onOffer(msg) {
  if (!state.call || state.call.peerId !== msg.from) return;
  const pc = setupPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: "answer", to: state.call.peerId, sdp: answer });
}

async function onAnswer(msg) {
  if (!state.pc || !state.call || state.call.peerId !== msg.from) return;
  await state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushCandidates();
}

async function onIce(msg) {
  if (!state.pc || !msg.candidate) return;
  // remoteDescription がまだなら退避
  if (!state.pc.remoteDescription || !state.pc.remoteDescription.type) {
    state.pendingCandidates.push(msg.candidate);
    return;
  }
  try {
    await state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch {}
}

async function flushCandidates() {
  const list = state.pendingCandidates;
  state.pendingCandidates = [];
  for (const c of list) {
    try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }
}

// ============================================================================
// 通話中 UI・状態
// ============================================================================
function startInCallUI() {
  $("incall-name").textContent = state.call.peerName;
  setAvatar($("incall-avatar"), state.call.peerName, state.call.peerColor);
  $("incall-status").textContent = "接続中…";
  $("incall-timer").textContent = "00:00";
  state.muted = false;
  state.speakerOn = false;
  $("btn-mute").classList.remove("active");
  $("btn-mute").querySelector(".ctrl-icon").textContent = "🎤";
  $("btn-mute").querySelector(".ctrl-label").textContent = "ミュート";
  $("btn-speaker").classList.remove("active");
  openModal("incall-modal");
}

function onCallConnected() {
  if (!state.call || state.call.state === "in-call") return;
  state.call.state = "in-call";
  $("incall-status").textContent = "通話中";
  state.callStartAt = Date.now();
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  const sec = Math.floor((Date.now() - state.callStartAt) / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  $("incall-timer").textContent = `${m}:${s}`;
}

function toggleMute() {
  if (!state.localStream) return;
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  const btn = $("btn-mute");
  btn.classList.toggle("active", state.muted);
  btn.querySelector(".ctrl-icon").textContent = state.muted ? "🔇" : "🎤";
  btn.querySelector(".ctrl-label").textContent = state.muted ? "ミュート中" : "ミュート";
}

function toggleSpeaker() {
  const audio = $("remoteAudio");
  state.speakerOn = !state.speakerOn;
  const btn = $("btn-speaker");
  btn.classList.toggle("active", state.speakerOn);

  // setSinkId 対応端末ではスピーカー切替、非対応でも音量で代替
  if (typeof audio.setSinkId === "function") {
    // 既定デバイスのまま。ラベルのみ変化（環境によりデバイス選択は限定的）
  }
  audio.volume = state.speakerOn ? 1.0 : 0.85;
  showToast(state.speakerOn ? "スピーカー: ON" : "スピーカー: OFF");
}

// ============================================================================
// 通話終了処理
// ============================================================================
function endCall(notify) {
  if (state.call && notify) {
    wsSend({ type: "call-end", to: state.call.peerId });
  }
  teardownCall(true);
}

function onRemoteEnd(msg) {
  if (state.call && state.call.peerId === msg.from) {
    showToast("通話が終了しました");
    teardownCall(false);
  }
}

// 通話状態を全て片付ける（closeMic: マイクも停止するか）
function teardownCall(closeMic) {
  clearInterval(state.timerInterval);
  state.timerInterval = null;

  closeModal("calling-modal");
  closeModal("incoming-modal");
  closeModal("incall-modal");

  if (state.pc) {
    try { state.pc.ontrack = null; state.pc.onicecandidate = null; state.pc.close(); } catch {}
    state.pc = null;
  }
  const audio = $("remoteAudio");
  if (audio.srcObject) audio.srcObject = null;

  // マイクは通話終了時に停止（次回発信時に取り直す）
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  state.pendingCandidates = [];
  state.muted = false;
  state.speakerOn = false;
  state.call = null;
}

// ============================================================================
// 汎用ユーティリティ
// ============================================================================
function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function setAvatar(el, name, color) {
  el.textContent = initial(name);
  el.style.background = color || "#5b8cff";
}
function setBusy(btn, busy) {
  btn.disabled = busy;
  btn.style.opacity = busy ? "0.6" : "";
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg || "コピーしました");
  } catch {
    showToast("コピーできませんでした: " + text);
  }
}
let toastTimer = null;
function showToast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

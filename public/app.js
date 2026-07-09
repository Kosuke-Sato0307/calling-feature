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
const AUDIO_KEY = "callin_audio"; // 音量・マイク・スピーカーの設定を保存
// 音量スライダーの上限（実音量）。約10%がちょうどよいため、0〜20%の範囲で
// 中央（10%）を初期値にする。スライダーの value は「実音量パーセント(0〜20)」。
const VOL_MAX = 0.2;
const VOL_DEFAULT = 0.1;
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

// iOS(iPhone/iPad) 判定。受話口⇔スピーカーの切替は iOS だけの対応。
// （Windows / Android / PC には「受話口（耳）」の概念が無い）
const IS_IOS =
  /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ---------- アプリ状態 ----------
const state = {
  me: null,          // { id, name, color, avatar }
  ws: null,          // WebSocket
  wsReady: false,
  reconnectTimer: null,
  pingTimer: null,
  friends: [],       // 友だち一覧
  regColor: THEME_COLORS[0],
  setColor: THEME_COLORS[0],
  setAvatar: null,   // 設定モーダルで選択中のアイコン画像（data URL / null）

  // 通話関連
  call: null,        // { peerId, peerName, role: 'caller'|'callee', state }
  pc: null,          // RTCPeerConnection
  localStream: null,
  pendingCandidates: [], // remoteDescription 前に届いた ICE を退避
  muted: false,
  speakerOn: false,
  timerInterval: null,
  callStartAt: 0,

  // 音声デバイス・音量の設定
  volume: VOL_DEFAULT,  // 通話音量（0〜VOL_MAX）。初期値は中央の10%
  micDeviceId: "",      // 使用するマイクの deviceId（空 = 既定）
  speakerDeviceId: "",  // 使用するスピーカーの deviceId（空 = 既定）

  // iOS の音量調整用 Web Audio ノード（受信音声を gain 経由で鳴らす）
  remoteStream: null,
  remoteSource: null,
  remoteGain: null,
  remoteDest: null,
};

// ---------- 発信音・着信音（Web Audio で生成。音源ファイル不要・無料）----------
// リモート音声は iOS の WebAudio 経由だと無音になる既知バグがあるため <audio> 要素で
// 鳴らすが、こちらの「呼び出し音／着信音」は自前生成のオシレーターなので iOS でも鳴る。
const tone = {
  ctx: null,     // AudioContext（遅延生成）
  timer: null,   // 鳴動パターンの繰り返しタイマー
  oscs: [],      // 生成中のオシレーター（停止用）
};

// ---------- 要素取得ヘルパー ----------
const $ = (id) => document.getElementById(id);

// ============================================================================
// 起動処理
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
  buildColorGrids();
  loadAudioPrefs();
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

// 友だちのアイコン画像を拡大表示する（<img> を使わず背景画像で表示し、保存操作を抑止）
function openAvatarPreview(avatar) {
  $("avatar-preview-stage").style.backgroundImage = `url("${avatar}")`;
  openModal("avatar-preview-modal");
}

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

// 音量・使用デバイスの設定を保存／復元（端末ごとに localStorage へ）
function loadAudioPrefs() {
  try {
    const raw = localStorage.getItem(AUDIO_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    // 旧仕様（0〜1）で保存された値も新レンジ（0〜VOL_MAX）にクランプして復元する
    if (typeof p.volume === "number" && p.volume >= 0) state.volume = Math.min(VOL_MAX, p.volume);
    if (typeof p.micId === "string") state.micDeviceId = p.micId;
    if (typeof p.speakerId === "string") state.speakerDeviceId = p.speakerId;
  } catch {}
}
function saveAudioPrefs() {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify({
      volume: state.volume,
      micId: state.micDeviceId,
      speakerId: state.speakerDeviceId,
    }));
  } catch {}
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

  // --- アイコン拡大表示 ---
  const previewModal = $("avatar-preview-modal");
  previewModal.addEventListener("click", () => closeModal("avatar-preview-modal"));
  $("avatar-preview-close").addEventListener("click", () => closeModal("avatar-preview-modal"));
  // 右クリック保存・ドラッグによる画像取得を抑止（ステージは pointer-events:none のため
  // オーバーレイ全体で受ける）
  previewModal.addEventListener("contextmenu", (e) => e.preventDefault());
  previewModal.addEventListener("dragstart", (e) => e.preventDefault());

  // --- アイコン画像（設定モーダル） ---
  $("set-avatar-input").addEventListener("change", handleAvatarFile);
  $("set-avatar-clear").addEventListener("click", () => {
    state.setAvatar = null;
    $("set-avatar-input").value = "";
    updateSettingsAvatarPreview();
  });

  // --- 通話 ---
  $("cancel-call").addEventListener("click", cancelOutgoing);
  $("accept-call").addEventListener("click", acceptIncoming);
  $("reject-call").addEventListener("click", rejectIncoming);
  $("end-call").addEventListener("click", () => endCall(true));
  $("btn-mute").addEventListener("click", toggleMute);
  $("btn-speaker").addEventListener("click", toggleSpeaker);

  // --- 音量スライダー ---
  $("vol-slider").addEventListener("input", (e) => {
    setVolume(Number(e.target.value) / 100);
  });

  // --- 音声デバイス選択（マイク・スピーカー） ---
  $("mic-select").addEventListener("change", (e) => applyMicSelection(e.target.value));
  $("speaker-select").addEventListener("change", (e) => applySpeakerSelection(e.target.value));

  // --- 接続の復帰（iOS の前面復帰・ネットワーク切替で WS を取りこぼさない）---
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ensureWsAlive();
  });
  window.addEventListener("focus", ensureWsAlive);
  window.addEventListener("pageshow", ensureWsAlive);
  window.addEventListener("online", ensureWsAlive);

  // 最初のユーザー操作で AudioContext を解錠しておく。
  // これにより、あとで（ユーザー操作を伴わない）着信が来ても着信音を鳴らせる。
  window.addEventListener("pointerdown", () => ensureAudioCtx(), { once: true });
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

  state.me = { id: data.id, name: data.name, color: data.color, avatar: data.avatar ?? null };
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

  state.me = { id: data.id, name: data.name, color: data.color, avatar: data.avatar ?? null };
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
  setAvatar($("me-avatar"), state.me.name, state.me.color, state.me.avatar);

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
    ${avatarMarkup(data.name, data.color, data.avatar)}
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
        ${avatarMarkup(f.name, f.color, f.avatar)}
        <span class="presence-dot ${f.online ? "online" : ""}"></span>
      </div>
      <div class="friend-body">
        <div class="friend-name">${escapeHtml(f.name)}</div>
        <div class="friend-id" data-copy="${escapeHtml(f.id)}">ID: ${escapeHtml(f.id)} 📋</div>
        <div class="friend-status ${f.online ? "online" : "offline"}">
          ${f.online ? "● オンライン" : "○ オフライン"}
        </div>
      </div>`;

    // アイコン画像がある場合はタップで拡大表示
    if (f.avatar) {
      const av = li.querySelector(".friend-avatar-wrap .avatar");
      av.classList.add("clickable");
      av.addEventListener("click", () => openAvatarPreview(f.avatar));
    }

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
  state.setAvatar = state.me.avatar ?? null;
  $("set-error").textContent = "";
  $("set-avatar-input").value = ""; // 同じファイルを選び直せるようにクリア
  updateSettingsAvatarPreview();
  // カラーグリッドの選択状態を更新
  [...$("set-colors").children].forEach((el) =>
    el.classList.toggle("selected", el.dataset.color === state.me.color)
  );
  openModal("settings-modal");
  populateAudioDevices(); // マイク・スピーカーの一覧を取得して反映
}

// 設定モーダルのアイコンプレビューを、選択中の値（state.setAvatar/setColor）で更新する
function updateSettingsAvatarPreview() {
  setAvatar($("set-avatar-preview"), state.me ? state.me.name : "", state.setColor, state.setAvatar);
}

// ファイル選択時: 小さな正方形サムネイルに変換して保留アイコンにする
async function handleAvatarFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $("set-error").textContent = "";
  try {
    state.setAvatar = await fileToAvatarDataUrl(file);
    updateSettingsAvatarPreview();
  } catch {
    $("set-error").textContent = "画像を読み込めませんでした";
  }
}

// アップロード画像を 128px の正方形サムネイル（JPEG data URL）に変換する。
// 元の画像データは保存せず、この小さな「アイコン情報」だけを保存に使う。
function fileToAvatarDataUrl(file) {
  const SIZE = 128;
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith("image/")) {
      reject(new Error("not_image"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_error"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode_error"));
      img.onload = () => {
        // 中央を正方形にクロップして 128x128 に描画
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// 音声デバイス（マイク・スピーカー）の選択
// ============================================================================
// 端末のマイク／スピーカー一覧を取得してセレクトに反映する。
// デバイス名（ラベル）はマイク許可後でないと空になるため、必要なら一度だけ許可を求める。
async function populateAudioDevices() {
  const micSel = $("mic-select");
  const spkSel = $("speaker-select");
  const spkGroup = $("speaker-group");
  const hint = $("device-hint");

  // スピーカー出力の切替（setSinkId）に非対応なブラウザ（iOS Safari 等）では出力選択を隠す
  const supportsSink = typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function";
  spkGroup.style.display = supportsSink ? "" : "none";

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    micSel.innerHTML = '<option value="">この端末では選択できません</option>';
    return;
  }

  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    const hasLabel = devices.some(
      (d) => (d.kind === "audioinput" || d.kind === "audiooutput") && d.label
    );

    // ラベルが空 = マイク未許可。通話中でなければ一度だけ許可を求めて機種名を出す。
    if (!hasLabel && !state.localStream) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        tmp.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        hint.textContent = "マイクを許可すると、デバイス名が表示され選べるようになります。";
      }
    }

    fillDeviceSelect(micSel, devices, "audioinput", state.micDeviceId, "マイク");
    if (supportsSink) {
      fillDeviceSelect(spkSel, devices, "audiooutput", state.speakerDeviceId, "スピーカー");
    }
  } catch {
    micSel.innerHTML = '<option value="">一覧を取得できませんでした</option>';
  }
}

function fillDeviceSelect(sel, devices, kind, selectedId, labelJa) {
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自動（既定のデバイス）";
  sel.appendChild(auto);

  let idx = 0;
  let matched = false;
  devices
    .filter((d) => d.kind === kind)
    .forEach((d) => {
      idx++;
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `${labelJa} ${idx}`;
      if (d.deviceId && d.deviceId === selectedId) {
        o.selected = true;
        matched = true;
      }
      sel.appendChild(o);
    });
  // 保存済みデバイスが見つからなければ「自動」に戻す
  if (!matched) sel.value = "";
}

// マイクを変更。通話中なら replaceTrack で即座に差し替える。
async function applyMicSelection(deviceId) {
  state.micDeviceId = deviceId || "";
  saveAudioPrefs();

  // 通話中なら送信中のマイクを差し替える
  if (state.pc && state.localStream) {
    try {
      const newStream = await getMicStream();
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) throw new Error("no track");
      newTrack.enabled = !state.muted; // ミュート状態を引き継ぐ
      const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (sender) await sender.replaceTrack(newTrack);
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = newStream;
      showToast("マイクを切り替えました");
    } catch {
      showToast("マイクの切り替えに失敗しました");
    }
  } else {
    showToast(deviceId ? "マイクを設定しました（次の通話から有効）" : "マイクを既定に戻しました");
  }
}

// スピーカー（出力先）を変更。setSinkId で即反映する。
async function applySpeakerSelection(deviceId) {
  state.speakerDeviceId = deviceId || "";
  saveAudioPrefs();
  await applySinkId();
  showToast(deviceId ? "スピーカーを設定しました" : "スピーカーを既定に戻しました");
}

async function handleSaveSettings() {
  const name = $("set-name").value.trim();
  const err = $("set-error");
  err.textContent = "";
  if (!name) { err.textContent = "表示名を入力してください"; return; }

  setBusy($("settings-save"), true);
  const { ok, data } = await api("/api/user/" + encodeURIComponent(state.me.id), {
    method: "PATCH",
    body: JSON.stringify({ name, color: state.setColor, avatar: state.setAvatar ?? null }),
  });
  setBusy($("settings-save"), false);

  if (!ok) {
    err.textContent = data && data.error === "avatar_too_large"
      ? "画像が大きすぎます。別の画像をお試しください"
      : "保存に失敗しました";
    return;
  }

  state.me = { ...state.me, name: data.name, color: data.color, avatar: data.avatar ?? null };
  saveUser(state.me);
  applyTheme(state.me.color);
  $("me-name").textContent = state.me.name;
  setAvatar($("me-avatar"), state.me.name, state.me.color, state.me.avatar);
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
  // タップの瞬間に AudioContext を解錠（発信音を鳴らすため）
  ensureAudioCtx();

  // 先にマイクを取得（許可が下りてから発信）
  const gotMic = await ensureLocalStream();
  if (!gotMic) return;

  state.call = { peerId: friend.id, peerName: friend.name, peerColor: friend.color, peerAvatar: friend.avatar ?? null, role: "caller", state: "calling" };

  // 発信中モーダル表示
  $("calling-name").textContent = friend.name;
  setAvatar($("calling-avatar"), friend.name, friend.color, friend.avatar);
  openModal("calling-modal");
  startRingback(); // 発信中の呼び出し音

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
  stopTone(); // 発信音を止める
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
  const avatar = friend ? friend.avatar : null;

  state.call = { peerId: msg.from, peerName: name, peerColor: color, peerAvatar: avatar ?? null, role: "callee", state: "ringing" };

  $("incoming-name").textContent = name;
  setAvatar($("incoming-avatar"), name, color, avatar);
  openModal("incoming-modal");
  startRingtone(); // 着信音
}

async function acceptIncoming() {
  if (!state.call || state.call.role !== "callee") return;

  stopTone(); // 着信音を止める
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

// 受信した相手の音声を <audio> に接続する。
// - iOS Safari は audio.volume を変更できない（常に最大）ため、Web Audio の
//   GainNode を挟んで音量を可変にする（source → gain → MediaStreamDestination → <audio>）。
//   <audio> 要素を最終出力に使うことで iOS でも確実に音が鳴る（受話口/スピーカー切替も維持）。
// - iOS 以外は audio.volume がそのまま効くので、素のストリームを直接貼る（従来どおり）。
function attachRemoteStream(stream) {
  const audio = $("remoteAudio");
  state.remoteStream = stream;

  let routed = false;
  if (IS_IOS) routed = setupRemoteGain(stream);

  if (routed) {
    audio.srcObject = state.remoteDest.stream;
  } else {
    audio.srcObject = stream;
    try { audio.volume = state.volume; } catch {}
  }
  applySinkId();
  // iOS Safari は srcObject をセットしただけでは再生されないため明示的に play()。
  // 発信/応答ボタン（ユーザー操作）で primeRemoteAudio() 済みなのでここで再生が通る。
  audio.play().catch(() => {});
}

// iOS 用: 受信ストリームを gain 経由の出力ストリームに変換する。成功したら true。
function setupRemoteGain(stream) {
  try {
    const ctx = ensureAudioCtx();
    if (!ctx) return false;
    teardownRemoteGain();
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = state.volume;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(dest);
    state.remoteSource = src;
    state.remoteGain = gain;
    state.remoteDest = dest;
    return true;
  } catch {
    teardownRemoteGain();
    return false;
  }
}

function teardownRemoteGain() {
  try { if (state.remoteSource) state.remoteSource.disconnect(); } catch {}
  try { if (state.remoteGain) state.remoteGain.disconnect(); } catch {}
  state.remoteSource = null;
  state.remoteGain = null;
  state.remoteDest = null;
}

// 音量を適用（0〜1）。iOS は gain、その他は audio.volume。設定は保存する。
function setVolume(v) {
  state.volume = Math.max(0, Math.min(VOL_MAX, v));
  saveAudioPrefs();
  if (state.remoteGain) {
    state.remoteGain.gain.value = state.volume;
  } else {
    try { $("remoteAudio").volume = state.volume; } catch {}
  }
  updateVolumeUI();
}

// スライダー位置・パーセント表示・アイコンを現在の音量に合わせる
function updateVolumeUI() {
  const pct = Math.round(state.volume * 100); // 実音量パーセント（0〜20）
  const slider = $("vol-slider");
  slider.value = String(pct);
  // スライダーの塗りはトラックに対する割合。max は 20 なので 100 換算に直す。
  const fill = Math.round((pct / (VOL_MAX * 100)) * 100);
  slider.style.setProperty("--vol", fill + "%");
  $("vol-icon").textContent = pct === 0 ? "🔇" : pct <= 10 ? "🔉" : "🔊";
}

// 出力先スピーカーを適用（setSinkId 対応ブラウザのみ。iOS 等は非対応で無視）。
async function applySinkId() {
  const audio = $("remoteAudio");
  if (typeof audio.setSinkId !== "function") return;
  try {
    await audio.setSinkId(state.speakerDeviceId || "");
  } catch {}
}

// ============================================================================
// 発信音・着信音
// ============================================================================
// AudioContext を用意（初回のユーザー操作で解錠しておくと、着信時にも鳴らせる）。
function ensureAudioCtx() {
  try {
    if (!tone.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      tone.ctx = new AC();
    }
    if (tone.ctx.state === "suspended") tone.ctx.resume().catch(() => {});
    return tone.ctx;
  } catch {
    return null;
  }
}

// 単発のビープ音（複数周波数を重ねられる。前後に緩やかな増減を付けてプツ音を防ぐ）
function beep(freqs, duration, level, delay = 0) {
  const ctx = tone.ctx;
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(level, t0 + 0.03);
  gain.gain.setValueAtTime(level, t0 + Math.max(0.05, duration - 0.06));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  freqs.forEach((f) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
    tone.oscs.push(osc);
  });
}

// 発信側の呼び出し音（プルルル…と 1秒鳴って 2秒休む、電話らしい繰り返し）
function startRingback() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  stopTone();
  const cycle = () => beep([440], 1.0, 0.12);
  cycle();
  tone.timer = setInterval(cycle, 3000);
}

// 着信側の着信音（2音を重ねた「リンリン」を短く2回鳴らして休む）
function startRingtone() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  stopTone();
  const cycle = () => {
    beep([880, 660], 0.4, 0.14, 0.0);
    beep([880, 660], 0.4, 0.14, 0.55);
  };
  cycle();
  tone.timer = setInterval(cycle, 1800);
}

// 鳴動を止める（発信音・着信音の共通停止）
function stopTone() {
  if (tone.timer) {
    clearInterval(tone.timer);
    tone.timer = null;
  }
  tone.oscs.forEach((o) => {
    try { o.stop(); } catch {}
    try { o.disconnect(); } catch {}
  });
  tone.oscs = [];
}

// マイク取得時の制約。選択されたデバイスを使い、エコー除去・雑音抑制を有効化する。
// （ハウリング対策として echoCancellation を明示的に ON にしている）
function micConstraints() {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (state.micDeviceId) audio.deviceId = { exact: state.micDeviceId };
  return { audio, video: false };
}

// 指定デバイスでマイクを取得。exact 指定が失敗したら既定デバイスにフォールバック。
async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (err) {
    if (state.micDeviceId) {
      // 選択したデバイスが使えない（抜かれた等）→ 既定で取り直す
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }
    throw err;
  }
}

async function ensureLocalStream() {
  if (state.localStream) return true;
  try {
    state.localStream = await getMicStream();
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

  // 相手の音声を受信 → audio 要素へ（音量調整のため必要なら Web Audio 経由）
  pc.addEventListener("track", (e) => {
    attachRemoteStream(e.streams[0]);
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
  setAvatar($("incall-avatar"), state.call.peerName, state.call.peerColor, state.call.peerAvatar);
  $("incall-status").textContent = "接続中…";
  $("incall-timer").textContent = "00:00";
  state.muted = false;
  state.speakerOn = false;
  $("btn-mute").classList.remove("active");
  $("btn-mute").querySelector(".ctrl-icon").textContent = "🎤";
  $("btn-mute").querySelector(".ctrl-label").textContent = "ミュート";
  $("btn-speaker").classList.remove("active");
  $("btn-speaker").querySelector(".ctrl-icon").textContent = "🔈";
  updateVolumeUI(); // 音量スライダーを現在値に合わせる
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
  // 通話確立時に既定の出力先（iOS では受話口）を適用する
  applyAudioRoute();
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
  state.speakerOn = !state.speakerOn;
  const btn = $("btn-speaker");
  btn.classList.toggle("active", state.speakerOn);
  btn.querySelector(".ctrl-icon").textContent = state.speakerOn ? "🔊" : "🔈";
  applyAudioRoute();
  showToast(state.speakerOn ? "スピーカー: ON" : "スピーカー: OFF（受話口）");
}

// 相手の音声の出力先（受話口 or スピーカー）を、現在の speakerOn に合わせて適用する。
// - 既定（speakerOn=false）は「受話口（耳）」。スピーカーボタンONで「スピーカー」。
// - iOS Safari には出力先を選ぶ Web API（setSinkId 等）が無いため、既知の挙動を利用して切り替える。
// - Windows / Android / PC は受話口の概念が無いので何もしない（常にそのまま）。
function applyAudioRoute() {
  const audio = $("remoteAudio");
  audio.muted = false;
  // 音量は gain（iOS）または audio.volume（その他）で管理する。
  if (!state.remoteGain) {
    try { audio.volume = state.volume; } catch {}
  }

  if (!IS_IOS) return;                       // iOS 以外は既定のまま（変更不要）
  if (!state.pc || !audio.srcObject) return; // まだ通話音声が無い

  if (state.speakerOn) {
    forceSpeakerRoute();
  } else {
    forceEarpieceRoute(audio);
  }
}

// iOS Safari: マイクトラックを一瞬 off→on するとルートがスピーカーへ切り替わる（既知の挙動）。
function forceSpeakerRoute() {
  const stream = state.localStream;
  if (!stream) return;
  const tracks = stream.getAudioTracks();
  tracks.forEach((t) => (t.enabled = false));
  setTimeout(() => {
    // ミュート中なら off のまま維持、そうでなければ元に戻す
    tracks.forEach((t) => (t.enabled = !state.muted));
  }, 150);
}

// iOS Safari: 音声要素へストリームを貼り直すと既定ルート（受話口）へ戻る。
function forceEarpieceRoute(audio) {
  const s = audio.srcObject;
  if (!s) return;
  audio.srcObject = null;
  setTimeout(() => {
    audio.srcObject = s;
    audio.play().catch(() => {});
  }, 60);
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

  stopTone(); // 発信音・着信音を止める

  closeModal("calling-modal");
  closeModal("incoming-modal");
  closeModal("incall-modal");

  if (state.pc) {
    try { state.pc.ontrack = null; state.pc.onicecandidate = null; state.pc.close(); } catch {}
    state.pc = null;
  }
  const audio = $("remoteAudio");
  if (audio.srcObject) audio.srcObject = null;
  teardownRemoteGain();
  state.remoteStream = null;

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
// アイコンの HTML 文字列を作る（innerHTML 用）。画像があれば背景画像、無ければ頭文字＋色。
// data URL の base64 には HTML/CSS 特殊文字が含まれないが、念のため escapeHtml を通す。
function avatarMarkup(name, color, avatar, cls = "avatar") {
  if (avatar) {
    return `<div class="${cls}" style="background-image:url('${escapeHtml(avatar)}');background-size:cover;background-position:center"></div>`;
  }
  return `<div class="${cls}" style="background:${escapeHtml(color || "#5b8cff")}">${escapeHtml(initial(name))}</div>`;
}

// アイコン要素を描画する。avatar（画像の data URL）があれば画像、無ければ頭文字＋色。
function setAvatar(el, name, color, avatar) {
  if (avatar) {
    el.textContent = "";
    el.style.background = color || "#5b8cff";
    el.style.backgroundImage = `url("${avatar}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.textContent = initial(name);
    el.style.background = color || "#5b8cff";
    el.style.backgroundImage = "none";
  }
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

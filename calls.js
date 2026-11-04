/*
  Lumo — бесплатные звонки и видеозвонки (один файл).

  КАК ПОДКЛЮЧИТЬ (2 шага):

  1) В Supabase → SQL Editor → New query вставьте SQL из блока ниже и нажмите Run.
  2) В index.html добавьте ОДНУ строку ПЕРЕД <script src="app.js"></script>:

        <script src="calls.js"></script>

  Дальше: справа внизу появится кнопка 📞. В ней список людей, с которыми у вас
  есть личный чат. Нажмите 📞 (звонок) или 🎥 (видео) рядом с именем.
  Входящий звонок появится поверх экрана, пока Lumo открыт.

  ---------- SQL (выполнить один раз) ----------

  create or replace function public.shares_direct_chat(p_other uuid)
  returns boolean language sql security definer set search_path = public stable as $$
    select exists (
      select 1
      from public.chats c
      join public.chat_members a on a.chat_id = c.id and a.user_id = auth.uid()
      join public.chat_members b on b.chat_id = c.id and b.user_id = p_other
      where c.kind = 'direct'
    );
  $$;

  create table if not exists public.call_signals (
    id bigint generated always as identity primary key,
    call_id uuid not null,
    from_id uuid not null references public.profiles(id) on delete cascade,
    to_id uuid not null references public.profiles(id) on delete cascade,
    kind text not null check (kind in ('offer','answer','ice','hangup','decline','busy')),
    payload jsonb,
    created_at timestamptz not null default now()
  );
  create index if not exists call_signals_to_idx on public.call_signals (to_id, id);
  create index if not exists call_signals_call_idx on public.call_signals (call_id);
  alter table public.call_signals enable row level security;

  drop policy if exists "send call signals" on public.call_signals;
  create policy "send call signals" on public.call_signals for insert to authenticated
    with check (from_id = auth.uid() and public.shares_direct_chat(to_id));

  drop policy if exists "read own call signals" on public.call_signals;
  create policy "read own call signals" on public.call_signals for select to authenticated
    using (to_id = auth.uid() or from_id = auth.uid());

  drop policy if exists "delete own call signals" on public.call_signals;
  create policy "delete own call signals" on public.call_signals for delete to authenticated
    using (to_id = auth.uid() or from_id = auth.uid());

  create or replace function public.purge_call_signals()
  returns void language sql security definer set search_path = public as $$
    delete from public.call_signals
    where (from_id = auth.uid() or to_id = auth.uid())
      and created_at < now() - interval '10 minutes';
  $$;

  do $$
  begin
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'call_signals'
    ) then
      alter publication supabase_realtime add table public.call_signals;
    end if;
  end $$;

  ---------- конец SQL ----------

  Как это работает: звук и видео идут напрямую между устройствами (WebRTC),
  через базу передаются только короткие служебные сообщения «звоню / принял / сбросил».
  Нужен https (GitHub Pages подходит) и разрешение на микрофон и камеру.
  Звонит только 1 на 1. Если у обоих строгие мобильные сети, соединение может не
  установиться (для этого нужен платный TURN-сервер, его адрес добавляется в ICE_CONFIG).
*/
(function () {
  "use strict";

  // Перехватываем клиент Supabase, который создаёт app.js, чтобы использовать ту же сессию
  if (window.supabase && window.supabase.createClient && !window.__lumoSbHooked) {
    window.__lumoSbHooked = true;
    const orig = window.supabase.createClient;
    window.supabase.createClient = function () {
      const client = orig.apply(this, arguments);
      if (!window.__lumoSb) window.__lumoSb = client;
      return client;
    };
  }

  const ICE_CONFIG = {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
    ],
  };
  const RING_TIMEOUT_MS = 45000;

  function start() {
    const cfg = window.LUMO_CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || !window.supabase || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) return;
    const sb = window.__lumoSb || window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    init(sb);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else setTimeout(start, 0);

  function init(sb) {
    const state = { me: null, call: null, channel: null, earlyIce: new Map(), peers: [] };

    // ---------- Интерфейс ----------

    const css = document.createElement("style");
    css.textContent = `
      .lc-fab{position:fixed;right:14px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:40;width:52px;height:52px;border:0;border-radius:50%;font-size:24px;cursor:pointer;color:#1a1306;background:linear-gradient(135deg,#ffb547,#ff7a59);box-shadow:0 8px 24px rgba(0,0,0,.45)}
      .lc-panel{position:fixed;right:14px;bottom:calc(150px + env(safe-area-inset-bottom));z-index:41;width:min(320px,calc(100vw - 28px));max-height:55dvh;overflow-y:auto;padding:12px;border-radius:16px;background:#161923;color:#e8ebf5;border:1px solid #262b3d;box-shadow:0 20px 60px rgba(0,0,0,.55);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
      .lc-panel h4{margin:2px 4px 10px;font-size:15px}
      .lc-row{display:flex;align-items:center;gap:10px;padding:8px 4px}
      .lc-ava{width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:700;color:#1a1306;background:linear-gradient(135deg,#ffb547,#ff7a59)}
      .lc-name{flex:1;min-width:0;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lc-mini{border:0;background:#1d2130;color:#e8ebf5;border-radius:10px;font-size:18px;padding:7px 10px;cursor:pointer}
      .lc-hint{color:#8a92ad;font-size:13px;margin:4px}
      .lc-call{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 30%,#1d2130,#05060a 70%);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
      .lc-remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:none}
      .lc-call.lc-video .lc-remote{display:block}
      .lc-local{position:absolute;right:14px;top:calc(14px + env(safe-area-inset-top));width:108px;height:148px;object-fit:cover;border-radius:14px;border:2px solid rgba(255,255,255,.35);background:#000;transform:scaleX(-1);z-index:2}
      .lc-info{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;text-align:center}
      .lc-call.lc-video .lc-info{position:absolute;top:calc(18px + env(safe-area-inset-top));left:16px;align-items:flex-start;text-align:left;padding:0;text-shadow:0 1px 6px rgba(0,0,0,.8)}
      .lc-call.lc-video .lc-bigava{display:none}
      .lc-bigava{width:96px;height:96px;border-radius:50%;display:grid;place-items:center;font-size:38px;font-weight:700;color:#1a1306;background:linear-gradient(135deg,#ffb547,#ff7a59)}
      .lc-callname{font-size:24px;font-weight:700}
      .lc-status{font-size:15px;color:rgba(255,255,255,.75)}
      .lc-controls{position:absolute;left:0;right:0;bottom:calc(32px + env(safe-area-inset-bottom));z-index:3;display:flex;justify-content:center;gap:18px}
      .lc-btn{width:64px;height:64px;border:0;border-radius:50%;font-size:26px;color:#fff;background:rgba(255,255,255,.16);cursor:pointer}
      .lc-btn.lc-off{background:rgba(255,255,255,.9);color:#111}
      .lc-btn.lc-accept{background:#2fbf71}
      .lc-btn.lc-end{background:#e5484d}
      .lc-toast{position:fixed;left:50%;bottom:calc(30px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:min(90vw,420px);padding:10px 16px;border-radius:12px;font-size:14px;color:#e8ebf5;background:#232840;border:1px solid #262b3d;z-index:2100;text-align:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
      [hidden]{display:none!important}
    `;
    document.head.append(css);

    const root = document.createElement("div");
    root.innerHTML = `
      <button class="lc-fab" id="lc-fab" type="button" aria-label="Звонки" hidden>📞</button>
      <div class="lc-panel" id="lc-panel" hidden></div>
      <div class="lc-call" id="lc-call" hidden>
        <video class="lc-remote" id="lc-remote" autoplay playsinline muted></video>
        <video class="lc-local" id="lc-local" autoplay playsinline muted hidden></video>
        <audio id="lc-audio" autoplay playsinline></audio>
        <div class="lc-info">
          <div class="lc-bigava" id="lc-bigava"></div>
          <div class="lc-callname" id="lc-callname"></div>
          <div class="lc-status" id="lc-status"></div>
        </div>
        <div class="lc-controls">
          <button class="lc-btn" id="lc-mute" type="button" aria-label="Микрофон">🎙️</button>
          <button class="lc-btn" id="lc-cam" type="button" aria-label="Камера">📷</button>
          <button class="lc-btn lc-accept" id="lc-accept" type="button" aria-label="Принять">📞</button>
          <button class="lc-btn lc-end" id="lc-end" type="button" aria-label="Завершить">✕</button>
        </div>
      </div>
      <div class="lc-toast" id="lc-toast" hidden></div>`;
    document.body.append(root);

    const $ = (id) => document.getElementById(id);
    const show = (el, on) => { el.hidden = !on; };

    let toastTimer = null;
    function toast(text) {
      const el = $("lc-toast");
      el.textContent = text;
      show(el, true);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => show(el, false), 3500);
    }

    // ---------- Список людей для звонка ----------

    async function loadPeers() {
      const [mem, chats] = await Promise.all([
        sb.from("chat_members").select("chat_id, user_id, profiles(username)"),
        sb.from("chats").select("id, kind"),
      ]);
      if (mem.error || chats.error) throw mem.error || chats.error;
      const direct = new Set(chats.data.filter((c) => c.kind === "direct").map((c) => c.id));
      const seen = new Map();
      for (const m of mem.data) {
        if (!direct.has(m.chat_id) || m.user_id === state.me) continue;
        if (!seen.has(m.user_id)) {
          seen.set(m.user_id, { id: m.user_id, username: (m.profiles && m.profiles.username) || "?" });
        }
      }
      state.peers = [...seen.values()].sort((a, b) => a.username.localeCompare(b.username, "ru"));
    }

    async function renderPanel() {
      const panel = $("lc-panel");
      panel.textContent = "";
      const h = document.createElement("h4");
      h.textContent = "Позвонить";
      panel.append(h);
      try {
        await loadPeers();
      } catch (e) {
        const p = document.createElement("p");
        p.className = "lc-hint";
        p.textContent = "Не удалось загрузить список. Проверьте интернет.";
        panel.append(p);
        return;
      }
      if (!state.peers.length) {
        const p = document.createElement("p");
        p.className = "lc-hint";
        p.textContent = "Пока нет личных чатов. Напишите кому-нибудь, и он появится здесь.";
        panel.append(p);
        return;
      }
      for (const peer of state.peers) {
        const row = document.createElement("div");
        row.className = "lc-row";
        const ava = document.createElement("div");
        ava.className = "lc-ava";
        ava.textContent = peer.username.charAt(0).toUpperCase();
        const name = document.createElement("div");
        name.className = "lc-name";
        name.textContent = peer.username;
        const a = document.createElement("button");
        a.className = "lc-mini";
        a.type = "button";
        a.textContent = "📞";
        a.setAttribute("aria-label", "Позвонить " + peer.username);
        a.addEventListener("click", () => { show(panel, false); startCall(peer, false); });
        const v = document.createElement("button");
        v.className = "lc-mini";
        v.type = "button";
        v.textContent = "🎥";
        v.setAttribute("aria-label", "Видеозвонок " + peer.username);
        v.addEventListener("click", () => { show(panel, false); startCall(peer, true); });
        row.append(ava, name, a, v);
        panel.append(row);
      }
    }

    $("lc-fab").addEventListener("click", () => {
      const panel = $("lc-panel");
      const open = panel.hidden;
      show(panel, open);
      if (open) renderPanel();
    });

    // ---------- Звук ----------

    let audioCtx = null;
    function ensureAudio() {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
      } catch (e) { /* ignore */ }
    }
    ["click", "keydown", "touchstart"].forEach((ev) =>
      document.addEventListener(ev, ensureAudio, { passive: true })
    );

    function beep() {
      if (!audioCtx) return;
      try {
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.26);
      } catch (e) { /* ignore */ }
    }

    let ringInterval = null;
    function startRing() {
      stopRing();
      ensureAudio();
      const ring = () => {
        beep();
        setTimeout(beep, 260);
        try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) { /* ignore */ }
      };
      ring();
      ringInterval = setInterval(ring, 2200);
    }
    function stopRing() {
      clearInterval(ringInterval);
      ringInterval = null;
    }

    // ---------- WebRTC ----------

    function supported() {
      return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function newCall(fields) {
      return Object.assign({
        id: null, peerId: null, peerName: "", video: false, role: "caller", state: "ringing",
        pc: null, local: null, remote: null, offer: null, pendingIce: [], remoteVideo: false,
        muted: false, camOff: false, ringTimer: null, timer: null, dropTimer: null, startedAt: 0,
      }, fields);
    }

    async function sendSignal(call, kind, payload) {
      const { error } = await sb.from("call_signals").insert({
        call_id: call.id, from_id: state.me, to_id: call.peerId, kind, payload: payload || null,
      });
      if (error) console.error("signal", kind, error);
      return error || null;
    }

    function mediaErrorText(e) {
      const n = e && e.name;
      if (n === "NotAllowedError" || n === "SecurityError") {
        return "Нет доступа к микрофону или камере. Разрешите его в настройках браузера.";
      }
      if (n === "NotFoundError" || n === "OverconstrainedError") return "Микрофон или камера не найдены.";
      return (e && e.message) || "Не удалось начать звонок.";
    }

    async function getMedia(wantVideo) {
      const audio = { echoCancellation: true, noiseSuppression: true };
      if (wantVideo) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: "user" } });
        } catch (e) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio });
          toast("Камера недоступна: звонок без видео");
          return stream;
        }
      }
      return navigator.mediaDevices.getUserMedia({ audio });
    }

    function stopStream(s) {
      if (s) s.getTracks().forEach((t) => t.stop());
    }

    function fmtDuration(ms) {
      const s = Math.floor(ms / 1000);
      return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }

    function updateUI() {
      const call = state.call;
      if (!call) return;
      const incoming = call.state === "incoming";
      let status;
      if (incoming) status = call.video ? "Входящий видеозвонок" : "Входящий звонок";
      else if (call.state === "ringing") status = "Вызов…";
      else if (call.state === "connecting") status = "Соединяем…";
      else status = fmtDuration(Date.now() - call.startedAt);
      $("lc-status").textContent = status;

      const hasLocalVideo = !!(call.local && call.local.getVideoTracks().length);
      $("lc-call").classList.toggle("lc-video", call.remoteVideo);
      show($("lc-local"), hasLocalVideo && !incoming);
      show($("lc-accept"), incoming);
      show($("lc-mute"), !incoming);
      show($("lc-cam"), !incoming && hasLocalVideo);
      $("lc-mute").classList.toggle("lc-off", call.muted);
      $("lc-mute").textContent = call.muted ? "🔇" : "🎙️";
      $("lc-cam").classList.toggle("lc-off", call.camOff);
    }

    function showCallUI(call) {
      $("lc-callname").textContent = call.peerName;
      $("lc-bigava").textContent = call.peerName.charAt(0).toUpperCase();
      $("lc-local").srcObject = null;
      $("lc-remote").srcObject = null;
      $("lc-call").classList.remove("lc-video");
      show($("lc-panel"), false);
      show($("lc-call"), true);
      updateUI();
    }

    function attachRemote(call) {
      if (!call.remote) return;
      $("lc-remote").srcObject = call.remote;
      $("lc-audio").srcObject = call.remote;
      const p = $("lc-audio").play();
      if (p && p.catch) p.catch(() => {});
    }

    function setupPc(call) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      call.pc = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(call, "ice", e.candidate.toJSON());
      };

      pc.ontrack = (e) => {
        if (!call.remote) call.remote = new MediaStream();
        if (e.streams && e.streams[0]) call.remote = e.streams[0];
        else call.remote.addTrack(e.track);
        if (e.track.kind === "video") call.remoteVideo = true;
        attachRemote(call);
        updateUI();
      };

      pc.onconnectionstatechange = () => {
        if (state.call !== call) return;
        const s = pc.connectionState;
        if (s === "connected") {
          clearTimeout(call.dropTimer);
          if (call.state !== "active") {
            call.state = "active";
            call.startedAt = Date.now();
            clearInterval(call.timer);
            call.timer = setInterval(updateUI, 1000);
          }
          updateUI();
        } else if (s === "disconnected") {
          $("lc-status").textContent = "Связь потеряна…";
          clearTimeout(call.dropTimer);
          call.dropTimer = setTimeout(() => {
            if (state.call === call && pc.connectionState !== "connected") endCall("Связь потеряна", "hangup");
          }, 8000);
        } else if (s === "failed") {
          endCall("Не удалось соединиться. Возможно, сеть блокирует прямое соединение.", "hangup");
        }
      };
      return pc;
    }

    async function addIce(call, cand) {
      if (!cand) return;
      if (call.pc && call.pc.remoteDescription) {
        try { await call.pc.addIceCandidate(cand); } catch (e) { console.warn("ice", e); }
      } else {
        call.pendingIce.push(cand);
      }
    }

    function flushIce(call) {
      const list = call.pendingIce;
      call.pendingIce = [];
      list.forEach((c) => addIce(call, c));
    }

    async function startCall(peer, video) {
      if (state.call) { toast("Вы уже в звонке"); return; }
      if (!supported()) {
        toast("Звонки не поддерживаются: нужен современный браузер и https-адрес");
        return;
      }
      const call = newCall({
        id: crypto.randomUUID(), peerId: peer.id, peerName: peer.username, video, role: "caller", state: "ringing",
      });
      state.call = call;
      showCallUI(call);

      try {
        call.local = await getMedia(video);
        if (state.call !== call) { stopStream(call.local); return; }
        call.video = call.local.getVideoTracks().length > 0;
        $("lc-local").srcObject = call.local;

        setupPc(call);
        call.local.getTracks().forEach((t) => call.pc.addTrack(t, call.local));
        const offer = await call.pc.createOffer();
        await call.pc.setLocalDescription(offer);

        const err = await sendSignal(call, "offer", { type: offer.type, sdp: offer.sdp, video: call.video });
        if (err) throw new Error("Не удалось позвонить: " + (err.message || "ошибка"));
        updateUI();

        call.ringTimer = setTimeout(() => {
          if (state.call === call && call.state === "ringing") endCall("Нет ответа", "hangup");
        }, RING_TIMEOUT_MS);
      } catch (e) {
        console.error(e);
        endCall(mediaErrorText(e), "hangup");
      }
    }

    async function peerName(userId) {
      const known = state.peers.find((p) => p.id === userId);
      if (known) return known.username;
      const { data } = await sb.from("profiles").select("username").eq("id", userId).maybeSingle();
      return (data && data.username) || "Неизвестный";
    }

    async function onOffer(row) {
      if (state.call) {
        if (state.call.id !== row.call_id) {
          await sb.from("call_signals").insert({
            call_id: row.call_id, from_id: state.me, to_id: row.from_id, kind: "busy",
          });
        }
        return;
      }
      const name = await peerName(row.from_id);
      if (state.call) return;

      const call = newCall({
        id: row.call_id, peerId: row.from_id, peerName: name,
        video: !!(row.payload && row.payload.video), role: "callee", state: "incoming",
      });
      call.offer = row.payload;
      call.pendingIce = state.earlyIce.get(row.call_id) || [];
      state.earlyIce.delete(row.call_id);
      state.call = call;

      showCallUI(call);
      startRing();
      call.ringTimer = setTimeout(() => {
        if (state.call === call && call.state === "incoming") endCall("Пропущенный звонок", null);
      }, RING_TIMEOUT_MS);
      if (document.hidden) notifyCall(call);
    }

    async function acceptCall() {
      const call = state.call;
      if (!call || call.state !== "incoming") return;
      stopRing();
      clearTimeout(call.ringTimer);
      call.state = "connecting";
      updateUI();

      try {
        call.local = await getMedia(call.video);
        if (state.call !== call) { stopStream(call.local); return; }
        $("lc-local").srcObject = call.local;

        setupPc(call);
        call.local.getTracks().forEach((t) => call.pc.addTrack(t, call.local));
        await call.pc.setRemoteDescription({ type: call.offer.type, sdp: call.offer.sdp });
        flushIce(call);
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        await sendSignal(call, "answer", { type: answer.type, sdp: answer.sdp });
        updateUI();
      } catch (e) {
        console.error(e);
        endCall(mediaErrorText(e), "decline");
      }
    }

    async function onAnswer(call, payload) {
      try {
        await call.pc.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
        clearTimeout(call.ringTimer);
        if (call.state === "ringing") call.state = "connecting";
        flushIce(call);
        updateUI();
      } catch (e) {
        console.error(e);
        endCall("Не удалось соединиться", "hangup");
      }
    }

    function handleSignal(row) {
      const call = state.call;
      if (row.kind === "offer") { onOffer(row).catch(console.error); return; }
      if (row.kind === "ice") {
        if (call && call.id === row.call_id) {
          addIce(call, row.payload);
        } else {
          const list = state.earlyIce.get(row.call_id) || [];
          list.push(row.payload);
          state.earlyIce.set(row.call_id, list);
        }
        return;
      }
      if (!call || call.id !== row.call_id || call.peerId !== row.from_id) return;

      if (row.kind === "answer" && call.role === "caller") onAnswer(call, row.payload);
      else if (row.kind === "hangup") endCall(call.state === "incoming" ? "Пропущенный звонок" : "Звонок завершён", null);
      else if (row.kind === "decline") endCall("Вызов отклонён", null);
      else if (row.kind === "busy") endCall("Абонент занят", null);
    }

    function endCall(reason, sendKind) {
      const c = state.call;
      if (!c) return;
      state.call = null;

      stopRing();
      clearTimeout(c.ringTimer);
      clearTimeout(c.dropTimer);
      clearInterval(c.timer);
      if (sendKind) sendSignal(c, sendKind);

      try { if (c.pc) c.pc.close(); } catch (e) { /* ignore */ }
      stopStream(c.local);
      $("lc-remote").srcObject = null;
      $("lc-local").srcObject = null;
      $("lc-audio").srcObject = null;
      show($("lc-call"), false);
      if (reason) toast(reason);

      setTimeout(() => {
        sb.from("call_signals").delete().eq("call_id", c.id).then(() => {}, () => {});
      }, 5000);
    }

    async function notifyCall(call) {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const opts = {
        body: call.peerName + (call.video ? " звонит по видео" : " звонит"),
        icon: "icon.svg", tag: "lumo-call", renotify: true,
      };
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification("Входящий звонок", opts);
          return;
        }
      } catch (e) { /* пробуем обычное уведомление */ }
      try { new Notification("Входящий звонок", opts); } catch (e) { /* ignore */ }
    }

    // ---------- Кнопки звонка ----------

    $("lc-accept").addEventListener("click", acceptCall);

    $("lc-end").addEventListener("click", () => {
      const call = state.call;
      if (!call) return;
      if (call.state === "incoming") endCall(null, "decline");
      else endCall(call.state === "active" ? "Звонок завершён" : null, "hangup");
    });

    $("lc-mute").addEventListener("click", () => {
      const call = state.call;
      if (!call || !call.local) return;
      call.muted = !call.muted;
      call.local.getAudioTracks().forEach((t) => { t.enabled = !call.muted; });
      updateUI();
    });

    $("lc-cam").addEventListener("click", () => {
      const call = state.call;
      if (!call || !call.local) return;
      call.camOff = !call.camOff;
      call.local.getVideoTracks().forEach((t) => { t.enabled = !call.camOff; });
      updateUI();
    });

    window.addEventListener("pagehide", () => {
      if (state.call) endCall(null, "hangup");
    });

    // ---------- Подписка на входящие и вход/выход ----------

    function enter(userId) {
      if (state.me === userId && state.channel) return;
      state.me = userId;
      if (state.channel) sb.removeChannel(state.channel);
      state.channel = sb
        .channel("lumo-calls")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "call_signals", filter: "to_id=eq." + userId },
          (payload) => handleSignal(payload.new)
        )
        .subscribe();
      sb.rpc("purge_call_signals").then(() => {}, () => {});
      show($("lc-fab"), true);
    }

    function leave() {
      if (state.call) endCall(null, null);
      if (state.channel) {
        sb.removeChannel(state.channel);
        state.channel = null;
      }
      state.me = null;
      show($("lc-fab"), false);
      show($("lc-panel"), false);
    }

    sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) leave();
      else setTimeout(() => enter(session.user.id), 0);
    });

    sb.auth.getSession().then(({ data }) => {
      if (data.session) enter(data.session.user.id);
    });
  }
})();

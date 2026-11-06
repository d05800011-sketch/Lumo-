/* Lumo Calls: звонки и видеозвонки на LiveKit + Supabase Realtime.
 *
 * Подключение в index.html (до вашего основного скрипта):
 *   <script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>
 *   <script src="calls.js"></script>
 *
 * После входа пользователя:
 *   LumoCalls.init({
 *     supabase: supabaseClient,          // ваш клиент createClient(...)
 *     userId: user.id,
 *     userName: 'Ваше имя',
 *     livekitUrl: 'wss://chat-k4dq8vjv.livekit.cloud'
 *   });
 *
 * Кнопки в чате:
 *   LumoCalls.startCall(contactId, contactName, false); // голосовой
 *   LumoCalls.startCall(contactId, contactName, true);  // видео
 */
(function () {
  'use strict';

  var RING_TIMEOUT_MS = 45000;
  var cfg = null;
  var myChannel = null;
  var room = null;
  var call = null; // { room, peerId, peerName, video, role, connected }
  var ringTimer = null;
  var ringtone = null;
  var timerId = null;
  var ui = {};

  /* ---------- Инициализация ---------- */

  function init(options) {
    cfg = options;
    if (!ui.root) {
      injectStyles();
      buildUI();
    }
    listen();
  }

  function listen() {
    if (myChannel) cfg.supabase.removeChannel(myChannel);
    myChannel = cfg.supabase
      .channel('calls:' + cfg.userId)
      .on('broadcast', { event: 'invite' }, function (m) { onInvite(m.payload); })
      .on('broadcast', { event: 'cancel' }, function (m) { onCancel(m.payload); })
      .on('broadcast', { event: 'decline' }, function (m) { onDecline(m.payload); })
      .subscribe();
  }

  async function sendTo(peerId, event, payload) {
    var ch = cfg.supabase.channel('calls:' + peerId);
    await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, 8000);
      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
      });
    });
    await ch.send({ type: 'broadcast', event: event, payload: payload });
    cfg.supabase.removeChannel(ch);
  }

  /* ---------- Исходящий звонок ---------- */

  async function startCall(peerId, peerName, video) {
    if (!cfg) { console.error('LumoCalls.init не вызван'); return; }
    if (call) return;
    if (!window.LivekitClient) { toast('Библиотека звонков не загрузилась'); return; }

    call = {
      room: 'call_' + crypto.randomUUID(),
      peerId: peerId,
      peerName: peerName || 'Контакт',
      video: !!video,
      role: 'caller',
      connected: false
    };
    showCallScreen('Звоним…');

    try {
      await joinRoom();
      await sendTo(peerId, 'invite', {
        room: call.room,
        from: cfg.userId,
        fromName: cfg.userName || 'Контакт',
        video: call.video
      });
      ringTimer = setTimeout(function () {
        if (call && !call.connected) {
          notifyCancel();
          endCall('Нет ответа');
        }
      }, RING_TIMEOUT_MS);
    } catch (e) {
      console.error(e);
      endCall('Не удалось позвонить');
    }
  }

  function notifyCancel() {
    if (call) sendTo(call.peerId, 'cancel', { room: call.room }).catch(function () {});
  }

  /* ---------- Входящий звонок ---------- */

  function onInvite(p) {
    if (!p || !p.room) return;
    if (call) {
      sendTo(p.from, 'decline', { room: p.room, reason: 'busy' }).catch(function () {});
      return;
    }
    call = {
      room: p.room,
      peerId: p.from,
      peerName: p.fromName || 'Контакт',
      video: !!p.video,
      role: 'callee',
      connected: false
    };
    ui.inName.textContent = call.peerName;
    ui.inAvatar.textContent = initial(call.peerName);
    ui.inKind.textContent = call.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    ui.incoming.hidden = false;
    startRing();
    ringTimer = setTimeout(function () {
      if (call && !call.connected && call.role === 'callee') {
        stopRing();
        ui.incoming.hidden = true;
        call = null;
        toast('Пропущенный звонок');
      }
    }, RING_TIMEOUT_MS);
  }

  async function acceptCall() {
    if (!call) return;
    clearTimeout(ringTimer);
    stopRing();
    ui.incoming.hidden = true;
    showCallScreen('Соединяем…');
    try {
      await joinRoom();
    } catch (e) {
      console.error(e);
      endCall('Не удалось подключиться');
    }
  }

  function declineCall() {
    if (!call) return;
    var c = call;
    clearTimeout(ringTimer);
    stopRing();
    ui.incoming.hidden = true;
    call = null;
    sendTo(c.peerId, 'decline', { room: c.room }).catch(function () {});
  }

  function onCancel(p) {
    if (call && p && call.room === p.room && call.role === 'callee' && !call.connected) {
      clearTimeout(ringTimer);
      stopRing();
      ui.incoming.hidden = true;
      call = null;
      toast('Пропущенный звонок');
    }
  }

  function onDecline(p) {
    if (call && p && call.room === p.room && call.role === 'caller') {
      endCall(p.reason === 'busy' ? 'Занято' : 'Звонок отклонён');
    }
  }

  /* ---------- LiveKit ---------- */

  async function joinRoom() {
    var res = await cfg.supabase.functions.invoke('livekit-token', {
      body: { room: call.room }
    });
    if (res.error || !res.data || !res.data.token) {
      throw res.error || new Error('Нет токена');
    }
    var LK = window.LivekitClient;
    var r = new LK.Room({ adaptiveStream: true, dynacast: true });
    room = r;

    r.on(LK.RoomEvent.TrackSubscribed, onTrackSubscribed)
      .on(LK.RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(LK.RoomEvent.ParticipantConnected, onRemoteJoined)
      .on(LK.RoomEvent.ParticipantDisconnected, function () { endCall('Звонок завершён'); })
      .on(LK.RoomEvent.LocalTrackPublished, onLocalPublished)
      .on(LK.RoomEvent.Disconnected, function () {
        if (call && room === r) endCall('Соединение потеряно');
      });

    await r.connect(cfg.livekitUrl, res.data.token);
    try { await r.startAudio(); } catch (e) { /* не критично */ }
    await r.localParticipant.setMicrophoneEnabled(true);
    if (call && call.video) await r.localParticipant.setCameraEnabled(true);
    if (r.remoteParticipants && r.remoteParticipants.size > 0) onRemoteJoined();
  }

  function onRemoteJoined() {
    if (!call || call.connected) return;
    call.connected = true;
    clearTimeout(ringTimer);
    startTimer();
  }

  function onTrackSubscribed(track) {
    if (track.kind === 'video') {
      ui.remoteVideo.innerHTML = '';
      var v = track.attach();
      v.playsInline = true;
      ui.remoteVideo.appendChild(v);
      ui.screen.classList.add('has-remote-video');
    } else if (track.kind === 'audio') {
      var a = track.attach();
      a.style.display = 'none';
      ui.audioHost.appendChild(a);
    }
  }

  function onTrackUnsubscribed(track) {
    track.detach().forEach(function (el) { el.remove(); });
    if (track.kind === 'video') ui.screen.classList.remove('has-remote-video');
  }

  function onLocalPublished(pub) {
    if (pub.track && pub.track.kind === 'video') {
      ui.localVideo.innerHTML = '';
      var el = pub.track.attach();
      el.muted = true;
      el.playsInline = true;
      ui.localVideo.appendChild(el);
      ui.localVideo.hidden = false;
      ui.btnCam.textContent = '📹';
      ui.btnCam.classList.remove('off');
    }
  }

  /* ---------- Управление ---------- */

  async function toggleMic() {
    if (!room) return;
    var on = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(on);
    ui.btnMic.textContent = on ? '🎤' : '🔇';
    ui.btnMic.classList.toggle('off', !on);
  }

  async function toggleCam() {
    if (!room) return;
    var on = !room.localParticipant.isCameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(on);
    } catch (e) {
      toast('Нет доступа к камере');
      return;
    }
    ui.localVideo.hidden = !on;
    ui.btnCam.textContent = on ? '📹' : '🚫';
    ui.btnCam.classList.toggle('off', !on);
  }

  function hangup() {
    if (!call) return;
    if (call.role === 'caller' && !call.connected) notifyCancel();
    endCall('Звонок завершён');
  }

  function endCall(msg) {
    clearTimeout(ringTimer);
    stopRing();
    stopTimer();
    var r = room;
    room = null;
    call = null;
    if (r) { try { r.disconnect(); } catch (e) { /* ignore */ } }
    ui.screen.hidden = true;
    ui.incoming.hidden = true;
    ui.screen.classList.remove('has-remote-video');
    ui.remoteVideo.innerHTML = '';
    ui.localVideo.innerHTML = '';
    ui.audioHost.innerHTML = '';
    if (msg) toast(msg);
  }

  /* ---------- Интерфейс ---------- */

  function showCallScreen(status) {
    ui.name.textContent = call.peerName;
    ui.avatar.textContent = initial(call.peerName);
    ui.status.textContent = status;
    ui.localVideo.hidden = true;
    ui.btnMic.textContent = '🎤';
    ui.btnMic.classList.remove('off');
    ui.btnCam.textContent = call.video ? '📹' : '🚫';
    ui.btnCam.classList.toggle('off', !call.video);
    ui.screen.hidden = false;
  }

  function startTimer() {
    stopTimer();
    var t0 = Date.now();
    var tick = function () {
      var s = Math.floor((Date.now() - t0) / 1000);
      ui.status.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function startRing() {
    try {
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      var beep = function () {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.frequency.value = 440;
        g.gain.value = 0.08;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.4);
      };
      beep();
      ringtone = { ctx: ctx, id: setInterval(beep, 1500) };
    } catch (e) { /* звук не обязателен */ }
  }

  function stopRing() {
    if (ringtone) {
      clearInterval(ringtone.id);
      try { ringtone.ctx.close(); } catch (e) { /* ignore */ }
      ringtone = null;
    }
  }

  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { ui.toast.hidden = true; }, 3000);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function initial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function buildUI() {
    var root = el('div');
    root.id = 'lumo-call-root';

    // Входящий звонок
    var incoming = el('div', 'lc-incoming');
    incoming.hidden = true;
    var card = el('div', 'lc-card');
    var inAvatar = el('div', 'lc-avatar');
    var inName = el('div', 'lc-name');
    var inKind = el('div', 'lc-status');
    var row = el('div', 'lc-row');
    var bDecline = el('button', 'lc-btn lc-red', '📵');
    var bAccept = el('button', 'lc-btn lc-green', '📞');
    bDecline.onclick = declineCall;
    bAccept.onclick = acceptCall;
    row.append(bDecline, bAccept);
    card.append(inAvatar, inName, inKind, row);
    incoming.append(card);

    // Экран звонка
    var screen = el('div', 'lc-screen');
    screen.hidden = true;
    var remoteVideo = el('div', 'lc-remote');
    var center = el('div', 'lc-center');
    var avatar = el('div', 'lc-avatar');
    var name = el('div', 'lc-name');
    var status = el('div', 'lc-status');
    center.append(avatar, name, status);
    var localVideo = el('div', 'lc-local');
    localVideo.hidden = true;
    var controls = el('div', 'lc-controls');
    var btnMic = el('button', 'lc-btn', '🎤');
    var btnCam = el('button', 'lc-btn', '📹');
    var btnEnd = el('button', 'lc-btn lc-red', '📵');
    btnMic.onclick = toggleMic;
    btnCam.onclick = toggleCam;
    btnEnd.onclick = hangup;
    controls.append(btnMic, btnCam, btnEnd);
    var audioHost = el('div');
    screen.append(remoteVideo, center, localVideo, controls, audioHost);

    var toastEl = el('div', 'lc-toast');
    toastEl.hidden = true;

    root.append(incoming, screen, toastEl);
    document.body.appendChild(root);

    ui = {
      root: root, incoming: incoming, inAvatar: inAvatar, inName: inName, inKind: inKind,
      screen: screen, remoteVideo: remoteVideo, avatar: avatar, name: name, status: status,
      localVideo: localVideo, btnMic: btnMic, btnCam: btnCam, audioHost: audioHost, toast: toastEl
    };
  }

  function injectStyles() {
    var css = [
      '#lumo-call-root [hidden]{display:none !important}',
      '.lc-incoming{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}',
      '.lc-card{background:#1c1c22;color:#fff;border-radius:24px;padding:32px 28px;width:min(86vw,320px);text-align:center}',
      '.lc-avatar{width:88px;height:88px;border-radius:50%;background:#5b5bd6;color:#fff;font-size:36px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px}',
      '.lc-name{font-size:22px;font-weight:600;margin-bottom:6px}',
      '.lc-status{font-size:15px;opacity:.7;margin-bottom:22px}',
      '.lc-row{display:flex;gap:28px;justify-content:center}',
      '.lc-btn{width:64px;height:64px;border-radius:50%;border:0;background:#3a3a44;color:#fff;font-size:26px;cursor:pointer}',
      '.lc-btn.off{background:#fff;color:#111}',
      '.lc-red{background:#e5484d !important;color:#fff !important}',
      '.lc-green{background:#30a46c}',
      '.lc-screen{position:fixed;inset:0;z-index:99999;background:#0e0e12;color:#fff;font-family:system-ui,sans-serif}',
      '.lc-remote{position:absolute;inset:0}',
      '.lc-remote video{width:100%;height:100%;object-fit:cover}',
      '.lc-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}',
      '.lc-center .lc-status{margin-bottom:0}',
      '.lc-screen.has-remote-video .lc-avatar,.lc-screen.has-remote-video .lc-name{display:none}',
      '.lc-screen.has-remote-video .lc-center{justify-content:flex-start;padding-top:max(env(safe-area-inset-top),20px)}',
      '.lc-screen.has-remote-video .lc-status{background:rgba(0,0,0,.45);padding:4px 12px;border-radius:12px;opacity:1}',
      '.lc-local{position:absolute;right:14px;bottom:130px;width:104px;height:148px;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 4px 16px rgba(0,0,0,.5)}',
      '.lc-local video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}',
      '.lc-controls{position:absolute;left:0;right:0;bottom:max(env(safe-area-inset-bottom),28px);display:flex;gap:22px;justify-content:center}',
      '.lc-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:100000;background:rgba(30,30,36,.95);color:#fff;padding:10px 18px;border-radius:20px;font:14px system-ui,sans-serif}'
    ].join('\n');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  window.LumoCalls = { init: init, startCall: startCall, hangup: hangup };
})();

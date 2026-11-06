// Lumo — клиентская логика (чистый JS + Supabase)
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const cfg = window.LUMO_CONFIG;
  const configured =
    !window.LUMO_CONFIG_MISSING &&
    cfg &&
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT");

  if (!configured) {
    $("setup-screen").hidden = false;
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const state = {
    me: null,              // { id, username, avatar_url }
    chats: new Map(),      // chatId -> чат (см. loadChats)
    activeChat: null,
    shownIds: new Set(),   // id сообщений, уже нарисованных в открытом чате
    channel: null,         // realtime-канал
    signup: false,
    avatarTarget: null,    // "profile" или id чата
    muted: loadMuted(),    // чаты без звука
  };

  // ---------- Вспомогательные ----------

  function show(el, on) { el.hidden = !on; }

  function initial(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDay(iso) {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function friendlyError(err) {
    const m = (err && err.message) || String(err);
    if (/Invalid login credentials/i.test(m)) return "Неверный email или пароль.";
    if (/User already registered/i.test(m)) return "Этот email уже зарегистрирован.";
    if (/Password should be/i.test(m)) return "Пароль слишком короткий (минимум 6 символов).";
    if (/duplicate key|profiles_username_key/i.test(m)) return "Это имя пользователя занято.";
    if (/Email not confirmed/i.test(m)) return "Подтвердите email по ссылке из письма.";
    if (/Bucket not found/i.test(m)) return "Хранилище аватарок не настроено: выполните supabase/migration_v2.sql.";
    if (/row-level security|not authorized|Unauthorized/i.test(m)) return "Нет прав на это действие.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
    // Наши собственные сообщения из базы уже на русском
    return m;
  }

  function parseNames(text) {
    return [...new Set(
      String(text || "")
        .split(/[,\s]+/)
        .map((s) => s.trim().replace(/^@/, ""))
        .filter(Boolean)
    )];
  }

  function loadMuted() {
    try {
      return new Set(JSON.parse(localStorage.getItem("lumo_muted") || "[]"));
    } catch (e) {
      return new Set();
    }
  }

  function saveMuted() {
    try {
      localStorage.setItem("lumo_muted", JSON.stringify([...state.muted]));
    } catch (e) { /* хранилище недоступно, не страшно */ }
  }

  // Рисует аватарку: фото, а если его нет или оно не загрузилось, то первая буква
  function paintAvatar(el, url, name) {
    el.textContent = "";
    if (url) {
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => { el.textContent = initial(name); };
      img.src = url;
      el.append(img);
    } else {
      el.textContent = initial(name);
    }
  }

  // ---------- Авторизация ----------

  function renderAuthMode() {
    show($("username-field"), state.signup);
    $("username").required = state.signup;
    $("password").autocomplete = state.signup ? "new-password" : "current-password";
    $("auth-submit").textContent = state.signup ? "Создать аккаунт" : "Войти";
    $("auth-toggle").textContent = state.signup
      ? "Уже есть аккаунт? Войти"
      : "Нет аккаунта? Зарегистрироваться";
    show($("auth-error"), false);
    show($("auth-info"), false);
  }

  $("auth-toggle").addEventListener("click", () => {
    state.signup = !state.signup;
    renderAuthMode();
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("auth-submit");
    btn.disabled = true;
    show($("auth-error"), false);
    show($("auth-info"), false);

    const email = $("email").value.trim();
    const password = $("password").value;

    try {
      if (state.signup) {
        const username = $("username").value.trim();
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { username } },
        });
        if (error) throw error;
        if (!data.session) {
          state.signup = false;
          renderAuthMode();
          $("auth-info").textContent =
            "Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.";
          show($("auth-info"), true);
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      $("auth-error").textContent = friendlyError(err);
      show($("auth-error"), true);
    } finally {
      btn.disabled = false;
    }
  });

  $("logout").addEventListener("click", async () => {
    await sb.auth.signOut();
  });

  // ---------- Загрузка данных ----------

  async function loadProfile(user) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, username, avatar_url")
      .eq("id", user.id)
      .single();
    if (error) throw error;
    state.me = data;
    renderMe();
  }

  function renderMe() {
    $("me-name").textContent = "@" + state.me.username;
    paintAvatar($("me-avatar"), state.me.avatar_url, state.me.username);
  }

  // Название и аватарка чата для списка
  function decorate(chat) {
    if (chat.kind === "direct") {
      let other = null;
      for (const [id, m] of chat.members) {
        if (id !== state.me.id) { other = m; break; }
      }
      chat.name = other ? other.username : "Избранное";
      chat.avatar = other ? other.avatar_url : state.me.avatar_url;
    } else {
      chat.name = chat.title || "Без названия";
      chat.avatar = chat.avatar_url;
    }
  }

  async function loadChats() {
    const [memRes, mineRes, chatRes, msgRes, unreadRes] = await Promise.all([
      sb.from("chat_members").select("chat_id, user_id, role, profiles(username, avatar_url)"),
      sb.from("chat_members").select("chat_id, role").eq("user_id", state.me.id),
      sb.from("chats").select("id, kind, title, description, avatar_url, handle"),
      sb.from("messages")
        .select("chat_id, sender_id, body, created_at")
        .order("created_at", { ascending: false })
        .limit(300),
      sb.rpc("unread_counts"),
    ]);
    for (const r of [memRes, mineRes, chatRes, msgRes, unreadRes]) {
      if (r.error) throw r.error;
    }

    const membersByChat = new Map();
    for (const m of memRes.data) {
      if (!membersByChat.has(m.chat_id)) membersByChat.set(m.chat_id, new Map());
      membersByChat.get(m.chat_id).set(m.user_id, {
        username: (m.profiles && m.profiles.username) || "?",
        avatar_url: m.profiles ? m.profiles.avatar_url : null,
        role: m.role,
      });
    }
    const myRole = new Map(mineRes.data.map((r) => [r.chat_id, r.role]));
    const lastByChat = new Map();
    for (const m of msgRes.data) {
      if (!lastByChat.has(m.chat_id)) lastByChat.set(m.chat_id, m);
    }
    const unread = new Map(unreadRes.data.map((r) => [r.chat_id, Number(r.unread)]));

    state.chats = new Map();
    for (const c of chatRes.data) {
      const chat = {
        id: c.id,
        kind: c.kind,
        title: c.title,
        description: c.description,
        avatar_url: c.avatar_url,
        handle: c.handle,
        members: membersByChat.get(c.id) || new Map(),
        myRole: myRole.get(c.id) || "member",
        last: lastByChat.get(c.id) || null,
        unread: unread.get(c.id) || 0,
      };
      decorate(chat);
      state.chats.set(c.id, chat);
    }

    if (state.activeChat) {
      const active = state.chats.get(state.activeChat);
      if (!active) {
        closeChat();
      } else {
        if (!document.hidden) active.unread = 0;
        updateChatHeader(active);
      }
    }
    renderChatList();
    updateBadge();
  }

  let reloadTimer = null;
  function loadChatsSoon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadChats().catch(console.error), 300);
  }

  // ---------- Список чатов ----------

  function previewText(chat) {
    if (!chat.last) return chat.kind === "channel" ? "Нет записей" : "Нет сообщений";
    const mine = chat.last.sender_id === state.me.id;
    let prefix = "";
    if (mine) {
      prefix = "Вы: ";
    } else if (chat.kind === "group") {
      const m = chat.members.get(chat.last.sender_id);
      prefix = (m ? m.username : "?") + ": ";
    }
    return prefix + chat.last.body;
  }

  function renderChatList() {
    const list = $("chat-list");
    list.textContent = "";

    const chats = [...state.chats.values()].sort((a, b) => {
      const ta = a.last ? new Date(a.last.created_at).getTime() : 0;
      const tb = b.last ? new Date(b.last.created_at).getTime() : 0;
      return tb - ta;
    });

    show($("chat-empty"), chats.length === 0);

    for (const chat of chats) {
      const li = document.createElement("li");
      li.className =
        "chat-item" +
        (chat.id === state.activeChat ? " active" : "") +
        (chat.unread > 0 ? " unread" : "");
      li.dataset.id = chat.id;

      const av = document.createElement("div");
      av.className = "avatar";
      paintAvatar(av, chat.avatar, chat.name);

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent =
        chat.name + (chat.kind === "channel" ? " 📢" : chat.kind === "group" ? " 👥" : "");
      const prev = document.createElement("div");
      prev.className = "preview";
      prev.textContent = previewText(chat);
      meta.append(name, prev);

      li.append(av, meta);

      if (chat.unread > 0) {
        const badge = document.createElement("span");
        badge.className = "badge" + (state.muted.has(chat.id) ? " muted" : "");
        badge.textContent = chat.unread > 99 ? "99+" : String(chat.unread);
        li.append(badge);
      }

      li.addEventListener("click", () => openChat(chat.id));
      list.append(li);
    }
  }

  // ---------- Открытый чат ----------

  function canPost(chat) {
    return chat.kind !== "channel" || chat.myRole === "owner" || chat.myRole === "admin";
  }

  function chatSub(chat) {
    const n = chat.members.size;
    if (chat.kind === "group") {
      return n + " " + plural(n, "участник", "участника", "участников");
    }
    if (chat.kind === "channel") {
      const parts = [];
      if (chat.handle) parts.push("@" + chat.handle);
      if (chat.myRole === "owner" || chat.myRole === "admin") {
        parts.push(n + " " + plural(n, "подписчик", "подписчика", "подписчиков"));
      }
      return parts.join(" · ");
    }
    return "";
  }

  function updateChatHeader(chat) {
    $("chat-title").textContent = chat.name;
    paintAvatar($("chat-avatar"), chat.avatar, chat.name);
    $("chat-sub").textContent = chatSub(chat);
    show($("chat-sub"), !!$("chat-sub").textContent);

    const post = canPost(chat);
    show($("composer"), post);
    show($("readonly-note"), !post);
  }

  async function openChat(chatId) {
    const chat = state.chats.get(chatId);
    if (!chat) return;

    state.activeChat = chatId;
    state.shownIds.clear();
    renderChatList();

    show($("chat-placeholder"), false);
    show($("chat-view"), true);
    $("app").classList.add("chat-open");
    updateChatHeader(chat);

    const box = $("messages");
    box.textContent = "";
    delete box.dataset.lastDay;

    markRead(chatId);

    const { data, error } = await sb
      .from("messages")
      .select("id, chat_id, sender_id, body, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error(error);
      return;
    }
    // Пока грузились сообщения, пользователь мог открыть другой чат
    if (state.activeChat !== chatId) return;

    data.reverse().forEach(appendMessage);
    scrollDown();
    if (canPost(chat)) $("message-input").focus();
  }

  function closeChat() {
    state.activeChat = null;
    $("app").classList.remove("chat-open");
    show($("chat-view"), false);
    show($("chat-placeholder"), true);
    renderChatList();
  }

  $("back").addEventListener("click", closeChat);

  function appendMessage(msg) {
    if (state.shownIds.has(msg.id)) return;
    state.shownIds.add(msg.id);

    const chat = state.chats.get(msg.chat_id);
    const box = $("messages");

    // Разделитель по дням
    const day = new Date(msg.created_at).toDateString();
    if (box.dataset.lastDay !== day) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = fmtDay(msg.created_at);
      box.append(sep);
      box.dataset.lastDay = day;
    }

    const mine = msg.sender_id === state.me.id;
    const el = document.createElement("div");
    el.className = "msg" + (mine ? " mine" : "");

    if (!mine && chat && chat.kind === "group") {
      const m = chat.members.get(msg.sender_id);
      const who = document.createElement("span");
      who.className = "sender";
      who.textContent = m ? m.username : "?";
      el.append(who);
    }

    el.append(document.createTextNode(msg.body));
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtTime(msg.created_at);
    el.append(time);
    box.append(el);
  }

  function scrollDown() {
    const box = $("messages");
    box.scrollTop = box.scrollHeight;
  }

  // ---------- Отправка ----------

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("message-input");
    const body = input.value.trim();
    if (!body || !state.activeChat) return;

    input.value = "";
    const { data, error } = await sb
      .from("messages")
      .insert({ chat_id: state.activeChat, sender_id: state.me.id, body })
      .select("id, chat_id, sender_id, body, created_at")
      .single();

    if (error) {
      input.value = body; // вернуть текст, чтобы не потерять
      console.error(error);
      return;
    }
    onNewMessage(data);
  });

  // ---------- Непрочитанные, звук, уведомления ----------

  let readTimer = null;

  function markRead(chatId) {
    const chat = state.chats.get(chatId);
    if (chat && chat.unread !== 0) {
      chat.unread = 0;
      renderChatList();
      updateBadge();
    }
    sb.rpc("mark_read", { p_chat_id: chatId }).then(({ error }) => {
      if (error) console.error(error);
    });
  }

  function markReadSoon(chatId) {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => markRead(chatId), 400);
  }

  function updateBadge() {
    let n = 0;
    for (const c of state.chats.values()) {
      if (!state.muted.has(c.id)) n += c.unread;
    }
    document.title = n ? "(" + (n > 99 ? "99+" : n) + ") Lumo" : "Lumo";
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (e) { /* значок на иконке поддерживается не везде */ }
  }

  // Звук: браузер разрешает его только после первого касания страницы
  let audioCtx = null;
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* звук недоступен */ }
  }
  ["click", "keydown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, ensureAudio, { passive: true })
  );

  function playBeep() {
    if (!audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    } catch (e) { /* ignore */ }
  }

  function getSwRegistration() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]).catch(() => null);
  }

  async function showSystemNotification(chat, msg) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const sender = chat.members.get(msg.sender_id);
    const body =
      (chat.kind === "group" && sender ? sender.username + ": " : "") + msg.body;
    const opts = {
      body: body.slice(0, 140),
      icon: "icon.svg",
      tag: chat.id,
      renotify: true,
      data: { chatId: chat.id },
    };

    try {
      const reg = await getSwRegistration();
      if (reg) {
        await reg.showNotification(chat.name, opts);
        return;
      }
    } catch (e) { /* пробуем обычное уведомление */ }
    try {
      const n = new Notification(chat.name, opts);
      n.onclick = () => { window.focus(); openChat(chat.id); n.close(); };
    } catch (e) { /* ignore */ }
  }

  function notify(chat, msg) {
    if (state.muted.has(chat.id)) return;
    playBeep();
    if (document.hidden) showSystemNotification(chat, msg);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.activeChat) markRead(state.activeChat);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.type === "open-chat" && d.chatId && state.chats.has(d.chatId)) {
        openChat(d.chatId);
      }
    });
  }

  // ---------- Realtime ----------

  function subscribeRealtime() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb
      .channel("lumo-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => onNewMessage(payload.new)
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_members" },
        () => loadChatsSoon()
      )
      .subscribe();
  }

  async function onNewMessage(msg) {
    let fresh = false;
    if (!state.chats.has(msg.chat_id)) {
      // Чат, которого у нас ещё нет в списке (нас добавили или нам написали впервые)
      await loadChats();
      fresh = true;
    }
    const chat = state.chats.get(msg.chat_id);
    if (!chat) return;

    chat.last = {
      chat_id: msg.chat_id,
      sender_id: msg.sender_id,
      body: msg.body,
      created_at: msg.created_at,
    };

    const mine = msg.sender_id === state.me.id;
    const isActive = msg.chat_id === state.activeChat;

    if (isActive) {
      const box = $("messages");
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      appendMessage(msg);
      if (nearBottom || mine) scrollDown();
    }

    if (!mine) {
      if (isActive && !document.hidden) {
        markReadSoon(chat.id);
      } else {
        // при свежей загрузке сервер уже посчитал это сообщение
        if (!fresh) chat.unread += 1;
        notify(chat, msg);
      }
    }

    renderChatList();
    updateBadge();
  }

  // ---------- Диалоги: общее ----------

  document.querySelectorAll("dialog.dlg").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
    });
  });

  function openDialog(id) {
    const dlg = $(id);
    if (!dlg.open) dlg.showModal();
  }

  // ---------- Новый чат (личный) ----------

  $("new-chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("new-chat-error");
    show(err, false);

    const username = $("new-chat-username").value.trim().replace(/^@/, "");
    if (!username) return;

    const { data: chatId, error } = await sb.rpc("start_direct_chat", {
      p_username: username,
    });
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    $("new-chat-username").value = "";
    await loadChats();
    openChat(chatId);
  });

  // ---------- Диалог «Группа / Канал / Найти» ----------

  $("open-new").addEventListener("click", () => {
    openDialog("dlg-new");
  });

  function selectNewTab(name) {
    document.querySelectorAll("#new-tabs .tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll("#dlg-new [data-body]").forEach((b) => {
      b.hidden = b.dataset.body !== name;
    });
    if (name === "find") runSearch();
  }

  $("new-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) selectNewTab(tab.dataset.tab);
  });

  $("form-group").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("group-error");
    show(err, false);
    const btn = e.submitter;
    if (btn) btn.disabled = true;

    const { data: chatId, error } = await sb.rpc("create_group", {
      p_title: $("group-title").value.trim(),
      p_usernames: parseNames($("group-members").value),
    });
    if (btn) btn.disabled = false;
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    $("form-group").reset();
    $("dlg-new").close();
    await loadChats();
    openChat(chatId);
  });

  $("form-channel").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("channel-error");
    show(err, false);
    const btn = e.submitter;
    if (btn) btn.disabled = true;

    const { data: chatId, error } = await sb.rpc("create_channel", {
      p_title: $("channel-title").value.trim(),
      p_handle: $("channel-handle").value.trim(),
      p_description: $("channel-desc").value.trim(),
    });
    if (btn) btn.disabled = false;
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    $("form-channel").reset();
    $("dlg-new").close();
    await loadChats();
    openChat(chatId);
  });

  let searchTimer = null;
  let searchSeq = 0;

  $("find-query").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });

  async function runSearch() {
    const seq = ++searchSeq;
    const err = $("find-error");
    show(err, false);

    const { data, error } = await sb.rpc("search_channels", {
      p_query: $("find-query").value.trim(),
    });
    if (seq !== searchSeq) return; // пришёл более свежий ответ
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }

    const list = $("find-results");
    list.textContent = "";
    show($("find-empty"), data.length === 0);

    for (const ch of data) {
      const li = document.createElement("li");
      li.className = "result-item";

      const av = document.createElement("div");
      av.className = "avatar sm";
      paintAvatar(av, ch.avatar_url, ch.title);

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = ch.title;
      const sub = document.createElement("div");
      sub.className = "sub";
      const n = Number(ch.members);
      sub.textContent =
        "@" + ch.handle + " · " + n + " " + plural(n, "подписчик", "подписчика", "подписчиков");
      meta.append(name, sub);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small" + (ch.joined ? "" : " primary");
      btn.textContent = ch.joined ? "Открыть" : "Вступить";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { data: chatId, error: jErr } = await sb.rpc("join_channel", {
          p_handle: ch.handle,
        });
        btn.disabled = false;
        if (jErr) {
          err.textContent = friendlyError(jErr);
          show(err, true);
          return;
        }
        $("dlg-new").close();
        await loadChats();
        openChat(chatId);
      });

      li.append(av, meta, btn);
      list.append(li);
    }
  }

  // ---------- Аватарки: загрузка ----------

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не удалось прочитать фото")); };
      img.src = url;
    });
  }

  // Обрезаем по центру до квадрата и сжимаем: так фото весит 10-30 КБ
  async function resizeToSquare(file, size) {
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      bmp = await loadImageFromFile(file);
    }
    const w = bmp.width;
    const h = bmp.height;
    const s = Math.min(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Не удалось обработать фото"))),
        "image/jpeg",
        0.85
      );
    });
  }

  async function uploadAvatar(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      throw new Error("Выберите изображение");
    }
    const blob = await resizeToSquare(file, 256);
    const path = state.me.id + "/" + Date.now() + ".jpg";
    const { error } = await sb.storage
      .from("avatars")
      .upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
    if (error) throw error;
    return sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  }

  function pickAvatar(target) {
    state.avatarTarget = target;
    $("avatar-file").click();
  }

  $("avatar-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;

    const target = state.avatarTarget;
    state.avatarTarget = null;
    const errEl = target === "profile" ? $("profile-error") : $("info-error");
    show(errEl, false);

    try {
      const url = await uploadAvatar(file);
      if (target === "profile") {
        const { error } = await sb.from("profiles").update({ avatar_url: url }).eq("id", state.me.id);
        if (error) throw error;
        state.me.avatar_url = url;
        renderMe();
        paintAvatar($("profile-avatar"), url, state.me.username);
        await loadChats();
      } else {
        const { error } = await sb.rpc("update_chat", { p_chat_id: target, p_avatar_url: url });
        if (error) throw error;
        await loadChats();
        fillInfo(target);
      }
    } catch (err) {
      errEl.textContent = friendlyError(err);
      show(errEl, true);
    }
  });

  // ---------- Профиль ----------

  function updateNotifUi() {
    const status = $("notif-status");
    const btn = $("notif-btn");
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
    show($("notif-ios"), ios);

    if (!("Notification" in window)) {
      status.textContent = "Не поддерживаются этим браузером";
      show(btn, false);
    } else if (Notification.permission === "granted") {
      status.textContent = "Включены. Отключить можно в настройках браузера.";
      show(btn, false);
    } else if (Notification.permission === "denied") {
      status.textContent = "Заблокированы в настройках браузера";
      show(btn, false);
    } else {
      status.textContent = "Выключены";
      show(btn, true);
    }
  }

  $("open-profile").addEventListener("click", () => {
    paintAvatar($("profile-avatar"), state.me.avatar_url, state.me.username);
    $("profile-name").textContent = "@" + state.me.username;
    show($("profile-error"), false);
    updateNotifUi();
    openDialog("dlg-profile");
  });

  $("profile-avatar-btn").addEventListener("click", () => pickAvatar("profile"));

  $("notif-btn").addEventListener("click", async () => {
    ensureAudio();
    try {
      await Notification.requestPermission();
    } catch (e) { /* ignore */ }
    updateNotifUi();
  });

  // ---------- О чате ----------

  function isAdmin(chat) {
    return chat.kind !== "direct" && (chat.myRole === "owner" || chat.myRole === "admin");
  }

  function fillInfo(chatId) {
    const chat = state.chats.get(chatId);
    if (!chat) return;
    const admin = isAdmin(chat);

    $("info-kind").textContent =
      chat.kind === "channel" ? "Канал" : chat.kind === "group" ? "Группа" : "Личный чат";
    paintAvatar($("info-avatar"), chat.avatar, chat.name);
    $("info-avatar-btn").disabled = !admin;
    $("info-title").textContent = chat.name;
    $("info-handle").textContent = chat.handle ? "@" + chat.handle : "";
    show($("info-handle"), !!chat.handle);
    $("info-desc").textContent = chat.description || "";
    show($("info-desc"), !!chat.description);

    show($("info-edit"), admin);
    $("info-edit-title").value = chat.title || "";
    $("info-edit-desc").value = chat.description || "";
    show($("info-add"), admin);

    $("info-mute").checked = state.muted.has(chat.id);
    show($("info-error"), false);

    // Список участников: в каналах его видят только администраторы
    const showMembers = chat.kind !== "direct" && (chat.kind !== "channel" || admin);
    show($("info-members-wrap"), showMembers);
    const list = $("info-members");
    list.textContent = "";
    if (showMembers) {
      const n = chat.members.size;
      $("info-members-title").textContent =
        n + " " + plural(n, "участник", "участника", "участников");
      for (const [id, m] of chat.members) {
        const li = document.createElement("li");
        li.className = "member-item";
        const av = document.createElement("div");
        av.className = "avatar sm";
        paintAvatar(av, m.avatar_url, m.username);
        const meta = document.createElement("div");
        meta.className = "meta";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = m.username + (id === state.me.id ? " (вы)" : "");
        meta.append(name);
        if (m.role === "owner" || m.role === "admin") {
          const sub = document.createElement("div");
          sub.className = "sub";
          sub.textContent = m.role === "owner" ? "владелец" : "админ";
          meta.append(sub);
        }
        li.append(av, meta);
        list.append(li);
      }
    }

    $("info-leave").textContent =
      chat.kind === "channel" ? "Отписаться" : chat.kind === "group" ? "Покинуть группу" : "Удалить чат";
  }

  $("open-info").addEventListener("click", () => {
    if (!state.activeChat) return;
    fillInfo(state.activeChat);
    openDialog("dlg-info");
  });

  $("info-avatar-btn").addEventListener("click", () => {
    if (state.activeChat) pickAvatar(state.activeChat);
  });

  $("info-mute").addEventListener("change", (e) => {
    const id = state.activeChat;
    if (!id) return;
    if (e.target.checked) state.muted.add(id);
    else state.muted.delete(id);
    saveMuted();
    renderChatList();
    updateBadge();
  });

  $("info-edit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = state.activeChat;
    if (!id) return;
    const err = $("info-error");
    show(err, false);

    const { error } = await sb.rpc("update_chat", {
      p_chat_id: id,
      p_title: $("info-edit-title").value.trim(),
      p_description: $("info-edit-desc").value.trim(),
    });
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    await loadChats();
    fillInfo(id);
  });

  $("info-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = state.activeChat;
    if (!id) return;
    const err = $("info-error");
    show(err, false);

    const names = parseNames($("info-add-names").value);
    if (!names.length) return;

    const { error } = await sb.rpc("add_members", { p_chat_id: id, p_usernames: names });
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    $("info-add-names").value = "";
    await loadChats();
    fillInfo(id);
  });

  $("info-leave").addEventListener("click", async () => {
    const id = state.activeChat;
    const chat = id && state.chats.get(id);
    if (!chat) return;
    if (!window.confirm("Точно? " + $("info-leave").textContent + ": «" + chat.name + "»")) return;

    const err = $("info-error");
    show(err, false);
    const { error } = await sb.rpc("leave_chat", { p_chat_id: id });
    if (error) {
      err.textContent = friendlyError(error);
      show(err, true);
      return;
    }
    $("dlg-info").close();
    await loadChats();
  });

  // ---------- Запуск ----------

  let entering = false;

  async function enterApp(session) {
    if (entering || state.me) return;
    entering = true;
    try {
      await loadProfile(session.user);
         
          // Инициализация звонков
    if (window.LumoCalls) {
      LumoCalls.init({
        supabase: sb,
        userId: state.me.id,
        userName: state.me.username,
        livekitUrl: 'wss://chat-k4dq8vjv.livekit.cloud'
      });
    }
      await loadChats();
      subscribeRealtime();
      show($("auth-screen"), false);
      show($("app"), true);
    } catch (err) {
      console.error(err);
      state.me = null;
      $("auth-error").textContent =
        "Не удалось загрузить данные. Убедитесь, что в Supabase выполнены supabase/schema.sql и supabase/migration_v2.sql.";
      show($("auth-error"), true);
      show($("auth-screen"), true);
    } finally {
      entering = false;
    }
  }
    
  function leaveApp() {
    if (state.channel) {
      sb.removeChannel(state.channel);
      state.channel = null;
    }
    state.me = null;
    state.activeChat = null;
    state.chats = new Map();
    document.title = "Lumo";
    show($("app"), false);
    show($("chat-view"), false);
    show($("chat-placeholder"), true);
    $("app").classList.remove("chat-open");
    document.querySelectorAll("dialog.dlg[open]").forEach((d) => d.close());
    $("password").value = "";
    show($("auth-screen"), true);
  }

  renderAuthMode();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || !session) {
      leaveApp();
    } else if (event === "SIGNED_IN" && !state.me) {
      // setTimeout: нельзя вызывать запросы Supabase прямо внутри колбэка
      setTimeout(() => enterApp(session), 0);
    }
  });

  sb.auth.getSession().then(({ data }) => {
    if (data.session) {
      enterApp(data.session);
    } else {
      show($("auth-screen"), true);
    }
  });
})();

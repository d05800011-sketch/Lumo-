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
    me: null,            // { id, username }
    chats: new Map(),    // chatId -> { id, name, last: {body, created_at} | null }
    activeChat: null,
    shownIds: new Set(), // id сообщений, уже нарисованных в открытом чате
    channel: null,
    signup: false,
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

  function friendlyError(err) {
    const m = (err && err.message) || String(err);
    if (/Invalid login credentials/i.test(m)) return "Неверный email или пароль.";
    if (/User already registered/i.test(m)) return "Этот email уже зарегистрирован.";
    if (/Password should be/i.test(m)) return "Пароль слишком короткий (минимум 6 символов).";
    if (/duplicate key|profiles_username_key/i.test(m)) return "Это имя пользователя занято.";
    if (/Email not confirmed/i.test(m)) return "Подтвердите email по ссылке из письма.";
    if (/Пользователь не найден|Нельзя написать самому себе/.test(m)) return m;
    return m;
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
          $("auth-info").textContent =
            "Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.";
          show($("auth-info"), true);
          state.signup = false;
          renderAuthMode();
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
      .select("id, username")
      .eq("id", user.id)
      .single();
    if (error) throw error;
    state.me = data;
    $("me-name").textContent = "@" + data.username;
  }

  async function loadChats() {
    // Все участники всех моих чатов (RLS отдаёт только мои чаты)
    const { data: members, error } = await sb
      .from("chat_members")
      .select("chat_id, user_id, profiles(username)");
    if (error) throw error;

    const byChat = new Map();
    for (const m of members) {
      if (!byChat.has(m.chat_id)) byChat.set(m.chat_id, []);
      byChat.get(m.chat_id).push(m);
    }

    // Последние сообщения
    const { data: recent, error: mErr } = await sb
      .from("messages")
      .select("chat_id, body, created_at")
      .order("created_at", { ascending: false })
      .limit(300);
    if (mErr) throw mErr;
    const lastByChat = new Map();
    for (const m of recent) {
      if (!lastByChat.has(m.chat_id)) lastByChat.set(m.chat_id, m);
    }

    state.chats.clear();
    for (const [chatId, list] of byChat) {
      const others = list
        .filter((m) => m.user_id !== state.me.id)
        .map((m) => (m.profiles && m.profiles.username) || "?");
      state.chats.set(chatId, {
        id: chatId,
        name: others.length ? others.join(", ") : "Избранное",
        last: lastByChat.get(chatId) || null,
      });
    }
    renderChatList();
  }

  // ---------- Список чатов ----------

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
      li.className = "chat-item" + (chat.id === state.activeChat ? " active" : "");
      li.dataset.id = chat.id;

      const av = document.createElement("div");
      av.className = "avatar";
      av.textContent = initial(chat.name);

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = chat.name;
      const prev = document.createElement("div");
      prev.className = "preview";
      prev.textContent = chat.last ? chat.last.body : "Нет сообщений";
      meta.append(name, prev);

      li.append(av, meta);
      li.addEventListener("click", () => openChat(chat.id));
      list.append(li);
    }
  }

  // ---------- Открытый чат ----------

  async function openChat(chatId) {
    const chat = state.chats.get(chatId);
    if (!chat) return;

    state.activeChat = chatId;
    state.shownIds.clear();
    renderChatList();

    show($("chat-placeholder"), false);
    show($("chat-view"), true);
    $("app").classList.add("chat-open");
    $("chat-title").textContent = chat.name;
    $("chat-avatar").textContent = initial(chat.name);
    $("messages").textContent = "";

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
    $("message-input").focus();
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

    const box = $("messages");

    // Разделитель по дням
    const prevDay = box.dataset.lastDay;
    const day = new Date(msg.created_at).toDateString();
    if (prevDay !== day) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = fmtDay(msg.created_at);
      box.append(sep);
      box.dataset.lastDay = day;
    }

    const el = document.createElement("div");
    el.className = "msg" + (msg.sender_id === state.me.id ? " mine" : "");
    el.textContent = msg.body;
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

  // ---------- Realtime ----------

  function subscribeRealtime() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb
      .channel("lumo-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => onNewMessage(payload.new)
      )
      .subscribe();
  }

  async function onNewMessage(msg) {
    // Чат, которого у нас ещё нет в списке (нам написали впервые)
    if (!state.chats.has(msg.chat_id)) {
      await loadChats();
    }
    const chat = state.chats.get(msg.chat_id);
    if (chat) {
      chat.last = { body: msg.body, created_at: msg.created_at };
    }
    if (msg.chat_id === state.activeChat) {
      const box = $("messages");
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      appendMessage(msg);
      if (nearBottom || msg.sender_id === state.me.id) scrollDown();
    }
    renderChatList();
  }

  // ---------- Новый чат ----------

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

  // ---------- Запуск ----------

  let entering = false;

  async function enterApp(session) {
    if (entering || state.me) return;
    entering = true;
    try {
      await loadProfile(session.user);
      await loadChats();
      subscribeRealtime();
      show($("auth-screen"), false);
      show($("app"), true);
    } catch (err) {
      console.error(err);
      $("auth-error").textContent =
        "Не удалось загрузить данные. Убедитесь, что выполнили supabase/schema.sql.";
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
    state.chats.clear();
    show($("app"), false);
    show($("chat-view"), false);
    show($("chat-placeholder"), true);
    $("app").classList.remove("chat-open");
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
      if (!state.me) enterApp(data.session);
    } else {
      show($("auth-screen"), true);
    }
  });
})();

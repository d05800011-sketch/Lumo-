// Supabase Edge Function: livekit-token
// Выдаёт авторизованному пользователю токен для входа в комнату LiveKit.
// Секреты (Project Settings -> Edge Functions -> Secrets):
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET
// SUPABASE_URL и SUPABASE_ANON_KEY Supabase подставляет сам.

import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1. Кто звонит: проверяем сессию Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return json({ error: "unauthorized" }, 401);

    // 2. Имя комнаты: call_<uuid>
    const { room } = await req.json();
    if (typeof room !== "string" || !/^call_[0-9a-f-]{36}$/.test(room)) {
      return json({ error: "bad room" }, 400);
    }

    // 3. Выдаём токен на 1 час
    const at = new AccessToken(
      Deno.env.get("LIVEKIT_API_KEY")!,
      Deno.env.get("LIVEKIT_API_SECRET")!,
      { identity: user.id, ttl: "1h" },
    );
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    return json({ token: await at.toJwt() });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

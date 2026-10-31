-- Lumo: схема базы данных для Supabase
-- Выполните целиком в Supabase -> SQL Editor -> New query -> Run

-- Профили пользователей
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 24),
  created_at timestamptz not null default now()
);

-- Чаты (личные; групповые добавляются через chat_members)
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  title text,
  is_group boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Участники чатов
create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

-- Сообщения
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_created_idx
  on public.messages (chat_id, created_at);

-- Вспомогательная функция: состоит ли текущий пользователь в чате
create or replace function public.is_chat_member(p_chat_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = p_chat_id and user_id = auth.uid()
  );
$$;

-- Автосоздание профиля при регистрации
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Создание личного чата по имени пользователя (возвращает id чата)
create or replace function public.start_direct_chat(p_username text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other uuid;
  v_chat uuid;
begin
  select id into v_other from public.profiles where username = p_username;
  if v_other is null then
    raise exception 'Пользователь не найден';
  end if;
  if v_other = auth.uid() then
    raise exception 'Нельзя написать самому себе';
  end if;

  -- Уже есть личный чат с этим человеком?
  select c.id into v_chat
  from public.chats c
  join public.chat_members a on a.chat_id = c.id and a.user_id = auth.uid()
  join public.chat_members b on b.chat_id = c.id and b.user_id = v_other
  where c.is_group = false
  limit 1;

  if v_chat is not null then
    return v_chat;
  end if;

  insert into public.chats (is_group, created_by)
  values (false, auth.uid())
  returning id into v_chat;

  insert into public.chat_members (chat_id, user_id)
  values (v_chat, auth.uid()), (v_chat, v_other);

  return v_chat;
end;
$$;

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles are readable by signed-in users" on public.profiles;
create policy "profiles are readable by signed-in users"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid());

drop policy if exists "members read their chats" on public.chats;
create policy "members read their chats"
  on public.chats for select
  to authenticated
  using (public.is_chat_member(id));

drop policy if exists "members read membership" on public.chat_members;
create policy "members read membership"
  on public.chat_members for select
  to authenticated
  using (public.is_chat_member(chat_id));

drop policy if exists "members read messages" on public.messages;
create policy "members read messages"
  on public.messages for select
  to authenticated
  using (public.is_chat_member(chat_id));

drop policy if exists "members send messages" on public.messages;
create policy "members send messages"
  on public.messages for insert
  to authenticated
  with check (sender_id = auth.uid() and public.is_chat_member(chat_id));

-- Realtime для сообщений
alter publication supabase_realtime add table public.messages;

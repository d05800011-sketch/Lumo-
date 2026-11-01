-- Lumo v2: группы, каналы, аватарки, непрочитанные сообщения
-- Выполните ПОСЛЕ schema.sql: Supabase -> SQL Editor -> New query -> Run
-- Скрипт можно запускать повторно, ничего не сломается.

-- ============ Новые колонки ============

alter table public.profiles
  add column if not exists avatar_url text;

alter table public.chats
  add column if not exists kind text not null default 'direct',
  add column if not exists avatar_url text,
  add column if not exists description text,
  add column if not exists handle text;

alter table public.chat_members
  add column if not exists role text not null default 'member',
  add column if not exists last_read_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chats_kind_check') then
    alter table public.chats
      add constraint chats_kind_check check (kind in ('direct', 'group', 'channel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chats_handle_format') then
    alter table public.chats
      add constraint chats_handle_format check (handle is null or handle ~ '^[a-z0-9_]{4,32}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_members_role_check') then
    alter table public.chat_members
      add constraint chat_members_role_check check (role in ('owner', 'admin', 'member'));
  end if;
end $$;

update public.chats set kind = 'group' where is_group = true and kind = 'direct';

create unique index if not exists chats_handle_key
  on public.chats (handle) where handle is not null;

-- ============ Проверка прав ============

-- Роль текущего пользователя в чате
create or replace function public.chat_role(p_chat_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.chat_members
  where chat_id = p_chat_id and user_id = auth.uid();
$$;

-- Можно ли писать: в группах и личных все участники, в каналах только owner/admin
create or replace function public.can_post(p_chat_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.chat_id = p_chat_id
      and m.user_id = auth.uid()
      and (c.kind <> 'channel' or m.role in ('owner', 'admin'))
  );
$$;

drop policy if exists "members send messages" on public.messages;
create policy "members send messages"
  on public.messages for insert
  to authenticated
  with check (sender_id = auth.uid() and public.can_post(chat_id));

-- ============ Группы ============

create or replace function public.create_group(p_title text, p_usernames text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
  v_missing text;
begin
  if p_title is null or char_length(trim(p_title)) < 1 then
    raise exception 'Укажите название группы';
  end if;

  select string_agg(u, ', ') into v_missing
  from unnest(coalesce(p_usernames, '{}')) as u
  where not exists (select 1 from public.profiles p where p.username = u);
  if v_missing is not null then
    raise exception 'Не найдены пользователи: %', v_missing;
  end if;

  insert into public.chats (title, is_group, kind, created_by)
  values (left(trim(p_title), 64), true, 'group', auth.uid())
  returning id into v_chat;

  insert into public.chat_members (chat_id, user_id, role)
  values (v_chat, auth.uid(), 'owner');

  insert into public.chat_members (chat_id, user_id)
  select v_chat, p.id
  from public.profiles p
  where p.username = any(coalesce(p_usernames, '{}'))
    and p.id <> auth.uid()
  on conflict do nothing;

  return v_chat;
end;
$$;

-- ============ Каналы ============

create or replace function public.create_channel(
  p_title text,
  p_handle text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
  v_handle text := lower(trim(both '@' from trim(coalesce(p_handle, ''))));
begin
  if p_title is null or char_length(trim(p_title)) < 1 then
    raise exception 'Укажите название канала';
  end if;
  if v_handle !~ '^[a-z0-9_]{4,32}$' then
    raise exception 'Адрес канала: 4-32 символа, латиница, цифры и _';
  end if;

  insert into public.chats (title, description, handle, is_group, kind, created_by)
  values (
    left(trim(p_title), 64),
    nullif(left(trim(coalesce(p_description, '')), 300), ''),
    v_handle, true, 'channel', auth.uid()
  )
  returning id into v_chat;

  insert into public.chat_members (chat_id, user_id, role)
  values (v_chat, auth.uid(), 'owner');

  return v_chat;
exception
  when unique_violation then
    raise exception 'Такой адрес канала уже занят';
end;
$$;

create or replace function public.join_channel(p_handle text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
begin
  select id into v_chat
  from public.chats
  where kind = 'channel'
    and handle = lower(trim(both '@' from trim(coalesce(p_handle, ''))));
  if v_chat is null then
    raise exception 'Канал не найден';
  end if;

  insert into public.chat_members (chat_id, user_id)
  values (v_chat, auth.uid())
  on conflict do nothing;

  return v_chat;
end;
$$;

create or replace function public.search_channels(p_query text)
returns table (
  id uuid,
  title text,
  handle text,
  description text,
  avatar_url text,
  members bigint,
  joined boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id, c.title, c.handle, c.description, c.avatar_url,
    (select count(*) from public.chat_members m where m.chat_id = c.id) as members,
    exists (
      select 1 from public.chat_members m
      where m.chat_id = c.id and m.user_id = auth.uid()
    ) as joined
  from public.chats c
  where c.kind = 'channel'
    and (
      c.handle like lower(trim(both '@' from trim(coalesce(p_query, '')))) || '%'
      or c.title ilike '%' || trim(coalesce(p_query, '')) || '%'
    )
  order by members desc
  limit 20;
$$;

-- ============ Участники и настройки ============

create or replace function public.add_members(p_chat_id uuid, p_usernames text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text;
begin
  if coalesce(public.chat_role(p_chat_id), '') not in ('owner', 'admin') then
    raise exception 'Недостаточно прав';
  end if;
  if not exists (
    select 1 from public.chats where id = p_chat_id and kind in ('group', 'channel')
  ) then
    raise exception 'В личный чат нельзя добавлять участников';
  end if;

  select string_agg(u, ', ') into v_missing
  from unnest(coalesce(p_usernames, '{}')) as u
  where not exists (select 1 from public.profiles p where p.username = u);
  if v_missing is not null then
    raise exception 'Не найдены пользователи: %', v_missing;
  end if;

  insert into public.chat_members (chat_id, user_id)
  select p_chat_id, p.id
  from public.profiles p
  where p.username = any(coalesce(p_usernames, '{}'))
  on conflict do nothing;
end;
$$;

create or replace function public.update_chat(
  p_chat_id uuid,
  p_title text default null,
  p_description text default null,
  p_avatar_url text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(public.chat_role(p_chat_id), '') not in ('owner', 'admin') then
    raise exception 'Недостаточно прав';
  end if;

  update public.chats
  set
    title = coalesce(nullif(left(trim(p_title), 64), ''), title),
    description = case
      when p_description is null then description
      else nullif(left(trim(p_description), 300), '')
    end,
    avatar_url = coalesce(p_avatar_url, avatar_url)
  where id = p_chat_id and kind in ('group', 'channel');
end;
$$;

create or replace function public.leave_chat(p_chat_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_owner boolean;
begin
  select role = 'owner' into v_was_owner
  from public.chat_members
  where chat_id = p_chat_id and user_id = auth.uid();

  delete from public.chat_members
  where chat_id = p_chat_id and user_id = auth.uid();

  if not exists (select 1 from public.chat_members where chat_id = p_chat_id) then
    delete from public.chats where id = p_chat_id;
  elsif coalesce(v_was_owner, false) then
    -- Передаём владение самому раннему участнику
    update public.chat_members
    set role = 'owner'
    where chat_id = p_chat_id
      and user_id = (
        select user_id from public.chat_members
        where chat_id = p_chat_id
        order by joined_at
        limit 1
      );
  end if;
end;
$$;

-- ============ Непрочитанные ============

create or replace function public.mark_read(p_chat_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.chat_members
  set last_read_at = now()
  where chat_id = p_chat_id and user_id = auth.uid();
$$;

create or replace function public.unread_counts()
returns table (chat_id uuid, unread bigint)
language sql
stable
as $$
  select m.chat_id, count(msg.id) as unread
  from public.chat_members m
  left join public.messages msg
    on msg.chat_id = m.chat_id
   and msg.created_at > m.last_read_at
   and msg.sender_id <> auth.uid()
  where m.user_id = auth.uid()
  group by m.chat_id;
$$;

-- ============ Аватарки (Supabase Storage) ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "avatars are public" on storage.objects;
create policy "avatars are public"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "users upload own avatars" on storage.objects;
create policy "users upload own avatars"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete own avatars" on storage.objects;
create policy "users delete own avatars"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============ Realtime: новые участники ============

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_members'
  ) then
    alter publication supabase_realtime add table public.chat_members;
  end if;
end $$;

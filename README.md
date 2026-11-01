# Lumo

Простой веб-мессенджер с сообщениями в реальном времени. Работает бесплатно: фронтенд на чистом HTML/JS (без сборки), бэкенд на [Supabase](https://supabase.com), хостинг на GitHub Pages.

## Возможности

- Регистрация и вход по email и паролю
- Личные чаты по имени пользователя
- Сообщения мгновенно, без перезагрузки страницы
- Адаптивный интерфейс: работает и на телефоне
- Безопасность на уровне базы (Row Level Security): читать чат могут только его участники

## Запуск за 5 шагов

1. **Создайте проект Supabase** на [supabase.com](https://supabase.com) (бесплатный тариф).
2. **Создайте таблицы:** в проекте откройте *SQL Editor → New query*, вставьте содержимое [`supabase/schema.sql`](supabase/schema.sql) и нажмите *Run*.
3. **Скопируйте ключи:** *Project Settings → API*. Нужны `Project URL` и публичный ключ `anon` (не `service_role`!).
4. **Настройте конфиг:**
   ```bash
   cp config.example.js config.js
   ```
   и впишите URL и ключ в `config.js`.
5. **Откройте приложение:**
   ```bash
   python3 -m http.server 8000
   ```
   и перейдите на http://localhost:8000.

> Для быстрых тестов в Supabase можно отключить подтверждение email: *Authentication → Providers → Email → Confirm email*.

## Публикация на GitHub Pages

Файл `config.js` по умолчанию не попадает в git (см. `.gitignore`). Публичный ключ `anon` не секретный: он и так виден в браузере, а доступ защищает RLS. Поэтому для Pages его можно закоммитить:

```bash
git add -f config.js
git commit -m "Add public Supabase config"
git push
```

Затем: *Settings → Pages → Deploy from a branch → main / (root)*. Сайт появится по адресу `https://<ваш-логин>.github.io/lumo/`.

В Supabase добавьте этот адрес в *Authentication → URL Configuration → Site URL*.

## Структура

```
index.html            разметка
style.css             оформление
app.js                логика: вход, чаты, realtime
config.example.js     пример конфигурации
supabase/schema.sql   таблицы, политики безопасности, функции
```

## Что дальше

- Групповые чаты (таблицы уже готовы, нужен интерфейс)
- Статусы «онлайн» и «прочитано»
- Отправка изображений через Supabase Storage
- Push-уведомления и установка как PWA
- Сквозное шифрование

## Ограничения бесплатного тарифа

Supabase Free подходит для прототипа и небольшой аудитории. При росте нагрузки придётся перейти на платный план или развернуть свой сервер.

## Лицензия

MIT

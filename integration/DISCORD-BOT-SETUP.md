# Создание Discord-бота и подключение

Пошагово: создать приложение-бота, получить токен, включить интенты, пригласить на сервер и запустить.

## Шаг 1. Создать приложение и бота

1. Открой [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → задай имя (например `ГСУ-СК`).
3. Слева **Bot** → при необходимости **Add Bot**.
4. **Reset Token → Copy** — это `DISCORD_BOT_TOKEN`. Токен показывается один раз, вставь сразу в `.env`. Если он засветился — сбрось через **Reset Token**.

## Шаг 2. Включить интенты

**Bot → Privileged Gateway Intents:**
- ✅ **MESSAGE CONTENT INTENT** — чтобы бот видел текст сообщений.
- ✅ **SERVER MEMBERS INTENT** — чтобы упоминать сотрудников по нику при публикации состава.

`Guilds`, `GuildMessages`, `GuildMessageReactions` — не привилегированные, отдельно включать не нужно.

## Шаг 3. Пригласить на сервер

1. **OAuth2 → URL Generator**:
   - **Scopes:** `bot`;
   - **Bot Permissions:** `View Channel`, `Read Message History`, `Send Messages`, `Embed Links`, `Add Reactions`.
2. Скопируй ссылку, открой, выбери сервер → добавь бота.

Модераторские права (`Administrator`, `Manage Roles`, `Manage Messages`) не нужны.

## Шаг 4. Узнать ID каналов

1. Discord: **Настройки → Расширенные → Режим разработчика** (включить).
2. ПКМ по каналу → **Копировать ID канала**.

Боевые каналы уже прописаны в `src/channelRules.js` — на бою `DISCORD_CHANNEL_IDS` оставь пустым. Заполняй его ID только для теста на другом сервере.

## Шаг 5. Запуск

```bash
cd ~/Desktop/dsbot
cp .env.example .env      # заполнить значения
docker compose up -d      # на сервере
```

Минимум в `.env`:
```env
DISCORD_BOT_TOKEN=...
BOT_API_URL=https://sledak-rmrp.ru/api/bot
BOT_API_SECRET=...        # та же строка в Vercel-переменных сайта
BOT_UNIT=arbat
OCR_ENABLED=false
APP_RELEASE=<полный SHA развёрнутого коммита>
REPORT_CHANNEL_ID=...
PGSKO_REPORT_CHANNEL_ID=...
ACT_REVIEW_CHANNEL_ID=...
DISCIPLINE_CHANNEL_ID=...
KSO_TASKS_CHANNEL_ID=...
CASES_CHANNEL_ID=...
ROSTER_CHANNEL_ID=...
PGSKO_APPROVER_ROLE_ID=... # роль руководства, чья ✅ засчитывает ПГСкО
PROSECUTOR_ROLE_ID=...     # роль прокуратуры, чья ✅ архивирует дело
```

## Шаг 6. Проверка

Напиши в канале сообщение в рабочем формате (например распределение дела с номером `02-ОП-4215`). Бот залогирует «Captured message», запишет событие в `logs/` и отправит его на портал через `/api/bot`.

# DuoPlan

Приложение для пар: общие планы, значимые даты, общий дневник и вишлисты.

## Архитектура

| Путь | Назначение |
|---|---|
| `worker.js` | Production backend: API, Telegram webhook, авторизация initData |
| `migrations/` | Схема Cloudflare D1 |
| `public/` | Лендинг, Mini App и страница активации |
| `duoplan/` | Локальный/legacy Python-бот (aiogram + SQLite) |
| `tests/` | pytest-тесты Python-части |

**Production:** Cloudflare Worker + D1 + Telegram Mini App.  
**Python-бот:** отдельная локальная поверхность. Он не должен работать одновременно
с Worker на одном `BOT_TOKEN`: webhook и long polling конфликтуют (`409`). При
старте Python-бот проверяет `getWebhookInfo` и отказывается запускать polling,
если webhook уже установлен.

Схема общих таблиц задаётся только миграциями D1 и `ensureSchema` в `worker.js`;
`duoplan/db/schema.py` обязан совпадать с ними по составу колонок (расхождение
ловит `tests/test_schema_parity.py`). Ритуал дня считается одной и той же
функцией на обеих поверхностях — `dailyAction()` в `worker.js` и
`_daily_action()` в `duoplan/services.py`; паритет держат
`tests/test_daily_parity.*` на общих векторах из `tests/fixtures/daily_actions.json`.

Публичный адрес: `https://duoplan.stacheight.workers.dev`.

## Cloudflare

В `wrangler.jsonc` уже указаны Worker, D1 binding, assets и production origin.

Секреты Worker:

| Имя | Назначение |
|---|---|
| `BOT_TOKEN` | Токен @BotFather |
| `WEBHOOK_SECRET` | Случайная строка для проверки Telegram webhook |
| `SETUP_TOKEN` | Необязательный отдельный секрет для `/api/setup` |

Активация:

1. Задайте секреты в **Workers & Pages → duoplan → Settings → Variables and Secrets**.
2. Откройте `/setup` (или `/setup.html`), введите `SETUP_TOKEN` либо `BOT_TOKEN`.
3. Страница создаст/обновит таблицы D1, установит webhook и кнопку Mini App.

### Telegram: кнопка «ОТКРЫТЬ» в списке чатов (Main Mini App)

Синяя кнопка «ОТКРЫТЬ» рядом с чатом бота в списке чатов — это **Main Mini App**.
Кодом она не ставится, только вручную в @BotFather:

1. `/mybots` → выбрать бота → **Bot Settings → Configure Mini App → Main Mini App**.
2. Указать `https://duoplan.stacheight.workers.dev/app` (совпадает с `APP_ORIGIN` в `wrangler.jsonc`).
3. По желанию загрузить иконку и скриншоты — они покажутся в профиле бота.

Проверка: `POST /api/setup` отдаёт `has_main_web_app: true` (из `getMe`), а в
списке чатов у бота появляется кнопка «ОТКРЫТЬ». Меню-кнопка у поля ввода
(`setChatMenuButton` с web_app) ставится кодом на шаге 3 «Активации».

Полный экран и кнопка «на главный экран» — клиентские API Bot API 8.0+
(`requestFullscreen`, `addToHomeScreen`), фронтенд вызывает их сам; на старых
клиентах и Telegram Desktop приложение просто остаётся в оконном режиме.

Локальная проверка Worker:

Примечание: не запускайте `wrangler d1 migrations apply` на базе, уже инициализированной через `/setup` — схема в production управляется Worker'ом.

```bash
wrangler d1 migrations apply duoplan --local
wrangler dev --local --port 8788
```

Для локального dev создайте `.dev.vars` (он в `.gitignore`) с тестовыми
`BOT_TOKEN`, `WEBHOOK_SECRET`, `SETUP_TOKEN`, `APP_ORIGIN`.

Перенос локальных данных в production D1:

```bash
.venv/Scripts/python.exe scripts/export_sqlite_to_d1.py
wrangler d1 execute duoplan --remote --file data/duoplan-d1-import.sql
```

Перед импортом сделайте резервную копию D1: скрипт использует `INSERT OR REPLACE`.

Импорт предназначен для пустой или подготовленной целевой D1: при совпадении ID существующие записи могут быть заменены каскадно. Для объединения с работающей базой сначала проверьте конфликты ID.

## Python-бот

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
cp .env.example .env          # заполните BOT_TOKEN
.venv/Scripts/python.exe -m duoplan
```

Переменные: `BOT_TOKEN`, `DB_PATH`, `TZ`, `BOT_NAME`, `FSM_TTL`
(см. `.env.example`). Секреты хранятся только в `.env`, он в `.gitignore`.

База по умолчанию — `data/duoplan.db`. Версия схемы хранится в
`PRAGMA user_version`, миграции идемпотентны и не удаляют существующие данные.
FSM-состояния хранятся в SQLite с TTL.

## Проверки

```bash
.venv/Scripts/python.exe -m pytest
node --test "tests/*.test.mjs"
node --check worker.js
node --check public/app.js
wrangler deploy --dry-run
```

Тесты покрывают гонку входа в пару, запрет входа владельцу пустой пары, двойное
начисление XP, валидацию, часовой пояс, FSM-медиа и миграции.

## Версия

Версия Python-пакета задаётся в `duoplan/__init__.py`; `pyproject.toml` читает её
через `dynamic = ["version"]`. Версия Worker — `APP_VERSION` в `worker.js`.

## Что выяснилось

1. **Кнопка «ОТКРЫТЬ» в списке чатов** (как у Ottership) — это **Main Mini App**, задаётся только через @BotFather, кодом не ставится. Нужный код в проекте уже есть: `setChatMenuButton` с `web_app` уже вызывается в `setup()` (worker.js:920) — она даёт кнопку «DuoPlan» у поля ввода в чате.
2. **Полный экран** — клиентский метод `Telegram.WebApp.requestFullscreen()` (Bot API 8.0, ноя 2024). При этом Telegram прячет свой заголовок — приложению нужно самой нарисовать кнопку закрытия и учесть safe-area.
3. **«На главный экран»** — методы `checkHomeScreenStatus()` / `addToHomeScreen()` и события `homeScreenChecked` / `homeScreenAdded` (тоже Bot API 8.0). Работают на свежих мобильных клиентах Telegram; на неподдерживаемых кнопку просто скрываем.

## Изменения

### 1. Main Mini App — без кода (сделать вручную)
В @BotFather: `/mybots` → @duoplanbot → **Bot Settings → Configure Mini App → Main Mini App** → указать `https://duoplan.stacheight.workers.dev/app` (значение `APP_ORIGIN` из wrangler.jsonc). Там же по желанию — иконка и скриншоты для профиля. После этого в списке чатов и в профиле появится синяя кнопка «ОТКРЫТЬ». Проверка: `getMe` бота вернёт `has_main_web_app: true`.

### 2. Полный экран — `public/app.js`, `public/app.css`
- В блоке инициализации `tg` (app.js:69-76) после `ready()`/`expand()`: вызвать `tg.requestFullscreen?.()`; подписаться на `fullscreenChanged` (вешать на `body` класс `tg-fullscreen`) и `fullscreenFailed` (молча игнорировать — старые клиенты/Desktop останутся в оконном режиме, как сейчас).
- Вызывать `tg.setHeaderColor('bg_color')` и `tg.setBackgroundColor('bg_color')` в `applyTheme()` — в полноэкране заголовок Telegram прозрачный, цвет нужен для контрастного статус-бара.
- CSS-безопасные отступы: в `.top-glass-bar` (top) и в padding основного контента добавить к `env(safe-area-inset-*)` переменные SDK `var(--tg-content-safe-area-inset-*, 0px)` и `var(--tg-safe-area-inset-*, 0px)` — в полноэкранном режиме контент уходит под «челку» и жест-бар.
- Кнопка закрытия: в fullscreen Telegram прячет свой ✕, поэтому добавить свою кнопку-крестик в `.top-glass-left` (сейчас она пустая), видимую только при `body.tg-fullscreen`; клик → `tg.close()`. В оконном режиме остаётся как сейчас (BackButton на вкладках + системный ✕).

### 3. Кнопка «на главный экран» — `public/app.html`, `public/app.js`, `public/app.css`
- В `app.html` в `.top-glass-right` перед пилюлей пары добавить иконную кнопку (📌, стиль `.glass-btn`) — она окажется справа вверху, напротив полноэкранного крестика слева.
- В `app.js`: при старте вызвать `tg.checkHomeScreenStatus(cb)` и подписаться на `homeScreenChecked`; показывать кнопку только при статусе `missed` (поддерживается, ещё не добавлено) или `unknown`; при `unsupported`/`added` — скрыта. Клик → `tg.addToHomeScreen()` (появится системный диалог подтверждения); по `homeScreenAdded` — скрыть кнопку и запомнить в `localStorage`. Вне Telegram (`tg === undefined`) кнопка скрыта.

### 4. Мелочи для проверки — `worker.js`, `tests/`, `README.md`
- В `setup()` (worker.js:887-929) после `setChatMenuButton` добавить вызов `getMe` и вернуть в ответе `has_main_web_app` — удобно сразу видеть, что шаг в BotFather сработал.
- Новый тест `tests/test_setup.test.mjs` в существующем стиле (extract-and-mock): `setup()` вызывает `setChatMenuButton` с web_app-URL `/app` и возвращает `has_main_web_app`.
- В README — короткий раздел про Main Mini App в BotFather (чтобы шаг не потерялся при redeploy).

## Проверка
- `node --check worker.js`, `node --check public/app.js`, `node tests/test_setup.test.mjs` (+ остальные .test.mjs), `python -m pytest`.
- Вручную на телефоне со свежим Telegram: чат-список → «ОТКРЫТЬ»; приложение открылось на весь экран, крестик закрывает; кнопка 📌 видна и добавляет иконку на домашний экран.

Источники: [Mini Apps docs](https://core.telegram.org/bots/webapps), [Main Mini App (MTProto)](https://core.telegram.org/api/bots/webapps), [Bot API changelog](https://core.telegram.org/bots/api-changelog), [блог Telegram про fullscreen и иконки](https://telegram.org/blog/fullscreen-miniapps-and-more)
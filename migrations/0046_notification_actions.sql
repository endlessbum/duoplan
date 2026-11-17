-- Кнопки действий в уведомлениях бота (план duoplan_notification_actions):
-- HTML Widget (Bot API 10.4) для direct_action и нативный callback fallback.
--
-- telegram_action_tokens — одноразовые nonce для Widget: случайный token,
-- привязанный к получателю, типу действия, ресурсу, дате (для препаратов)
-- и статусу (taken/skipped), с TTL и отметкой потребления. В
-- widget_query.data приходит только этот token — бизнес-параметры
-- достаются из строки, а не из недоверенного payload.
--
-- telegram_notification_widgets — реестр отправленных Widget-сообщений:
-- нужен для best-effort обновления chat_data (персональный акцент) через
-- editMessageWidgetData и для проверки message_id при widget_query.
CREATE TABLE IF NOT EXISTS telegram_action_tokens (
  token TEXT PRIMARY KEY,
  tg_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  action_date TEXT,
  status TEXT,
  group_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tg_action_tokens_tg ON telegram_action_tokens(tg_id, expires_at);
CREATE TABLE IF NOT EXISTS telegram_notification_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  chat_data TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_widgets_msg ON telegram_notification_widgets(chat_id, message_id);
CREATE INDEX IF NOT EXISTS idx_tg_widgets_tg ON telegram_notification_widgets(tg_id, status, expires_at);

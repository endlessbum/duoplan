-- Аватары и личное имя партнёра (item 54).
-- photo_url: свежая ссылка на фото профиля Telegram из initData — обновляется
-- при каждом открытии приложения, NULL когда аватара нет.
-- show_avatar: персональный переключатель «Отображение аватара» (1 = фото, 0 = буквы).
-- partner_custom_name: как владелец этой строки видит имя ПАРТНЁРА (видно только ему).
ALTER TABLE users ADD COLUMN photo_url TEXT;
ALTER TABLE users ADD COLUMN show_avatar INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN partner_custom_name TEXT;

-- Переработка «Фло» P0: новый состав общего доступа — категории вместо одного уровня.
-- Календарь (прогноз + даты месячных) — базовая категория, включается самим
-- фактом share_enabled. Отдельные категории: секс, настроение, качество сна
-- (только good/ok/poor), базальная температура. Симптомы, заметки, флоу,
-- препараты и прочие личные поля в партнёрский ответ не попадают никогда.
ALTER TABLE cycle_profiles ADD COLUMN share_sex INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_profiles ADD COLUMN share_mood INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_profiles ADD COLUMN share_sleep INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_profiles ADD COLUMN share_bbt INTEGER NOT NULL DEFAULT 0;
-- Подтверждение нового состава данных: до подтверждения партнёру передаётся
-- только календарная оценка, никакой дневниковой информации.
ALTER TABLE cycle_profiles ADD COLUMN share_confirmed INTEGER NOT NULL DEFAULT 0;
-- Контекст цикла (беременность, лактация, контрацепция и т.п.): JSON-объект
-- булевых флагов; ограничивает применимость календарных прогнозов.
ALTER TABLE cycle_profiles ADD COLUMN context TEXT;
-- Дополнительные сведения о кровотечении (частота смены гигиены,
-- пропитывание, ночная смена): необязательный JSON в дневнике дня.
ALTER TABLE cycle_logs ADD COLUMN bleeding_details TEXT;

-- Бэкфилл из легаси-уровня: уровни periods/symptoms/full раньше передавали
-- секс/настроение/сон/БТ вместе с календарём. Флаги переносим, но
-- share_confirmed остаётся 0: состав деактивируется до подтверждения
-- владелицей (никакого молча расширения; предыдущие уровни «symptoms» и
-- «full» больше не существуют — заметки и симптомы не передаются вовсе).
UPDATE cycle_profiles SET share_sex=1, share_mood=1, share_sleep=1, share_bbt=1, share_confirmed=0
WHERE share_enabled=1 AND share_level IN ('periods','symptoms','full');

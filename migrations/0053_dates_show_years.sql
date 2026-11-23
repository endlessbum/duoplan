-- Показывать количество лет для дней рождения и ежегодных дат.
-- Флаг включается только для birthday или ежегодной даты (recurs=1, monthly=0);
-- для разовых и ежемесячных дат сервер принудительно держит значение 0.
ALTER TABLE dates
ADD COLUMN show_years INTEGER NOT NULL DEFAULT 0;

#!/usr/bin/env bash
# Резервная копия production D1 целиком (пары, планы, даты, дневник, желания,
# настройки, журнал уведомлений). Экспорт дневника приложением — это копия
# только дневника, эта команда выгружает всю базу.
#
# Запуск: bash scripts/backup-d1.sh   (нужен wrangler и вход в аккаунт CF)
#
# Файлы складываются в backups/ (в git не попадают). Храните копии вне
# репозитория и вне машины, содержащей secrets: дамп включает все личные
# записи. Раз в месяц проверяйте восстановление: создайте отдельную базу
# (npx wrangler d1 create duoplan-restore) и залейте дамп в неё:
#   npx wrangler d1 execute duoplan-restore --remote --file=<дамп.sql>
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
DUMP_FILE="backups/duoplan-$STAMP.sql"
npx wrangler d1 export duoplan --remote --output "$DUMP_FILE"
echo "Готово: $DUMP_FILE"

# SQL-дамп нельзя открывать как файл базы SQLite: sqlite3 в этом случае
# проверяет не его содержимое, а мусор вместо БД. Импортируем дамп во временную базу,
# проверяем уже её и удаляем временный файл в любом исходе.
if command -v sqlite3 >/dev/null 2>&1; then
  TMP_DB="$(mktemp "${TMPDIR:-/tmp}/duoplan-restore-XXXXXX")"
  trap 'rm -f "$TMP_DB"' EXIT
  sqlite3 "$TMP_DB" < "$DUMP_FILE"
  CHECK="$(sqlite3 "$TMP_DB" 'PRAGMA integrity_check;')"
  if [ "$CHECK" != "ok" ]; then
    echo "Ошибка: целостность дампа не подтверждена: $CHECK" >&2
    exit 1
  fi
  # Наличие ключевых таблиц: пустой дамп тоже проходит integrity_check.
  for TABLE in users pairs movies movie_groups movie_group_items; do
    sqlite3 "$TMP_DB" "SELECT count(*) FROM $TABLE;" >/dev/null
  done
  echo "Проверка целостности: ok (дамп импортирован во временную SQLite-базу)"
else
  echo "Проверка целостности пропущена: sqlite3 не найден. Восстановите дамп в отдельную D1-базу по инструкции в шапке файла — только после этого считайте копию проверенной."
fi

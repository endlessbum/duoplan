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
npx wrangler d1 export duoplan --remote --output "backups/duoplan-$STAMP.sql"
echo "Готово: backups/duoplan-$STAMP.sql"
echo "Проверка целостности: sqlite3 backups/duoplan-$STAMP.sql 'PRAGMA integrity_check;' (импорт в отдельную базу см. в шапке файла)"

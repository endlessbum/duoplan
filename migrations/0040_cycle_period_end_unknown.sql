-- Фло: «конец неизвестен» для исторических периодов. end_date=NULL теперь
-- означает либо «менструация идёт» (end_unknown=0), либо «исторический
-- период, дату окончания не помним» (end_unknown=1). Паритет с
-- duoplan/db/schema.py и worker.js ensureSchema.
ALTER TABLE cycle_periods ADD COLUMN end_unknown INTEGER NOT NULL DEFAULT 0;

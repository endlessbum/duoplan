-- PD-WISHES-001: личные желания видны только автору; шеринг — явное действие.
ALTER TABLE wishes ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wishes ADD COLUMN shared_at INTEGER;

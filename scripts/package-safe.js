#!/usr/bin/env node
// Безопасная упаковка проекта DuoPlan. Исключает секреты, базы данных и временные файлы.
// Используется точный allowlist: в архив попадают только разрешённые пути.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const zipName = "DuoPlan.zip";

const allowedTopLevel = [
  ".env.example",
  ".gitignore",
  "README.md",
  "requirements.txt",
  "pyproject.toml",
  "worker.js",
  "wrangler.jsonc",
  "public",
  "duoplan",
  "tests",
  "scripts",
  "migrations",
];

const forbiddenNames = new Set([
  ".env",
  ".dev.vars",
  "duoplan.db",
  ".pytest_cache",
  "__pycache__",
  ".workbuddy-ai",
  ".venv",
  "node_modules",
  ".wrangler",
  ".kiro",
]);

const forbiddenExt = [".pyc", ".db", ".db-wal", ".db-shm", ".db-journal"];

function isForbidden(rel) {
  const parts = rel.split(/[\\/]/);
  for (const part of parts) {
    if (forbiddenNames.has(part)) return true;
  }
  for (const ext of forbiddenExt) {
    if (rel.endsWith(ext)) return true;
  }
  if (rel === ".env") return true;
  return false;
}

function collectAllowed(dir, base = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    const rel = base || path.basename(dir);
    if (!isForbidden(rel)) out.push(rel);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (isForbidden(rel)) continue;
    if (entry.isDirectory()) {
      out.push(...collectAllowed(full, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// Проверяем, что .env не попадёт в архив (он не в allowlist).
const files = [];
for (const top of allowedTopLevel) {
  files.push(...collectAllowed(path.join(root, top), top));
}

// Проверка на запрещённые элементы.
const forbiddenFound = files.filter(isForbidden);
if (forbiddenFound.length) {
  console.error("❌ Найдены запрещённые файлы:");
  for (const f of forbiddenFound) console.error("  " + f);
  process.exit(1);
}

// Создаём ZIP через Python zipfile (zip/unzip могут отсутствовать).
const listFile = path.join(root, ".package-list.tmp");
fs.writeFileSync(listFile, files.join("\n"), "utf8");

const python = process.platform === "win32" ? "python" : "python3";
const script = `
import zipfile, os
root = os.getcwd()
out = ${JSON.stringify(zipName)}
files = [l.strip() for l in open(${JSON.stringify(listFile)}).read().splitlines() if l.strip()]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(os.path.join(root, f), f)
print("ok", len(files))
`;

try {
  execFileSync(python, ["-c", script], { stdio: "inherit", cwd: root });
} catch (e) {
  console.error("❌ Ошибка создания ZIP:", e.message);
  try { fs.unlinkSync(listFile); } catch {}
  process.exit(1);
}
try { fs.unlinkSync(listFile); } catch {}

// Проверяем содержимое архива.
const checkScript = `
import zipfile, sys
bad = []
with zipfile.ZipFile(${JSON.stringify(zipName)}) as z:
    for n in z.namelist():
        low = n.lower()
        if (low == ".env" or low.endswith("/.env") or ".env/" in low or low == ".dev.vars" or low.endswith(".pyc")
            or "__pycache__" in low or ".pytest_cache" in low or ".workbuddy-ai" in low or ".venv" in low
            or "node_modules" in low or ".wrangler" in low or low.endswith(".db") or low.endswith(".db-wal")
            or low.endswith(".db-shm") or low.endswith(".db-journal")):
            bad.append(n)
if bad:
    print("FORBIDDEN")
    for b in bad: print(b)
    sys.exit(1)
else:
    print("SAFE")
`;
try {
  execFileSync(python, ["-c", checkScript], { stdio: "inherit", cwd: root });
} catch (e) {
  console.error("❌ Архив содержит запрещённые элементы");
  process.exit(1);
}

console.log("✅ Архив создан и проверен:", zipName);
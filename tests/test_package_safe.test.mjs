// Регрессии аудита 2026-11-17 (full audit):
//  - PKG-AGENT-01: safe-упаковщик обязан включать корневой AGENTS.md;
//  - DEV-ASSET-01: debug-страницы и тестовые заглушки не попадают в public/;
//  - SCRIPT-MODULE-01: упаковщик — .mjs (однозначный ESM без "type":"module").
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptPath = join(root, "scripts", "package-safe.mjs");

const hasPython = (() => {
  try {
    execFileSync(process.platform === "win32" ? "python" : "python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("PKG-AGENT-01/SCRIPT-MODULE-01: упаковщик — .mjs и включает AGENTS.md", { skip: !hasPython && "python недоступен" }, () => {
  ok(existsSync(scriptPath), "scripts/package-safe.mjs существует");
  ok(!existsSync(join(root, "scripts", "package-safe.js")), "старого .js-варианта нет");

  // allowlist в исходнике содержит AGENTS.md — быстрая проверка без запуска.
  const src = readFileSync(scriptPath, "utf8");
  const allowlist = src.slice(src.indexOf("allowedTopLevel"), src.indexOf("];", src.indexOf("allowedTopLevel")));
  ok(allowlist.includes('"AGENTS.md"'), "AGENTS.md в allowedTopLevel");

  // Полный прогон во временном каталоге: AGENTS.md в ZIP, секреты — нет.
  const tmp = mkdtempSync(join(tmpdir(), "duoplan-pkg-"));
  try {
    writeFileSync(join(tmp, "AGENTS.md"), "# rules\n");
    writeFileSync(join(tmp, "README.md"), "# readme\n");
    writeFileSync(join(tmp, ".env"), "BOT_TOKEN=secret\n");
    writeFileSync(join(tmp, ".dev.vars"), "BOT_TOKEN=secret\n");
    mkdirSync(join(tmp, "public"), { recursive: true });
    writeFileSync(join(tmp, "public", "app.js"), "// app\n");
    writeFileSync(join(tmp, "worker.js"), "// worker\n");
    execFileSync("node", [scriptPath], { cwd: tmp, stdio: "pipe" });

    const list = execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c", "import zipfile;[print(n) for n in zipfile.ZipFile('DuoPlan.zip').namelist()]"],
      { cwd: tmp, encoding: "utf8" }
    );
    const names = list.trim().split(/\r?\n/).map(n => n.replace(/\\/g, "/"));
    ok(names.includes("AGENTS.md"), "AGENTS.md попал в архив");
    ok(names.includes("worker.js") && names.includes("public/app.js"), "код в архиве");
    ok(!names.some(n => n === ".env" || n === ".dev.vars" || n.endsWith(".pyc")), "секреты и кэши исключены");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("DEV-ASSET-01: в public/ нет debug-страниц и тестовых заглушек", () => {
  const publicDir = join(root, "public");
  const files = readdirSync(publicDir);
  const forbidden = files.filter(f => /^dev-.*\.html$/.test(f) || /-stub\.js$/.test(f));
  equal(forbidden.length, 0, `debug-ассеты в public/: ${forbidden.join(", ")}`);
});

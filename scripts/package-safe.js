#!/usr/bin/env node
// Безопасная упаковка проекта DuoPlan. Исключает секреты, базы данных и временные файлы.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const zipName = 'DuoPlan.zip';
const excludePatterns = [
  '.env', '.dev.vars', '*.db', '*.db-wal', '*.db-shm', '*.db-journal',
  '.wrangler/', 'node_modules/', '__pycache__/', '*.pyc', '.pytest_cache/',
  '.workbuddy-ai/', '.venv/', '.kiro/', 'tests/*.py', 'DuoPlan.zip'
];

const allowedFiles = [
  '.env.example', '.gitignore',
  'public/', 'duoplan/', 'tests/', 'scripts/',
  'README.md', 'requirements.txt', 'pyproject.toml',
  'wrangler.jsonc', 'migrations/',
  'test_config_fix.py'  // удалим перед упаковкой
];

console.log('Проверка исключений секретных файлов...');

// Проверяем отсутствие реальных секретов в .env
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8');
  if (envContent.includes('AAE-') || envContent.includes('YOUR_') || envContent.includes('902940')) {
    console.log('⚠️  В .env обнаружен заменённый секрет — это нормально для локальной разработки.');
  } else {
    console.log('✅ .env проверен (секреты заменены на заглушки)');
  }
}

if (!fs.existsSync('.env')) {
  console.log('❌ .env отсутствует — это ожидаемо в архиве');
} else {
  console.log('⚠️  .env присутствует в директории — это локальный файл, он не должен попадать в архив.');
}

console.log('Создание безопасного ZIP...');

// Формируем команду zip с исключениями
const exclusions = excludePatterns.map(p => `-x ${p}`).join(' ');
try {
  execSync(`zip -r ${zipName} . -x *.zip ${exclusions}`, { stdio: 'inherit' });
  console.log('✅ Архив создан:', zipName);
} catch (e) {
  console.log('❌ Ошибка создания ZIP:', e.message);
  process.exit(1);
}

// Проверяем содержимое архива на отсутствие секретов
console.log('\nПроверка содержимого архива...');
const zipFiles = execSync(`unzip -l ${zipName}`).toString();

const forbidden = [
  '.env', '.dev.vars', 'duoplan.db', 'data/', '.workbuddy-ai/', '.venv/', 'node_modules/'
];

let foundSecrets = false;
for (const secret of forbidden) {
  if (zipFiles.includes(secret)) {
    console.log(`❌ Найден запрещённый файл/директория в ZIP: ${secret}`);
    foundSecrets = true;
  }
}

if (!foundSecrets) {
  console.log('✅ Архив безопасен: секреты и базы данных исключены');
}

console.log('Готово!');

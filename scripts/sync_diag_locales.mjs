import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The crate sits next to this repository during development, or wherever
// FABRIC_DIAGNOSTICS_DIR points. Without it there is nothing to compare against,
// so --check reports that and passes instead of failing a machine that only builds.
const crateDir = process.env.FABRIC_DIAGNOSTICS_DIR ?? path.resolve(root, '..', 'fabric-diagnostics');
const source = path.join(crateDir, 'locales');
const { existsSync } = await import('node:fs');
if (!existsSync(source)) {
  console.log(`Diagnostic locales not checked: ${source} not found.`);
  process.exit(process.argv.includes('--check') ? 0 : 1);
}
const languages = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'ru-RU'];
let drift = false;
const boot = {};
const legacy = {};
for (const language of languages) {
  const file = path.join(root, 'app/i18n/locales', `${language}.json`);
  const target = JSON.parse(await readFile(file, 'utf8'));
  const flat = JSON.parse(await readFile(path.join(source, `${language}.json`), 'utf8'));
  legacy[language] = { ...flat, 'ui.error.details': target.ui.error.details,
    'ui.error.copied': target.ui.error.copied, 'ui.error.copyFailed': target.ui.error.copyFailed };
  boot[language] = {
    title: flat['diag.title.other'], cause: flat['diag.cause.unknown'],
    steps: [flat['diag.step.retry'], flat['diag.step.copyAndCommunity']],
    copy: flat['diag.action.copy_error'], retry: target.ui.error.retry,
    details: target.ui.error.details, copyFailed: target.ui.error.copyFailed,
  };
  const nested = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    if (parts.shift() !== 'diag') throw new Error(`Unexpected diagnostic key: ${key}`);
    let node = nested;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  if (JSON.stringify(target.diag) !== JSON.stringify(nested)) {
    drift = true;
    if (process.argv.includes('--check')) console.error(`Diagnostic locale drift: ${language}`);
    else { target.diag = nested; await writeFile(file, `${JSON.stringify(target, null, 2)}\n`); }
  }
}
const legacyPath = path.join(root, 'app/src-tauri/engine-payload/configs/diagnostic_locales.json');
const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
if (await readFile(legacyPath, 'utf8').catch(() => '') !== legacyText) {
  drift = true;
  if (process.argv.includes('--check')) console.error('Diagnostic legacy locale drift');
  else await writeFile(legacyPath, legacyText);
}
const htmlPath = path.join(root, 'app/index.html');
const html = await readFile(htmlPath, 'utf8');
const updated = html.replace(/\/\* diag-locales:start \*\/[\s\S]*?\/\* diag-locales:end \*\//,
  `/* diag-locales:start */\n        var diagBoot = ${JSON.stringify(boot)};\n        /* diag-locales:end */`);
if (updated !== html) {
  drift = true;
  if (process.argv.includes('--check')) console.error('Diagnostic boot locale drift');
  else await writeFile(htmlPath, updated);
}
if (drift && process.argv.includes('--check')) process.exitCode = 1;

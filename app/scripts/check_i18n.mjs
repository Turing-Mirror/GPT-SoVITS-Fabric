// i18n 语言包硬校验：结构与占位符必须八语言一致。
//
// 起因是 26.8 的一次线上事故：14 条新文案只写了 zh-CN 就发布，八语言里
// 其余七份直接显示字面 `{v0}` 大括号。这类问题肉眼看 diff 永看不全 ——
// 一条文案八份语言，漏改任何一份都是运行时才炸。所以这里用程序当关隘：
//
//   1. 结构：八个语言包的 key 树必须完全一致（glossary 按 term id 对齐、
//      extras.items 按 item id 对齐，缺一个词条就报）。
//   2. 占位符：每条字符串里 `{...}` 记号（`{v0}`、`{}`、`{:.1}` 都算）的
//      集合必须与 zh-CN 完全一致 —— 多一个少一个都是运行时的字面大括号
//      或者吞参数。
//
// 接在 `npm run build` 里，任何一条不过就构建失败，不给它上线的机会。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, "..", "i18n", "locales");
const BASE = "zh-CN";
const OTHERS = [
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
  "es-ES",
  "fr-FR",
  "ru-RU",
];

const TOKEN = /\{[^{}]*\}/g;

/** 把语言包压平成 dotted-key -> string。dict 往下走；「按 id 对齐」的数组
 * （glossary.terms）单独处理成 id -> 字段 map，缺哪个 id 一目了然。 */
function flatten(value, prefix, out) {
  if (typeof value !== "object" || value === null) {
    out[prefix] = String(value);
    return;
  }
  if (Array.isArray(value)) {
    // glossary.terms：唯一「有意义的数组」。逐条拍平成 terms.<id>.<field>。
    value.forEach((entry) => {
      if (entry && typeof entry === "object" && "id" in entry) {
        for (const [k, v] of Object.entries(entry)) {
          if (k === "id") continue;
          flatten(v, `${prefix}.${entry.id}.${k}`, out);
        }
      } else {
        flatten(value.indexOf(entry), `${prefix}.${value.indexOf(entry)}`, out);
      }
    });
    return;
  }
  for (const [k, v] of Object.entries(value)) flatten(v, `${prefix}${prefix ? "." : ""}${k}`, out);
}

function tokens(s) {
  return (s.match(TOKEN) || []).sort().join("|");
}

const packs = {};
for (const loc of [BASE, ...OTHERS]) {
  const raw = readFileSync(join(LOCALES_DIR, `${loc}.json`), "utf-8");
  packs[loc] = {};
  flatten(JSON.parse(raw), "", packs[loc]);
}

const problems = [];
const base = packs[BASE];

for (const loc of OTHERS) {
  const pack = packs[loc];
  const baseKeys = new Set(Object.keys(base));
  const packKeys = new Set(Object.keys(pack));

  for (const k of baseKeys) {
    if (!packKeys.has(k)) {
      problems.push(`${loc}: 缺 key「${k}」`);
      continue;
    }
    const a = tokens(base[k]);
    const b = tokens(pack[k]);
    if (a !== b) {
      problems.push(
        `${loc}: 「${k}」占位符不一致\n    zh-CN: ${a || "（无）"}\n    ${loc}:   ${b || "（无）"}`,
      );
    }
  }
  for (const k of packKeys) {
    if (!baseKeys.has(k)) problems.push(`${loc}: 多出 zh-CN 没有的 key「${k}」`);
  }
}

// —— 第三道：代码里 t("…") 引用的 key，语言包里必须真的有 ——
//
// 前面两道只让八个语言包互相对齐，对不上「代码引用了一个谁都没有的 key」
// 这种情况：八个包一致地缺同一条，校验照样通过，而界面上那一格会原样印出
// `fps.settings.general` 这样的字符串。设置页整页的标签就是这么静默坏掉的
// （fps.settings.* 十三条从来没进过语言包，八种语言下都在显示 key 本身）。
const SRC_DIR = join(HERE, "..", "src");

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 去掉注释再找 t(…)：注释里成段引用过 `t("s.xxx")` 当例子，那些不是引用。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const REF = /\bt(?:Static)?\(\s*["'`]([\w.\-]+)["'`]/g;
const refs = new Map();
for (const file of walk(SRC_DIR, [])) {
  const src = stripComments(readFileSync(file, "utf-8"));
  for (const m of src.matchAll(REF)) {
    if (!refs.has(m[1])) refs.set(m[1], file);
    }
}
for (const [key, file] of refs) {
  if (!(key in base)) {
    problems.push(
      `zh-CN: 代码引用了不存在的 key「${key}」（${file.replace(HERE + "/../", "")}）`,
    );
  }
}

if (problems.length) {
  console.error(`i18n 校验失败，共 ${problems.length} 处：\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const nKeys = Object.keys(base).length;
console.log(
  `i18n 校验通过：${OTHERS.length + 1} 个语言包 × ${nKeys} 条，结构与占位符一致；` +
    `代码引用的 ${refs.size} 个 key 全部有着落`,
);

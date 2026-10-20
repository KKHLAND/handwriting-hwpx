// 빌드: src/app.html + vendor/테스트_문제지생성.html(엔진 번들·내장 양식) → ../손글씨OCR.html, ../index.html
// 실행: node src/build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, 'app.html'), 'utf8');
const vendor = join(here, 'vendor', '테스트_문제지생성.html');
const test = readFileSync(existsSync(vendor) ? vendor : join(here, '..', '..', '테스트_문제지생성.html'), 'utf8');

const scripts = [...test.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let engine = scripts.find((s) => s.includes('var HwpxExam'));
const tplLine = scripts.find((s) => s.includes('const T=')).split('\n').find((l) => l.startsWith('const T='));
if (!engine || !tplLine) throw new Error('엔진/양식을 찾지 못했습니다');

// 엔진 보강(최소 변경)
const patch = (from, to) => { if (!engine.includes(from)) throw new Error('패치 위치 없음: ' + from.slice(0, 60)); engine = engine.replace(from, to); };
// 1) 문항 없는 지문/빈 지시문 허용
patch('let xml = this.pText(head, /^\\s*\\[/.test(g.instruction) ? g.instruction : `[${range}] ${g.instruction}`);',
  'let xml = !g.instruction ? "" : this.pText(head, /^\\s*\\[/.test(g.instruction) || !g.questions.length ? g.instruction : `[${range}] ${g.instruction}`);');
// 2) 일반 문단(학생 답안·글) 항목
patch('for (const it of exam.items) {',
  'for (const it of exam.items) {\n        if (it.type === "text") { for (const l of String(it.text).split("\\n")) xml += this.pText(this.st("바탕글"), l); xml += this.blank(); continue; }');
// 3) 배점 없는 문항
patch('pointsText(p) {', 'pointsText(p) {\n      if (p === void 0 || p === null || p === "") return "";');

const out = app.replace('/*__ENGINE__*/', () => engine).replace('/*__TEMPLATES__*/', () => tplLine);
writeFileSync(join(here, '..', '손글씨OCR.html'), out);
writeFileSync(join(here, '..', 'index.html'), out); // GitHub Pages 용
console.log('ok', (out.length / 1024).toFixed(0) + 'KB');

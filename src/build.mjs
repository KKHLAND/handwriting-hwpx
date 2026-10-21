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
// 2) 확장 항목(일반 문단·표·그림·학생 구분) → engine-ext.js 의 extItem
patch('for (const it of exam.items) {',
  'for (const it of exam.items) {\n        const __x = this.extItem ? this.extItem(it) : null; if (__x != null) { xml += __x; continue; }');
// 3) 배점 없는 문항
patch('pointsText(p) {', 'pointsText(p) {\n      if (p === void 0 || p === null || p === "") return "";');
// 4) 학생 구분 쪽 나눔 표시(\u0001PB) → 다음 문단 pageBreak="1", 조각 파싱에 hc 네임스페이스(그림용)
patch('const ps = kids(this.root, "p");', 'xml = xml.replace(/\u0001PB<hp:p ([^>]*?)pageBreak="0"/g, \'<hp:p $1pageBreak="1"\');\n      const ps = kids(this.root, "p");');
patch('const frag = new this.dp().parseFromString(`<w xmlns:hp="${NS.hp}">${xml}</w>`', 'const frag = new this.dp().parseFromString(`<w xmlns:hp="${NS.hp}" xmlns:hc="${NS.hc}">${xml}</w>`');
// 4-1) 그림 파일을 BinData 로, content.hpf 에 등록 / 빌더 클래스 노출
patch('new ExamBuilder(sec, head, DP, opts).build(exam);', 'const __b = new ExamBuilder(sec, head, DP, opts); __b.build(exam);');
patch('else if (name === "Preview/PrvText.txt")', 'else if (name === "Contents/content.hpf" && __b.images?.length) out.file(name, __b.manifest(await f.async("string")));\n      else if (name === "Preview/PrvText.txt")');
patch('return out.generateAsync(', 'for (const im of __b.images ?? []) out.file("BinData/" + im.file, im.bytes, { compression: "STORE", createFolders: false });\n    return out.generateAsync(');
patch('async function buildExamHwpx(', 'globalThis.HwpxExamBuilder = ExamBuilder;\n  async function buildExamHwpx(');

// 5) 머리말 한 칸 정리: 3칸 표 → 칸 구분 없는 1칸(학교명 / 제목 / 오른쪽 문구를 줄로), 제목 글자 크기 자동 맞춤
patch('setCell(cells[2], meta.headerRight ?? "");\n    }',
  `setCell(cells[2], meta.headerRight ?? "");
      if (this.opts.headerStyle !== "table" && cells.length >= 3) this.flattenHeader(tbl, cells, meta);
    }
    sizeVariant(base, h) {
      const props = desc(this.head.documentElement, "charProperties")[0];
      const src = kids(props, "charPr").find((c) => c.getAttribute("id") === base);
      if (!src || num(src.getAttribute("height")) === h) return base;
      const c = src.cloneNode(true), id = String(kids(props, "charPr").length);
      c.setAttribute("id", id); c.setAttribute("height", String(h));
      props.appendChild(c); props.setAttribute("itemCnt", String(kids(props, "charPr").length));
      this.charH.set(id, h); return id;
    }
    flattenHeader(tbl, cells, meta) {
      const info = cells.map((tc) => { const p = desc(tc, "p")[0], r = p && kids(p, "run")[0]; return { para: p?.getAttribute("paraPrIDRef") ?? "0", style: p?.getAttribute("styleIDRef") ?? "0", cp: r?.getAttribute("charPrIDRef") ?? "0", text: textOf(tc) }; });
      const widthOf = (tc) => num(desc(tc, "cellSz")[0]?.getAttribute("width"));
      const W = cells.reduce((a, tc) => a + widthOf(tc), 0) || num(desc(tbl, "sz")[0]?.getAttribute("width"), 51024);
      const avail = W - 282 - 400;
      const title = meta.title ?? info[1].text;
      const base = this.charH.get(info[1].cp) ?? 1800;
      const want = Number(this.opts.titleSize) > 0 ? Math.round(Number(this.opts.titleSize) * 100) : Math.min(base, 1600);
      let h = want;
      if (!(Number(this.opts.titleSize) > 0)) while (h > 1000 && textWidth(title, h) > avail * 0.95) h -= 50;
      const small = Number(this.opts.subSize) > 0 ? Math.round(Number(this.opts.subSize) * 100) : 1000;
      const para = (i, text, ch) => \`<hp:p id="0" paraPrIDRef="\${info[i].para}" styleIDRef="\${info[i].style}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="\${ch}">\${text ? \`<hp:t>\${esc(text)}</hp:t>\` : ""}</hp:run></hp:p>\`;
      const school = info[0].text, right = info[2].text;
      let xml = "", lines = [];
      if (school) { xml += para(0, school, this.sizeVariant(info[0].cp, small)); lines.push(small); }
      xml += para(1, title, this.sizeVariant(info[1].cp, h)); lines.push(h);
      if (right) { xml += para(2, right, this.sizeVariant(info[2].cp, small)); lines.push(small); }
      const H = Math.round(lines.reduce((a, x) => a + x * 1.6, 0)) + 424;
      const keep = cells[1];
      const sub = desc(keep, "subList")[0];
      while (sub.firstChild) sub.removeChild(sub.firstChild);
      for (const p of kids(new this.dp().parseFromString(\`<w xmlns:hp="\${NS.hp}">\${xml}</w>\`, "application/xml").documentElement)) sub.appendChild(this.sec.importNode(p, true));
      sub.setAttribute("vertAlign", "CENTER");
      desc(keep, "cellAddr")[0]?.setAttribute("colAddr", "0");
      desc(keep, "cellSz")[0]?.setAttribute("width", String(W));
      desc(keep, "cellSz")[0]?.setAttribute("height", String(H));
      for (const tc of cells) if (tc !== keep) tc.parentNode.removeChild(tc);
      tbl.setAttribute("colCnt", "1");
      desc(tbl, "sz")[0]?.setAttribute("height", String(H));
    }`);

const ext = readFileSync(join(here, 'engine-ext.js'), 'utf8');
const out = app.replace('/*__ENGINE__*/', () => engine + '\n' + ext).replace('/*__TEMPLATES__*/', () => tplLine);
writeFileSync(join(here, '..', '손글씨OCR.html'), out);
writeFileSync(join(here, '..', 'index.html'), out); // GitHub Pages 용
console.log('ok', (out.length / 1024).toFixed(0) + 'KB');

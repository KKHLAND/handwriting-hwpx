/**
 * 문제지 hwpx 생성기 (양식1: 2단 / 양식2: 1단)
 * ------------------------------------------------------------
 * 문항 출제 앱에서 만든 문항 데이터(JSON)를 학교 문제지 양식(.hwpx)에 채워
 * 한글에서 바로 열리는 hwpx 파일로 만든다.
 *
 * 동작 원리
 *  - 양식 파일의 머리말 표(학교명 / 제목 / 오른쪽 칸)와 쪽번호 꼬리말은 그대로 쓰고 글자만 바꾼다.
 *  - 본문 서식은 양식 header.xml 에 들어 있는 '문제지 스타일'을 **이름으로** 찾아 쓴다.
 *      문제, 문제번호(글자), [∼], 지문박스, 1행답항, 2행답항, 3행답항, 5행답항,
 *      <보기>, 보기 ㄱ, ㄴ, ㄷ, 확인사항, 문제2, 밑줄(글자)
 *    → 학교명·서식 ID를 하드코딩하지 않으므로 같은 스타일 세트를 가진 양식이면 어느 학교든 동작.
 *  - 단 수(1단/2단)는 양식의 secPr 에서 읽어 선지 배치·표 너비를 자동 계산한다.
 *
 * 의존성: JSZip 3.x, DOMParser/XMLSerializer(브라우저 기본. Node 테스트는 @xmldom/xmldom 주입)
 */
import JSZip from 'jszip';

// ───────────────────────── 데이터 스키마 ─────────────────────────

export interface ExamMeta {
  /** 머리말 왼쪽 칸: '○○고등학교' 자리 (생략 시 양식 그대로) */
  schoolName?: string;
  /** 머리말 가운데 칸: '제목' 자리. 예: '2026학년도 2학기 기말고사 공통국어2' */
  title: string;
  /** 머리말 오른쪽 칸. 예: '1학년' 또는 '( )반 ( )번 이름:' (생략 시 빈칸) */
  headerRight?: string;
  /** 본문 맨 위 안내문(확인사항 스타일). 예: ['※ 선택형 20문항, 서논술형 3문항입니다.'] */
  notice?: string[];
  /** 파일명용(선택) */
  subject?: string;
  grade?: number | string;
}

/** <보 기> / <조 건> 박스 */
export interface Bogi {
  /** 박스 제목. 기본 '<보 기>' */
  title?: string;
  /** ㄱ. ㄴ. ㄷ. 자동 기호가 붙는 항목 */
  items?: string[];
  /** 기호 없이 넣을 줄(설명문·자료). items 보다 먼저 들어감 */
  lines?: string[];
}

/** 선지를 표로 제시 (예: A / B 짝짓기) */
export interface ChoiceTable {
  headers: string[];
  /** ①~⑤ 각 행 값 */
  rows: string[][];
}

export type ChoiceLayout = 'auto' | 'oneRow' | 'twoRows' | 'threeRows' | 'vertical';

export interface MCQuestion {
  type: 'mc';
  /** 발문. \n = 다음 줄(문단). __밑줄__, **진하게** 사용 가능 */
  stem: string;
  /** 배점 3.8 → [3.8점] */
  points: number | string;
  /** 선지(①~⑤ 기호 자동). table 사용 시 생략 */
  choices?: string[];
  /** 선지 배치: oneRow(1행) twoRows(3+2) threeRows(2+2+1) vertical(5행). 기본 auto */
  layout?: ChoiceLayout;
  bogi?: Bogi;
  table?: ChoiceTable;
}

export interface EssayQuestion {
  type: 'essay';
  /** 기본 '서논술형' ('단답형', '서답형' 등) */
  label?: string;
  stem: string;
  bogi?: Bogi;
  /** 소문항 ['(1) ...', '(2) ...'] */
  subQuestions?: string[];
  /** 배점 합계 */
  points: number;
  /** 배점 표기. 생략 시 [6점] */
  scoreText?: string;
  /** 문항 아래 안내 문구(선택). 예: '답안지에 문항번호를 표시하고 답하시오.' */
  instruction?: string;
  /** 문항 뒤 빈 줄 수(기본 1) */
  blankLines?: number;
}

export interface Passage {
  /** '(가)' 등 꼬리표 (선택) */
  label?: string;
  /** 지문. \n = 문단 */
  text: string;
}

/** [1∼3] 다음 글을 읽고 물음에 답하시오. + 지문 + 하위 문항 */
export interface QuestionGroup {
  type: 'group';
  /** 지시문. [1∼3] 범위는 자동으로 앞에 붙음 */
  instruction: string;
  passages?: Passage[];
  questions: Array<MCQuestion | EssayQuestion>;
}

export type ExamItem = MCQuestion | EssayQuestion | QuestionGroup;

export interface ExamDoc {
  meta: ExamMeta;
  items: ExamItem[];
}

export interface BuildOptions {
  /** 배점 소수점 자리(기본 1 → [4.0점]). 0 이면 [4점] */
  pointDecimals?: number;
  /** 서논술형 번호를 선택형에 이어서 매길지(기본 false: [서논술형 1]부터) */
  continueEssayNumber?: boolean;
  /** Node 테스트용 DOM 구현 */
  dom?: { DOMParser: any; XMLSerializer: any };
}

// ───────────────────────── 내부 유틸 ─────────────────────────

const NS = {
  hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  hh: 'http://www.hancom.co.kr/hwpml/2011/head',
  hc: 'http://www.hancom.co.kr/hwpml/2011/core',
};
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const GANADA = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ'];

type El = any;
const ln = (n: any) => (n && n.nodeType === 1 ? n.localName || String(n.nodeName).split(':').pop() : '');
const kids = (el: El, name?: string): El[] => {
  const o: El[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!name || ln(c) === name)) o.push(c);
  return o;
};
const desc = (el: El, name: string): El[] => {
  const o: El[] = [];
  const w = (n: El) => {
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) { if (ln(c) === name) o.push(c); w(c); }
  };
  w(el);
  return o;
};
const textOf = (el: El): string =>
  desc(el, 't').map((t) => { let s = ''; for (let c = t.firstChild; c; c = c.nextSibling) s += c.nodeType === 3 ? c.nodeValue : ln(c) === 'tab' ? '\t' : ''; return s; }).join('');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: any, d = 0) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));
const fmtTotal = (n: number) => String(Math.round(n * 10) / 10);
/** 대략적인 글자 폭(HWPUNIT): 한글·전각 = 글자크기, 반각 = 0.55배 */
const textWidth = (s: string, h: number) => [...s.replace(/\*\*|__/g, '')].reduce((w, ch) => w + (/[\u0000-ÿ]/.test(ch) ? h * 0.55 : h), 0);

function parseInline(s: string): Array<{ text: string; bold?: boolean; underline?: boolean }> {
  const out: Array<{ text: string; bold?: boolean; underline?: boolean }> = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], underline: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.length ? out : [{ text: '' }];
}

interface StyleRef { id: string; paraPr: string; charPr: string }
interface ParaInfo { left: number; indent: number; tabs: number[]; align: string }

// ───────────────────────── 생성기 ─────────────────────────

class ExamBuilder {
  sec: El; head: El; root: El; dp: any;
  opts: BuildOptions;
  styles = new Map<string, StyleRef>();
  colWidth = 0;
  charH = new Map<string, number>();
  paraInfo = new Map<string, ParaInfo>();
  charCache = new Map<string, string>();
  tblSeq = 1950000000; zSeq = 50;
  solidBF = '';
  noneBF = '';
  centerPara = '';

  constructor(sec: El, head: El, dp: any, opts: BuildOptions) {
    this.sec = sec; this.head = head; this.root = sec.documentElement; this.dp = dp; this.opts = opts;
    this.readHeader();
    this.readSection();
  }

  // ── 양식 읽기 ──
  readHeader() {
    const h = this.head.documentElement;
    for (const s of desc(h, 'style'))
      this.styles.set(s.getAttribute('name'), { id: s.getAttribute('id'), paraPr: s.getAttribute('paraPrIDRef'), charPr: s.getAttribute('charPrIDRef') });
    for (const c of desc(h, 'charPr')) this.charH.set(c.getAttribute('id'), num(c.getAttribute('height'), 1000));
    const tabs = new Map<string, number[]>();
    for (const t of desc(h, 'tabPr')) {
      // hp:switch 의 case(HWPUNIT) 값 우선
      const items = desc(t, 'tabItem').filter((it: El) => it.getAttribute('unit') === 'HWPUNIT');
      tabs.set(t.getAttribute('id'), (items.length ? items : desc(t, 'tabItem')).map((it: El) => num(it.getAttribute('pos'))).filter((p: number) => p > 0));
    }
    for (const p of desc(h, 'paraPr')) {
      const mg = desc(p, 'margin')[0];
      const val = (n: string) => num(mg && kids(mg, n)[0]?.getAttribute('value'));
      const border = desc(p, 'border')[0];
      const info: ParaInfo = { left: val('left'), indent: val('intent'), tabs: tabs.get(p.getAttribute('tabPrIDRef')) ?? [], align: desc(p, 'align')[0]?.getAttribute('horizontal') ?? 'JUSTIFY' };
      this.paraInfo.set(p.getAttribute('id'), info);
      if (!this.centerPara && info.align === 'CENTER' && !info.left && !info.indent && (!border || border.getAttribute('borderFillIDRef') === '1' || border.getAttribute('borderFillIDRef') === '2'))
        this.centerPara = p.getAttribute('id');
    }
    // 실선 테두리 / 테두리 없음 borderFill
    for (const bf of desc(h, 'borderFill')) {
      const sides = ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'].map((n) => kids(bf, n)[0]);
      const types = sides.map((s: El) => s?.getAttribute('type'));
      const hasFill = desc(bf, 'winBrush').some((w: El) => (w.getAttribute('faceColor') ?? 'none') !== 'none' && w.getAttribute('faceColor') !== '#FFFFFF');
      if (!this.solidBF && types.every((t) => t === 'SOLID') && !hasFill) this.solidBF = bf.getAttribute('id');
      if (!this.noneBF && types.every((t) => t === 'NONE') && !hasFill) this.noneBF = bf.getAttribute('id');
    }
    if (!this.solidBF) this.solidBF = this.addBorderFill('SOLID');
    if (!this.noneBF) this.noneBF = this.addBorderFill('NONE');
  }

  addBorderFill(type: 'SOLID' | 'NONE'): string {
    const list = desc(this.head.documentElement, 'borderFills')[0];
    const id = String(kids(list, 'borderFill').length + 1);
    const b = (side: string) => `<hh:${side} type="${type}" width="0.12 mm" color="#000000"/>`;
    const xml = `<hh:borderFill xmlns:hh="${NS.hh}" xmlns:hc="${NS.hc}" id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${b('leftBorder')}${b('rightBorder')}${b('topBorder')}${b('bottomBorder')}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>`;
    const node = this.head.importNode(new this.dp().parseFromString(xml, 'application/xml').documentElement, true);
    list.appendChild(node);
    list.setAttribute('itemCnt', String(kids(list, 'borderFill').length));
    return id;
  }

  readSection() {
    const pagePr = desc(this.root, 'pagePr')[0];
    const mg = desc(this.root, 'margin').find((m: El) => m.parentNode === pagePr);
    const colPr = desc(this.root, 'colPr')[0];
    const W = num(pagePr?.getAttribute('width'), 59528) - num(mg?.getAttribute('left'), 4252) - num(mg?.getAttribute('right'), 4252);
    const cols = Math.max(1, num(colPr?.getAttribute('colCount'), 1));
    const gap = num(colPr?.getAttribute('sameGap'), 0);
    this.colWidth = Math.floor((W - gap * (cols - 1)) / cols);
  }

  st(...names: string[]): StyleRef {
    for (const n of names) { const s = this.styles.get(n); if (s) return s; }
    return this.styles.get('바탕글') ?? { id: '0', paraPr: '0', charPr: '0' };
  }

  /** 진하게/밑줄 변형 글자모양 (header.xml 에 추가) */
  charVariant(base: string, bold?: boolean, underline?: boolean): string {
    if (!bold && !underline) return base;
    const key = `${base}|${+!!bold}|${+!!underline}`;
    if (this.charCache.has(key)) return this.charCache.get(key)!;
    const props = desc(this.head.documentElement, 'charProperties')[0];
    const src = kids(props, 'charPr').find((c: El) => c.getAttribute('id') === base);
    if (!src) return base;
    const c = src.cloneNode(true);
    const id = String(kids(props, 'charPr').length);
    c.setAttribute('id', id);
    if (bold && !kids(c, 'bold').length) c.insertBefore(this.head.createElementNS(NS.hh, 'hh:bold'), kids(c, 'underline')[0] ?? null);
    if (underline) kids(c, 'underline')[0]?.setAttribute('type', 'BOTTOM');
    props.appendChild(c);
    props.setAttribute('itemCnt', String(kids(props, 'charPr').length));
    this.charH.set(id, this.charH.get(base) ?? 1000);
    this.charCache.set(key, id);
    return id;
  }

  // ── XML 조각 ──
  runs(charPr: string, text: string): string {
    return parseInline(text)
      .map((seg) => {
        const t = esc(seg.text).split('\t').join('<hp:tab width="4000" leader="0" type="1"/>');
        return `<hp:run charPrIDRef="${this.charVariant(charPr, seg.bold, seg.underline)}">${t ? `<hp:t>${t}</hp:t>` : ''}</hp:run>`;
      })
      .join('');
  }
  p(style: StyleRef, inner: string, paraPr?: string): string {
    return `<hp:p id="0" paraPrIDRef="${paraPr ?? style.paraPr}" styleIDRef="${style.id}" pageBreak="0" columnBreak="0" merged="0">${inner || `<hp:run charPrIDRef="${style.charPr}"/>`}</hp:p>`;
  }
  pText(style: StyleRef, text: string): string {
    return this.p(style, this.runs(style.charPr, text));
  }
  blank(): string {
    const s = this.st('바탕글');
    return this.p(s, '');
  }

  /** 1×n 표 문자열 */
  table(rows: string[][], widths: number[], opts: { inMargin?: number } = {}): string {
    const m = opts.inMargin ?? 283;
    const W = widths.reduce((a, b) => a + b, 0);
    const trs = rows
      .map((cells, r) =>
        `<hp:tr>${cells
          .map((inner, c) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${this.solidBF}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${widths[c]}" height="1000"/><hp:cellMargin left="${m}" right="${m}" top="141" bottom="141"/></hp:tc>`)
          .join('')}</hp:tr>`)
      .join('');
    return `<hp:tbl id="${this.tblSeq++}" zOrder="${this.zSeq++}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${widths.length}" cellSpacing="0" borderFillIDRef="${this.noneBF}" noAdjust="0"><hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${1000 * rows.length}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="283" bottom="283"/><hp:inMargin left="${m}" right="${m}" top="141" bottom="141"/>${trs}</hp:tbl>`;
  }
  /** 표를 담는 문단 */
  tablePara(style: StyleRef, tbl: string): string {
    return this.p(style, `<hp:run charPrIDRef="${style.charPr}">${tbl}<hp:t/></hp:run>`);
  }
  innerWidth(style: StyleRef) {
    const i = this.paraInfo.get(style.paraPr);
    return this.colWidth - Math.max(0, i?.left ?? 0) - 400;
  }

  // ── 문항 요소 ──
  bogi(b: Bogi): string {
    const wrap = this.st('보기틀', '바탕글');
    const title = this.st('<보기>');
    const item = this.st('보기 ㄱ, ㄴ, ㄷ', '바탕글');
    const line = this.st('보기(들여쓰기)', '바탕글');
    const centerPr = this.centerPara || this.st('바탕글').paraPr;
    let inner = this.p(title, this.runs(title.charPr, b.title ?? '<보 기>'), centerPr);
    for (const l of b.lines ?? []) inner += this.pText(line, l);
    (b.items ?? []).forEach((s, i) => (inner += this.pText(item, `${GANADA[i]}. ${s}`)));
    return this.tablePara(wrap, this.table([[inner]], [this.innerWidth(wrap)]));
  }

  choiceTable(ct: ChoiceTable): string {
    const wrap = this.st('보기틀', '바탕글');
    const cell = this.st('바탕글');
    const centerPr = this.centerPara || cell.paraPr;
    const W = Math.min(this.innerWidth(wrap), 24000);
    const h = ct.headers.length;
    const mark = Math.round(W / (h + 1) * (h > 2 ? 0.6 : 1));
    const dataW = Math.floor((W - mark) / h);
    const c = (t: string) => this.p(cell, this.runs(cell.charPr, t), centerPr);
    const rows = [[c(''), ...ct.headers.map(c)], ...ct.rows.map((r, i) => [c(CIRCLED[i]), ...Array.from({ length: h }, (_, j) => c(r[j] ?? ''))])];
    return this.tablePara(wrap, this.table(rows, [mark, ...Array(h).fill(dataW)], { inMargin: 141 }));
  }

  choices(q: MCQuestion): string {
    const ch = (q.choices ?? []).map((s) => s.trim());
    const n = ch.length;
    const defs: Record<Exclude<ChoiceLayout, 'auto'>, { style: StyleRef; perRow: number }> = {
      oneRow: { style: this.st('1행답항'), perRow: 5 },
      twoRows: { style: this.st('2행답항'), perRow: 3 },
      threeRows: { style: this.st('3행답항'), perRow: 2 },
      vertical: { style: this.st('5행답항', '①'), perRow: 1 },
    };
    const fits = (k: Exclude<ChoiceLayout, 'auto'>) => {
      const d = defs[k];
      if (d.perRow === 1) return true;
      const info = this.paraInfo.get(d.style.paraPr);
      const h = this.charH.get(d.style.charPr) ?? 1000;
      const stops = [0, ...(info?.tabs ?? []).slice(0, d.perRow - 1)];
      if (stops.length < d.perRow) return false;
      const avail = this.colWidth - Math.max(0, info?.left ?? 0);
      const ends = [...stops.slice(1), avail];
      if (ends[ends.length - 1] - stops[stops.length - 1] < h * 3) return false;
      return ch.every((s, i) => {
        const col = i % d.perRow;
        return textWidth(`${CIRCLED[i]} ${s}`, h) + h * 0.6 <= ends[col] - stops[col];
      });
    };
    let layout = q.layout ?? 'auto';
    if (layout === 'auto') layout = n === 5 ? (['oneRow', 'twoRows', 'threeRows', 'vertical'] as const).find(fits)! : 'vertical';
    const d = defs[layout];
    let xml = '';
    for (let i = 0; i < n; i += d.perRow) {
      const parts = ch.slice(i, i + d.perRow).map((s, j) => `${j ? '\t' : ''}${CIRCLED[i + j]} ${s}`);
      xml += this.pText(d.style, parts.join(''));
    }
    return xml;
  }

  pointsText(p: number | string) {
    const d = this.opts.pointDecimals ?? 1;
    return `[${typeof p === 'number' ? p.toFixed(d) : p}점]`;
  }

  questionHead(numberText: string, stemFirst: string): string {
    const q = this.st('문제');
    const noCp = this.st('문제번호').charPr;
    return this.p(q, `<hp:run charPrIDRef="${noCp}"><hp:t>${esc(numberText)}</hp:t></hp:run>${this.runs(q.charPr, ' ' + stemFirst)}`);
  }

  mc(q: MCQuestion, no: number): string {
    const [first, ...rest] = q.stem.split('\n');
    const score = ' ' + this.pointsText(q.points);
    let xml = this.questionHead(`${no}.`, first + (rest.length ? '' : score));
    const cont = this.st('문제2', '문제');
    rest.forEach((l, i) => (xml += this.pText(cont, l + (i === rest.length - 1 ? score : ''))));
    if (q.bogi) xml += this.bogi(q.bogi);
    xml += q.table ? this.choiceTable(q.table) : this.choices(q);
    return xml + this.blank();
  }

  essay(q: EssayQuestion, no: number): string {
    const label = q.label ?? '서논술형';
    const lines = q.stem.split('\n');
    const subs = q.subQuestions ?? [];
    const score = q.scoreText ?? this.pointsText(q.points);
    const inlineScore = !subs.length && !q.bogi;
    const cont = this.st('문제2', '문제');
    let xml = this.questionHead(`[${label} ${no}]`, lines[0] + (inlineScore && lines.length === 1 ? ' ' + score : ''));
    lines.slice(1).forEach((l, i) => (xml += this.pText(cont, l + (inlineScore && i === lines.length - 2 ? ' ' + score : ''))));
    if (q.bogi) xml += this.bogi(q.bogi);
    subs.forEach((s) => (xml += this.pText(cont, s)));
    if (!inlineScore) xml += this.pText(cont, score);
    if (q.instruction) xml += this.pText(cont, `**${q.instruction}**`);
    for (let i = 0; i < (q.blankLines ?? 1); i++) xml += this.blank();
    return xml + this.blank();
  }

  group(g: QuestionGroup, range: string): string {
    const head = this.st('[∼]', '문제');
    let xml = this.pText(head, /^\s*\[/.test(g.instruction) ? g.instruction : `[${range}] ${g.instruction}`);
    const box = this.st('지문박스', '지문', '바탕글');
    const labelCp = this.charVariant(box.charPr, true);
    for (const ps of g.passages ?? []) {
      ps.text.split('\n').forEach((line, i) => {
        const lab = i === 0 && ps.label ? `<hp:run charPrIDRef="${labelCp}"><hp:t>${esc(ps.label)} </hp:t></hp:run>` : '';
        xml += this.p(box, lab + this.runs(box.charPr, line));
      });
    }
    if (g.passages?.length) xml += this.blank();
    return xml;
  }

  // ── 머리말 ──
  fillHeader(meta: ExamMeta) {
    const hdr = desc(this.root, 'header')[0];
    const tbl = hdr && desc(hdr, 'tbl')[0];
    if (!tbl) return;
    const cells = desc(tbl, 'tc');
    const setCell = (tc: El, text: string | undefined) => {
      if (text === undefined || !tc) return;
      const p = desc(tc, 'p')[0];
      const run = kids(p, 'run')[0];
      for (const c of kids(run)) run.removeChild(c);
      if (text) {
        const t = this.sec.createElementNS(NS.hp, 'hp:t');
        t.appendChild(this.sec.createTextNode(text));
        run.appendChild(t);
      }
    };
    setCell(cells[0], meta.schoolName);
    setCell(cells[1], meta.title);
    setCell(cells[2], meta.headerRight ?? '');
  }

  build(exam: ExamDoc) {
    let mcNo = 0, esNo = 0;
    const next = (q: MCQuestion | EssayQuestion) => (q.type === 'mc' ? ++mcNo : this.opts.continueEssayNumber ? ++mcNo : ++esNo);
    let xml = '';
    const notice = this.st('확인사항', '바탕글');
    for (const n of exam.meta.notice ?? []) xml += this.pText(notice, n);
    if (exam.meta.notice?.length) xml += this.blank();
    for (const it of exam.items) {
      if (it.type === 'group') {
        const nos = it.questions.map((q) => ({ q, no: next(q) }));
        const a = nos[0]?.no, b = nos[nos.length - 1]?.no;
        const span = a === b ? `${a}` : `${a}∼${b}`;
        const range = it.questions[0]?.type === 'essay' && !this.opts.continueEssayNumber ? `${(it.questions[0] as EssayQuestion).label ?? '서논술형'} ${span}` : span;
        xml += this.group(it, range);
        for (const { q, no } of nos) xml += q.type === 'mc' ? this.mc(q, no) : this.essay(q, no);
      } else {
        const no = next(it);
        xml += it.type === 'mc' ? this.mc(it, no) : this.essay(it, no);
      }
    }
    // 본문 삽입: 첫 문단(secPr·머리말·꼬리말 보관) 뒤 기존 문단은 지우고 새로 붙인다
    const ps = kids(this.root, 'p');
    for (const p of ps.slice(1)) this.root.removeChild(p);
    const frag = new this.dp().parseFromString(`<w xmlns:hp="${NS.hp}">${xml}</w>`, 'application/xml');
    const err = frag.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('본문 XML 조립 오류: ' + err.textContent);
    for (const p of kids(frag.documentElement)) this.root.appendChild(this.sec.importNode(p, true));
    this.fillHeader(exam.meta);
    for (const l of desc(this.root, 'linesegarray')) l.parentNode.removeChild(l);
    return { mcCount: mcNo, essayCount: esNo };
  }
}

// ───────────────────────── 공개 API ─────────────────────────

/** 양식 hwpx + 문항 데이터 → hwpx 바이트 */
export async function buildExamHwpx(template: ArrayBuffer | Uint8Array, exam: ExamDoc, opts: BuildOptions = {}): Promise<Uint8Array> {
  const DP = opts.dom?.DOMParser ?? (globalThis as any).DOMParser;
  const XS = opts.dom?.XMLSerializer ?? (globalThis as any).XMLSerializer;
  const zip = await JSZip.loadAsync(template);
  if (!zip.file('mimetype')) throw new Error('hwpx 파일이 아닙니다(mimetype 없음). .hwp 는 한글에서 hwpx 로 다시 저장해 주세요.');
  const SEC = 'Contents/section0.xml', HEAD = 'Contents/header.xml';
  const sec = new DP().parseFromString(await zip.file(SEC)!.async('string'), 'application/xml');
  const head = new DP().parseFromString(await zip.file(HEAD)!.async('string'), 'application/xml');

  new ExamBuilder(sec, head, DP, opts).build(exam);

  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
  const ser = (d: El) => decl + new XS().serializeToString(d.documentElement);
  const out = new JSZip();
  out.file('mimetype', await zip.file('mimetype')!.async('uint8array'), { compression: 'STORE' }); // 첫 항목·무압축
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name];
    if (f.dir || name === 'mimetype') continue;
    if (name === SEC) out.file(name, ser(sec));
    else if (name === HEAD) out.file(name, ser(head));
    else if (name === 'Preview/PrvText.txt') out.file(name, textOf(sec.documentElement).slice(0, 1000));
    else out.file(name, await f.async('uint8array'));
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** 브라우저: 생성 후 바로 다운로드 */
export async function downloadExamHwpx(template: ArrayBuffer, exam: ExamDoc, fileName?: string, opts: BuildOptions = {}) {
  const bytes = await buildExamHwpx(template, exam, opts);
  const blob = new Blob([bytes], { type: 'application/hwp+zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (fileName ?? `${exam.meta.title || '문제지'}.hwpx`).replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** base64(코드에 내장한 양식) → ArrayBuffer */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

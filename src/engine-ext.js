/**
 * 문서 엔진 확장 (hwpxExamExport 번들 뒤에 붙는다)
 *  - 인라인 수식 $…$ / $$…$$ → 한글 수식 개체(hp:equation, 한글 수식 스크립트)
 *  - 그림 항목 → hp:pic + BinData + content.hpf 등록
 *  - 일반 문단·일반 표·학생 구분(쪽 나눔) 항목
 * 수식 크기(sz)·기준선(baseLine)은 한글이 저장한 실제 값(지구과학 정답본)에 맞춘 근사식으로 계산한다.
 */
(() => {
  const B = globalThis.HwpxExamBuilder;
  if (!B) throw new Error('문서 엔진(HwpxExamBuilder)을 찾지 못했습니다');
  const P = B.prototype;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ───────────── LaTeX → 한글 수식 ─────────────
  const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
  const CMD = {
    times: 'times', div: 'div', cdot: 'cdot', pm: '+-', mp: '-+', le: '<=', leq: '<=', ge: '>=', geq: '>=', ne: '!=', neq: '!=',
    propto: 'PROPTO', infty: 'inf', partial: 'partial', cdots: 'cdots', ldots: 'cdots', dots: 'cdots', circ: 'circ', degree: 'circ',
    angle: 'angle', triangle: 'triangle', therefore: 'therefore', because: 'because',
    to: 'rarrow', rightarrow: 'rarrow', leftarrow: 'larrow', leftrightarrow: 'lrarrow', longrightarrow: 'rarrow',
    Rightarrow: 'RARROW', implies: 'RARROW', Leftarrow: 'LARROW', Leftrightarrow: 'LRARROW', iff: 'LRARROW',
    approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
    perp: '⊥', parallel: '∥', nabla: '∇', forall: '∀', exists: '∃', emptyset: '∅', prime: "'", ell: 'ℓ', hbar: 'ℏ',
    '%': '%', '#': '#', '&': '&', '$': '$', '{': 'LEFT{', '}': 'RIGHT}', ',': '~', ';': '~', ':': '~', ' ': '~', quad: '~~', qquad: '~~~~', '!': '',
    lbrace: '{', rbrace: '}', vert: '|', mid: '|', lvert: '|', rvert: '|', langle: '<', rangle: '>',
  };
  const FUNCS = new Set('sin cos tan cot sec csc log ln exp lim max min sum int prod det deg arcsin arccos arctan sinh cosh tanh'.split(' '));
  const BIG = new Set(['sum', 'int', 'prod', 'lim']);
  const ACC = { vec: 'vec', overrightarrow: 'vec', overline: 'bar', bar: 'bar', hat: 'hat', widehat: 'hat', dot: 'dot', ddot: 'ddot', tilde: 'tilde', underline: 'under' };

  function tokenize(s) {
    const t = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const m = s.slice(i + 1).match(/^([A-Za-z]+|.)/);
        t.push({ k: 'cmd', v: m ? m[1] : '', p: i }); i += 1 + (m ? m[1].length : 0); continue;
      }
      if (c === '{' || c === '}' || c === '^' || c === '_') { t.push({ k: c, p: i }); i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(c)) { let j = i; while (j < s.length && /[가-힣ㄱ-ㅎㅏ-ㅣ\s]/.test(s[j]) && s[j] !== '\\') j++; t.push({ k: 'kor', v: s.slice(i, j).trim() }); i = j; continue; }
      if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ k: 'num', v: s.slice(i, j) }); i = j; continue; }
      t.push({ k: 'ch', v: c }); i++;
    }
    return t;
  }
  // 노드: {s: 스크립트, w: 폭, a: 기준선 위 높이, d: 기준선 아래 깊이} (단위: baseUnit 배수)
  const atom = (s, w) => ({ s, w, a: 0.86, d: 0.35 });
  const row = (list) => list.length ? { s: list.map((n) => n.s).join(' '), w: list.reduce((x, n) => x + n.w, 0), a: Math.max(...list.map((n) => n.a)), d: Math.max(...list.map((n) => n.d)) } : { s: '', w: 0, a: 0.86, d: 0.35 };
  const brace = (n) => ({ ...n, s: `{${n.s}}` });
  const charW = (c) => (/[가-힣]/.test(c) ? 1.0 : /[A-Za-z]/.test(c) ? 0.62 : /[0-9]/.test(c) ? 0.55 : /[=+\-<>±×÷→⇒≤≥≠≈]/.test(c) ? 1.0 : /[(),.|]/.test(c) ? 0.38 : 0.7);

  function parseLatex(src) {
    const t = tokenize(src); let i = 0;
    const group = () => { // 인자 하나: {…} 또는 토큰 하나
      if (t[i]?.k === '{') { i++; const n = seq('}'); i++; return n; }
      const n = prim(); return n ?? row([]);
    };
    const optArg = () => { // [n]
      if (t[i]?.k === 'ch' && t[i].v === '[') { i++; const list = []; while (i < t.length && !(t[i].k === 'ch' && t[i].v === ']')) { const p = prim(); if (p) list.push(p); } i++; return row(list); }
      return null;
    };
    const textArg = () => { // 	ext{…} 원문 그대로(공백 포함)
      if (t[i]?.k !== '{') return '';
      const open = t[i]; let depth = 0, j = i;
      for (; j < t.length; j++) { if (t[j].k === '{') depth++; else if (t[j].k === '}' && --depth === 0) break; }
      const close = t[j];
      i = j + 1;
      return close ? src.slice(open.p + 1, close.p) : src.slice(open.p + 1);
    };
    function prim() {
      const k = t[i]; if (!k) return null;
      i++;
      if (k.k === '{') { const n = seq('}'); i++; return brace(n); }
      if (k.k === 'num') return atom(k.v, [...k.v].reduce((w, c) => w + charW(c), 0));
      if (k.k === 'kor') return atom(`"${k.v}"`, [...k.v].reduce((w, c) => w + charW(c), 0));
      if (k.k === 'ch') {
        const map = { '·': 'cdot', '×': 'times', '÷': 'div', '±': '+-', '≤': '<=', '≥': '>=', '≠': '!=', '→': 'rarrow', '⇒': 'RARROW', '∝': 'PROPTO', '∞': 'inf', '√': 'sqrt' };
        if (k.v === '√') { const b = group(); return { s: `sqrt {${b.s}}`, w: b.w + 0.7, a: b.a + 0.15, d: b.d }; }
        if (k.v === '"') return atom('\\"', 0.4);
        if (k.v === '~' || k.v === '`') return atom('~', 0.3);
        return atom(map[k.v] ?? k.v, charW(k.v));
      }
      if (k.k === 'cmd') {
        const c = k.v;
        if (c === 'frac' || c === 'dfrac' || c === 'tfrac') { const n = group(), d = group(); return { s: `{${n.s}} over {${d.s}}`, w: Math.max(n.w, d.w) + 0.5, a: n.a + n.d + 0.42, d: d.a + d.d - 0.18 }; }
        if (c === 'sqrt') { const ix = optArg(), b = group(); return ix ? { s: `root {${ix.s}} of {${b.s}}`, w: b.w + ix.w * 0.6 + 0.8, a: b.a + 0.25, d: b.d } : { s: `sqrt {${b.s}}`, w: b.w + 0.7, a: b.a + 0.15, d: b.d }; }
        if (ACC[c]) { const b = group(); return { s: `${ACC[c]} {${b.s}}`, w: b.w + 0.1, a: b.a + 0.3, d: b.d }; }
        if (c === 'text' || c === 'textrm' || c === 'mbox' || c === 'textbf' || c === 'mathrm' || c === 'operatorname' || c === 'mathbf') {
          const raw = textArg();
          const roman = c === 'mathrm' || c === 'operatorname' || (c !== 'mbox' && c !== 'text' && /^[A-Za-z]+$/.test(raw));
          if (roman && /^[A-Za-z0-9 ]+$/.test(raw)) return atom(`rm {${raw.trim()}} it`, [...raw].reduce((w, ch) => w + charW(ch), 0));
          return atom(`"${raw.replace(/"/g, '')}"`, [...raw].reduce((w, ch) => w + charW(ch), 0));
        }
        if (c === 'left' || c === 'right') { const d = t[i++]; const v = d?.k === 'cmd' ? (d.v === '{' ? '{' : d.v === '}' ? '}' : d.v === '|' ? '|' : d.v === 'langle' ? '<' : d.v === 'rangle' ? '>' : '') : d?.v === '.' ? '' : d?.v ?? ''; return atom(`${c} ${v || '.'}`, 0.4); }
        if (c === 'begin' || c === 'end') { textArg(); return null; }
        if (c === '\\') return atom('#', 0);
        if (GREEK.includes(c)) return atom(c, 0.62);
        if (GREEK.includes(c.toLowerCase())) return atom(c.toUpperCase(), 0.7);
        if (c === 'varepsilon') return atom('epsilon', 0.62);
        if (c === 'varphi') return atom('phi', 0.62);
        if (c === 'vartheta') return atom('theta', 0.62);
        if (FUNCS.has(c)) return atom(c, c.length * 0.5 + (BIG.has(c) ? 0.6 : 0.2));
        if (c in CMD) return atom(CMD[c], CMD[c] === '~' || CMD[c] === '' ? 0.3 : 1.0);
        return atom(c, c.length * 0.55);
      }
      return null;
    }
    function seq(stop) {
      const list = [];
      while (i < t.length && !(stop && t[i].k === stop)) {
        let base;
        if (t[i].k === '^' || t[i].k === '_') base = atom('', 0); else { base = prim(); if (!base) continue; }
        // 위·아래 첨자
        let sup = null, sub = null;
        while (t[i] && (t[i].k === '^' || t[i].k === '_')) { const which = t[i].k; i++; const g = group(); if (which === '^') sup = g; else sub = g; }
        if (sup || sub) {
          let s = base.s, w = base.w, a = base.a, d = base.d;
          if (sub) { s += ` _{${sub.s}}`; d = Math.max(d, 0.35 + 0.115 + (sub.a + sub.d - 1.21) * 0.6); }
          if (sup) { s += ` ^{${sup.s}}`; a = Math.max(a, 0.86 + 0.14 + (sup.a + sup.d - 1.21) * 0.6); }
          w += Math.max(sup ? sup.w * 0.7 : 0, sub ? sub.w * 0.7 : 0) + 0.05;
          base = { s, w, a, d };
        }
        list.push(base);
      }
      return row(list);
    }
    const n = seq(null);
    return { script: n.s.replace(/\s+/g, ' ').trim(), w: n.w + 0.25, h: n.a + n.d, base: n.a / (n.a + n.d) };
  }
  globalThis.latexToHwpEq = parseLatex;

  // ───────────── 인라인 토큰 (**진하게**, __밑줄__, $수식$) ─────────────
  function inlineTokens(s) {
    const out = []; let bold = false, und = false, buf = '', i = 0;
    const push = () => { if (buf) out.push({ text: buf, bold, underline: und }); buf = ''; };
    while (i < s.length) {
      if (s[i] === '$' && s[i - 1] !== '\\') {
        const dbl = s[i + 1] === '$', open = dbl ? 2 : 1;
        const j = s.indexOf(dbl ? '$$' : '$', i + open);
        const ok = j > i + open && (dbl || (s[j + 1] !== '$' && !/^\s/.test(s.slice(i + 1, i + 2))));
        if (ok) { push(); out.push({ math: s.slice(i + open, j), bold }); i = j + open; continue; }
      }
      if (s.startsWith('**', i)) { if (bold || /^\*\*[^*]+?\*\*/.test(s.slice(i))) { push(); bold = !bold; i += 2; continue; } }
      if (s.startsWith('__', i)) { if (und || /^__[^_\n]+?__/.test(s.slice(i))) { push(); und = !und; i += 2; continue; } }
      buf += s[i++];
    }
    push();
    return out.length ? out : [{ text: '' }];
  }
  globalThis.hwpInlineTokens = inlineTokens;

  P.runs = function (charPr, text) {
    return inlineTokens(String(text)).map((seg) => {
      if (seg.math !== undefined) return `<hp:run charPrIDRef="${charPr}">${this.equation(seg.math, charPr)}</hp:run>`;
      const t = esc(seg.text).split('\t').join('<hp:tab width="4000" leader="0" type="1"/>');
      return `<hp:run charPrIDRef="${this.charVariant(charPr, seg.bold, seg.underline)}">${t ? `<hp:t>${t}</hp:t>` : ''}</hp:run>`;
    }).join('');
  };
  P.equation = function (latex, charPr) {
    let r;
    try { r = parseLatex(latex); } catch { r = { script: `"${latex.replace(/"/g, '')}"`, w: latex.length * 0.6, h: 1.21, base: 0.71 }; }
    if (!r.script) return '';
    const bu = this.charH.get(charPr) ?? 1000;
    const W = Math.max(300, Math.round(r.w * bu)), H = Math.max(600, Math.round(r.h * bu)), base = Math.round(r.base * 100);
    return `<hp:equation id="${this.tblSeq++}" zOrder="${this.zSeq++}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${base}" textColor="#000000" baseUnit="${bu}" lineMode="CHAR" font="HancomEQN"><hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="56" right="56" top="0" bottom="0"/><hp:shapeComment>수식입니다.</hp:shapeComment><hp:script>${esc(r.script)}</hp:script></hp:equation>`;
  };

  // ───────────── 그림 ─────────────
  P.picture = function (it) {
    this.images ??= [];
    const n = this.images.length + 1, id = `ocrimg${n}`;
    const bin = atob(it.data), bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const ext = it.mime === 'image/png' ? 'png' : 'jpg';
    this.images.push({ id, file: `${id}.${ext}`, mime: it.mime === 'image/png' ? 'image/png' : 'image/jpg', bytes });
    const DW = Math.round(it.w * 75), DH = Math.round(it.h * 75); // 96dpi 기준 원본 크기
    const k = Math.min(1, (this.colWidth * (it.wide ? 0.95 : 0.7)) / DW, 32000 / DH);
    const W = Math.round(DW * k), H = Math.round(DH * k);
    const cs = this.st('바탕글'), cp = this.centerPara || cs.paraPr;
    const pic = `<hp:pic id="${this.tblSeq++}" zOrder="${this.zSeq++}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${this.tblSeq++}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="0" height="0"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${W >> 1}" centerY="${H >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="${id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:imgRect><hp:imgClip left="0" right="${DW}" top="0" bottom="${DH}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${DW}" dimheight="${DH}"/><hp:effects/><hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>그림입니다.</hp:shapeComment></hp:pic>`;
    return this.p(cs, `<hp:run charPrIDRef="${cs.charPr}">${pic}<hp:t/></hp:run>`, cp);
  };
  /** content.hpf 에 그림 등록 */
  P.manifest = function (hpf) {
    const items = (this.images ?? []).map((im) => `<opf:item id="${im.id}" href="BinData/${im.file}" media-type="${im.mime}" isEmbeded="1"/>`).join('');
    return hpf.replace('</opf:manifest>', items + '</opf:manifest>');
  };

  // ───────────── 확장 항목 ─────────────
  P.extItem = function (it) {
    if (it.type === 'text') {
      const cs = this.st('바탕글'), cp = this.centerPara || cs.paraPr;
      let xml = '';
      for (const l of String(it.text).split('\n')) xml += /^\s*\$\$.*\$\$\s*$/.test(l) ? this.p(cs, this.runs(cs.charPr, l.trim()), cp) : this.pText(cs, l);
      return xml + this.blank();
    }
    if (it.type === 'table') {
      const cs = this.st('바탕글'), cp = this.centerPara || cs.paraPr;
      const n = Math.max(1, ...it.rows.map((r) => r.length));
      const w = Math.floor((this.colWidth - 400) / n);
      return this.tablePara(cs, this.table(it.rows.map((r) => Array.from({ length: n }, (_, j) => this.p(cs, this.runs(cs.charPr, r[j] ?? ''), cp))), Array(n).fill(w), { inMargin: 141 })) + this.blank();
    }
    if (it.type === 'image') return it.data ? this.picture(it) : '';
    if (it.type === 'student') {
      const cs = this.st('바탕글');
      const label = [it.id ? `학번: ${it.id}` : '', it.name ? `이름: ${it.name}` : ''].filter(Boolean).join('    ');
      return (it.newPage ? '\u0001PB' : '') + this.pText(cs, `**${label}**`) + this.blank();
    }
    return null;
  };
})();

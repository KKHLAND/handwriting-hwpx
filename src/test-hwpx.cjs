// 앱(손글씨OCR.html)의 엔진·파서를 Node에서 그대로 돌려 테스트용 hwpx를 만든다.
// 사용: npm i jszip@3.10.1 @xmldom/xmldom@0.8.10 && node src/test-hwpx.cjs 손글씨OCR.html samples/지구과학_테스트.md 그림.jpg samples
const fs = require('fs'), vm = require('vm'), path = require('path');
const [, , htmlPath, mdPath, figPath, outDir] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
globalThis.window = globalThis;
window.JSZip = require('jszip');
globalThis.DOMParser = DOMParser; globalThis.XMLSerializer = XMLSerializer;
vm.runInThisContext(scripts.find((s) => s.includes('var HwpxExam')) + '\nglobalThis.HwpxExam = HwpxExam;');
vm.runInThisContext(scripts.find((s) => s.includes('const T=')).replace('const T=', 'globalThis.T='));
const app = scripts.find((s) => s.includes('function mdToExam'));
const parser = app.slice(app.indexOf("const CIRC = '"), app.lastIndexOf('// ═', app.indexOf('//  3. 미리보기')));
globalThis.state = { figs: {} };
vm.runInThisContext(parser.replace(/^const /gm, 'var ').replace(/^function /gm, 'function ') + '\nglobalThis.mdToExam = mdToExam; globalThis.studentLabel = studentLabel;');

const fig = fs.readFileSync(figPath);
state.figs['p1-1'] = { mime: 'image/jpeg', data: fig.toString('base64'), w: 414, h: 363 };
const md = fs.readFileSync(mdPath, 'utf8');
(async () => {
  for (const [v, tag] of [['1', '2단'], ['2', '1단']]) {
    const exam = mdToExam(md, state.figs);
    let k = 0; for (const it of exam.items) if (it.type === 'student') it.newPage = k++ > 0;
    if (!exam.meta.notice.length) delete exam.meta.notice;
    const bytes = await HwpxExam.buildExamHwpx(HwpxExam.base64ToArrayBuffer(T[v]), exam, { headerStyle: 'line', dom: { DOMParser, XMLSerializer } });
    const out = path.join(outDir, `수식그림_테스트_${tag}.hwpx`);
    fs.writeFileSync(out, bytes);
    const z = await window.JSZip.loadAsync(bytes);
    const sec = await z.file('Contents/section0.xml').async('string');
    console.log(out, bytes.length, 'eq', (sec.match(/<hp:equation /g) || []).length, 'pic', (sec.match(/<hp:pic /g) || []).length, 'pb', (sec.match(/pageBreak="1"/g) || []).length, Object.keys(z.files).filter((n) => n.includes('Bin')));
  }
})().catch((e) => { console.error(e); process.exit(1); });

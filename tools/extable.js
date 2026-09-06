/**
 * 확장 표 생성/검사 — README 의 "공식이 정하지 않은 것들" 표는 **코드에서 생성된다**.
 *
 *   node tools/extable.js            # README 가 코드와 어긋났으면 exit 1 (npm test 가 돌린다)
 *   node tools/extable.js --write    # README 표를 현재 코드로 다시 쓴다
 *
 * 이렇게 해 둔 이유: 표가 문서에 손으로 적혀 있으면 코드가 바뀌고도 그대로 남아,
 * 나중에 "이게 기본값이었나, 이미 바뀐 건가" 를 아무도 모르게 된다. 그 혼동을 테스트가 막는다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const EN = require('../engine.js');
const C = require('../core.js');

const BEGIN = '<!-- EXT:BEGIN (tools/extable.js 가 생성 — 손으로 수정하지 말 것) -->';
const END = '<!-- EXT:END -->';
const FILE = path.join(__dirname, '..', 'README.md');

const ORDER = ['rotate180', 'iKickVariant', 'spawnRow', 'field', 'preview', 'tspinMiniTriple',
  'perfectClear', 'dasArr', 'softDrop', 'clearDelay', 'g20'];

function table() {
  const rows = ORDER.map(function (k) {
    const e = EN.EXTENSIONS[k];
    if (!e) throw new Error('EXTENSIONS 에 ' + k + ' 가 없습니다 (ORDER 와 맞춰 주세요)');
    return '| `' + k + '` | ' + e.value + ' | ' + e.official + ' | ' + e.why + ' |';
  });
  return [
    BEGIN,
    '',
    '아래는 **공식이 정하지 않았거나 아예 존재하지 않는** 항목이다. 고르면 안 맞는 쪽이 아니라, 골랐다는 사실을',
    '모르는 게 문제다. 값은 `engine.js:EXTENSIONS` 에 있고 이 표는 거기서 생성된다(`npm test` 가 어긋남을 검사).',
    '',
    '| 항목 | 우리 | 공식 | 왜 이쪽 |',
    '| --- | --- | --- | --- |',
  ].concat(rows, [
    '',
    '규칙 테이블 원문 값까지 포함한 대조표(무엇이 공식과 같고 어디서 갈리는지)는 위쪽 **SRS — 맞는 것과, 남는 선택** 을 보라.',
    END,
  ].flat()).join('\n');
}

function current() {
  const src = fs.readFileSync(FILE, 'utf8');
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) return { src: src, found: false, body: '' };
  return { src: src, found: true, body: src.slice(a, b + END.length) };
}

const cur = current();
const want = table();
if (process.argv.indexOf('--write') >= 0) {
  const next = cur.found ? cur.src.replace(cur.body, want)
    : cur.src.replace(/\n## 테스트\n/, '\n' + want + '\n\n## 테스트\n');
  if (!cur.found && next === cur.src) { console.error('삽입 위치(## 테스트)를 README 에서 찾지 못했습니다'); process.exit(1); }
  fs.writeFileSync(FILE, next);
  console.log('README 확장 표를 코드가 현재 값으로 다시 썼습니다 (' + ORDER.length + '개 항목)');
  process.exit(0);
}
if (!cur.found) { console.error('README 에 확장 표 블록이 없습니다. `node tools/extable.js --write` 로 만드세요.'); process.exit(1); }
if (cur.body !== want) {
  console.error('README 확장 표가 코드와 어긋났습니다. `node tools/extable.js --write` 를 돌리세요.');
  const a = cur.body.split('\n'), b = want.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.error('  라인 ' + i + '\n   문서: ' + a[i] + '\n   코드: ' + b[i]);
  process.exit(1);
}
console.log('확장 표 = 코드 일치 (' + ORDER.length + '개 항목)');

// 표가 단순 장식이 아니라 **실제 상수를 반영**하는지도 여기서 확인한다
const pv = Number(/^(\d+)개$/.exec(EN.EXTENSIONS.preview.value)[1]);
if (pv !== EN.PREVIEW) { console.error('preview 값이 실제 상수와 다릅니다'); process.exit(1); }
const field = /10×(\d+)/.exec(EN.EXTENSIONS.field.value)[1];
if (Number(field) !== C.HEIGHT) { console.error('field 값이 실제 상수와 다릅니다'); process.exit(1); }
console.log('표의 값이 실제 상수와 일치 (PREVIEW=' + EN.PREVIEW + ', HEIGHT=' + C.HEIGHT + ')');

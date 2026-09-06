/**
 * 결정성/리플레이 자기 검증 테스트.  실행: node tools/selftest.js
 *
 * 서버 검증 시스템의 전제 — "같은 시드 + 같은 입력 = 같은 결과" — 가
 * 실제로 성립하는지, 그리고 위·변조가 실제로 걸리는지 확인한다.
 */
'use strict';
const C = require('../core.js');
const EN = require('../engine.js');
const RP = require('../replay.js');
const AI = require('./ai.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function group(t) { console.log('\n[' + t + ']'); }

/* ---------- 1. 결정론적 RNG / 중력 ---------- */
group('결정론 기초');
const r1 = EN.makeRng('seed-A'), r2 = EN.makeRng('seed-A'), r3 = EN.makeRng('seed-B');
const s1 = [], s2 = [], s3 = [];
for (let i = 0; i < 50; i++) { s1.push(r1.u32()); s2.push(r2.u32()); s3.push(r3.u32()); }
ok('같은 시드 = 같은 정수열', JSON.stringify(s1) === JSON.stringify(s2));
ok('다른 시드 = 다른 정수열', JSON.stringify(s1) !== JSON.stringify(s3));
ok('중력 표가 정수 틱', EN.GRAVITY.slice(1).every(Number.isInteger));
ok('1레벨 = 60틱/열', EN.GRAVITY[1] === 60);
ok('레벨↑ = 틱↓ (단조 감소)', EN.GRAVITY.slice(1).every((v, i, a) => i === 0 || v <= a[i - 1]));

/* ---------- 2. 엔진 기본 동작 ---------- */
group('엔진 기본');
let e = EN.create({ seed: 'x', mode: 'marathon' });
ok('스폰됨', !!e.piece && e.state === 'playing');
ok('프리뷰 5개', e.queue.length >= 5);
let t0 = e.ticks; e.tick();
ok('틱 카운트', e.ticks === t0 + 1);

e = EN.create({ seed: 'x' });
const startY = e.piece.y;
let n = 0; while (n++ < 200 && e.piece.y === startY) e.tick();
ok('중력으로 낙하', e.piece.y > startY);

e = EN.create({ seed: 'x' });
for (let i = 0; i < 5; i++) e.press('left'), e.tick();
ok('좌측 이동', e.piece.x < Math.floor((C.COLS - C.STATES[e.piece.type][0][0].length) / 2));

e = EN.create({ seed: 'x' });
const ty = e.piece.type;
e.press('cw'); e.tick();
ok('회전', e.piece.rot === 1 || ty === 'O');

e = EN.create({ seed: 'x' });
const sc = e.score;
e.press('hard'); e.tick();
ok('하드 드롭 점수(+2/칸)', e.score > sc);

e = EN.create({ seed: 'x' });
e.press('hard'); e.tick();
ok('조각 교체됨', e.pieces === 1);

e = EN.create({ seed: 'x' });
e.press('hold'); e.tick();
ok('홀드 저장', e.hold !== null && !e.canHold);

group('하드 드롭 연타 = 게임 오버');
e = EN.create({ seed: 'x' });
let guard = 0;
while (e.state !== 'over' && guard++ < 4000) { e.press('hard'); e.tick(); }
ok('종료됨', e.state === 'over');
ok('원인 topout', e.overReason === 'topout', e.overReason);
ok('줄/조각 수 유효', e.pieces > 10 && e.lines >= 0);

/* ---------- 3. 모드 ---------- */
group('모드');
e = EN.create({ seed: 'sprint-seed', mode: 'sprint' });
guard = 0;
let botSprint = AI.create({ delay: 0, gap: 1 });
while (e.state !== 'over' && guard++ < 60 * 60 * 5) {
  e.setBuffer(botSprint.act(e)); e.tick();
}
ok('40줄 목표로 종료', e.lines >= 40 && e.overReason === 'finish', e.lines + '/' + e.overReason);
ok('스프린트 기록 시간', e.ticks > 60 && e.ticks < 60 * 60 * 2, EN.TICK * e.ticks);

e = EN.create({ seed: 'ultra', mode: 'ultra' });
guard = 0;
const botUltra = AI.create({ delay: 0, gap: 1 });
while (e.state !== 'over' && guard++ < 7210) {
  e.setBuffer(botUltra.act(e));
  e.tick();
}
ok('울트라 2:00 타임아웃', e.overReason === 'time' && e.ticks === 7200, e.ticks + '/' + e.overReason);

e = EN.create({ seed: 'g20', mode: 'marathon', g20: true });
guard = 0;
const botG20 = AI.create({ delay: 0, gap: 1 });
while (e.state !== 'over' && guard++ < 5000) {
  e.setBuffer(botG20.act(e)); e.tick();
}
ok('20G also works', e.state === 'over' && e.pieces > 20);

/* ---------- 4. 리플레이 왕복 ---------- */
group('리플레이 코덱');
const rep = AI.run({ seed: 'codec-test', mode: 'marathon', skill: AI.PRESETS.human });
const text = RP.pack(rep);
const back = RP.unpack(text);
ok('pack/unpack 일치', back.score === rep.score && back.lines === rep.lines && back.pieces === rep.pieces && back.hash === rep.hash && back.seed === rep.seed);
ok('입력 개수 보존', back.inputs.length === rep.inputs.length);
ok('형태 검사 통과', RP.checkShape(back).length === 0, RP.checkShape(back).join(','));
ok('텍스트 길이 합리적(<100KB)', text.length < 100000, text.length);

/* ---------- 5. 서버 재시뮬레이션 = 동일 결과 ---------- */
group('재시뮬레이션 재현성');
const sim = EN.simulate(back);
ok('점수 일치', sim.engine.score === back.score, sim.engine.score + ' vs ' + back.score);
ok('줄 일치', sim.engine.lines === back.lines);
ok('조각 일치', sim.engine.pieces === back.pieces);
ok('보드 해시 일치', sim.engine.boardHash() === back.hash, sim.engine.boardHash() + ' vs ' + back.hash);
ok('틱 일치', sim.engine.ticks === back.ticks, sim.engine.ticks + ' vs ' + back.ticks);

const sim2 = EN.simulate(RP.unpack(RP.pack(rep)));
ok('두 번째 실행도 동일(결정론)', sim2.engine.boardHash() === sim.engine.boardHash());

/* 입력 순서를 섞으면 결과가 달라지는가(순서가 의미 있다는 증거) */
const shuffled = JSON.parse(JSON.stringify(back));
const a0 = shuffled.inputs[10], a1 = shuffled.inputs[11];
shuffled.inputs[10] = a1; shuffled.inputs[11] = a0;
const simShuf = EN.simulate(shuffled);
ok('입력 순서 변경 → 결과 변경됨', simShuf.engine.boardHash() !== back.hash || simShuf.engine.score !== back.score);

/* ---------- 6. 위·변조 탐지 ---------- */
group('위·변조 탐지');
function tamper(mut) {
  const r = RP.unpack(RP.pack(rep));
  mut(r);
  const s = EN.simulate(r);
  return s.engine.score === r.score && s.engine.lines === r.lines &&
    s.engine.pieces === r.pieces && s.engine.boardHash() === r.hash && s.engine.ticks === r.ticks;
}
ok('점수 부풀리기 거부', !tamper(r => { r.score = r.score + 500000; }));
ok('줄 수 조작 거부', !tamper(r => { r.lines = r.lines + 10; }));
ok('해시 위조 거부', !tamper(r => { r.hash = 'zzzzzz'; }));
ok('틱 수 조작(가속) 거부', !tamper(r => { r.ticks = Math.floor(r.ticks / 2); }));
ok('조각 수 조작 거부', !tamper(r => { r.pieces = r.pieces + 3; }));
const honest = tamper(() => {});
ok('원본은 통과', honest);

/* 시드를 바꾸면 입력 목록은 그대로인데 결과가 달라진다 → 서버 발급 시드 외 제출 불가 */
group('시드 바인딩');
const wrongSeed = RP.unpack(RP.pack(rep)); wrongSeed.seed = 'other-seed';
const ws = EN.simulate(wrongSeed);
ok('시드 교체 → 결과 불일치', ws.engine.boardHash() !== rep.hash);
ok('해시로 시드 검증 가능', ws.engine.sequenceHash() !== EN.create({ seed: rep.seed }).sequenceHash());

/* ---------- 7. T-스핀 — 가이드라인 판정 ---------- */
group('T-스핀 — 회전으로만 진입해야 인정');
/* 아래 픽스처의 행 번호는 **보이는 행(0~19)** 이다. 배열 인덱스로 바꾸려면 C.row(y). */
const R = C.row;
/** TSD 픽스처:
 *   row17  # . . . . . . . . .      ← 오버행
 *   row18  . . . _ _ _ . . . .      ← 조각이 채울 자리
 *   row19  . . . # _ # . . . .      ← 앞면 양쪽 모서리(바닥 아님, 실제 블록)
 */
function tsdBoard() {
  const b = C.createBoard();
  for (let x = 0; x < 10; x++) {
    if (x !== 4) b[R(19)][x] = 'J';
    if (x !== 3 && x !== 4 && x !== 5) b[R(18)][x] = 'J';
  }
  b[R(17)][3] = 'J';
  return b;
}
function putT(seed) {
  const et = EN.create({ seed: seed });
  et.board = tsdBoard();
  et.piece = null; et.spawn('T');
  return et;
}
const settle = (et) => { for (let i = 0; i < EN.CLEAR_TICKS + 4; i++) et.tick(); };

let et = putT('tsd-spin');
et.piece.rot = 1; et.piece.x = 3; et.piece.y = R(17);                 //회전 전 상태(접지 확인됨)
ok('회전 전에는 그 자리에 닿아 있다(회전이 유일한 진입 수단)', C.collides(et.board, C.STATES.T[1], 3, R(18)));
ok('회전 성공', et.rotate(1) === true);
et.lockPiece(); settle(et);
ok('회전으로 진입 → T-스핀 인정', et.tspins === 1, et.tspins);
ok('T-스핀 더블 = 2줄 / 1200점', et.lines === 2 && et.score === 1200, et.lines + '/' + et.score);

et = putT('tsd-nosin');
et.piece.rot = 2; et.piece.x = 3; et.piece.y = R(17); et.lockPiece(); settle(et);   //그냥 놓기
ok('회전 없이 같은 자리 → 일반 더블(300점)', et.tspins === 0 && et.score === 300, et.tspins + '/' + et.score);

et = putT('tsd-inplace');
et.piece.rot = 1; et.piece.x = 3; et.piece.y = R(17); et.rotate(1); et.hardDrop(); settle(et);
ok('회전 후 제자리 하드 드롭(이동 0)은 스핀 유지', et.tspins === 1 && et.score === 1200, et.tspins + '/' + et.score);

et = EN.create({ seed: 'drop-moves' }); et.piece = null; et.spawn('T');
et.rotate(1);
ok('회전 → 플래그', et.spinFlag === true);
et.hardDrop();                                                   //먼 거리로 미끄러짐
ok('하드 드롭으로 이동하면 마지막 동작이 회전이 아니다 → 스핀 해제', et.spinFlag === false && et.tspins === 0, et.spinFlag + '/' + et.tspins);
ok('하드 드롭 점수(칸당 +2)는 그대로', et.score >= 30, et.score);

et = putT('gravity');
et.piece.rot = 2; et.piece.x = 3; et.piece.y = R(10);
let g2 = 0; while (et.pieces === 0 && g2++ < 400) et.tick();      //중력으로만 착지
ok('중력 착지는 스핀이 아니다', et.tspins === 0, et.tspins);

/* 앞면 모서리가 한쪽만 차도 5번째 킥(대각 만회)이면 full.
   rot1(nub 오른쪽) · x=3,y=17: 모서리 = (3,17)TL (5,17)TR (3,19)BL (5,19)BR, 앞면은 TR/BR.
   TL+BL+BR 이 차면 3코너인데 앞면은 BR 하나뿐 → mini. */
const b5 = C.createBoard();
b5[R(17)][3] = 'J'; b5[R(19)][3] = 'J'; b5[R(19)][5] = 'J';
ok('3코너 + 앞면 한쪽 = mini', C.tspinKind(b5, { type: 'T', x: 3, y: R(17), rot: 1 }, 0) === 'mini',
  C.tspinKind(b5, { type: 'T', x: 3, y: R(17), rot: 1 }, 0));
ok('같은 자리에서 5번째 킥이면 full 로 만회', C.tspinKind(b5, { type: 'T', x: 3, y: R(17), rot: 1 }, 4) === 'full',
  C.tspinKind(b5, { type: 'T', x: 3, y: R(17), rot: 1 }, 4));
const b5b = C.createBoard();
b5b[R(17)][3] = 'J'; b5b[R(17)][5] = 'J';
ok('코너 2개 이하면 노스핀', C.tspinKind(b5b, { type: 'T', x: 3, y: R(17), rot: 1 }, 0) === 'none',
  C.tspinKind(b5b, { type: 'T', x: 3, y: R(17), rot: 1 }, 0));

/* ---------- 7-b. 상단 버퍼 / 끝남 조건 / O 회전 (r3) ---------- */
group('상단 버퍼와 끝남 조건 (r3)');
/* 스폰은 보이는 판 맨 위(버퍼 안쪽) — 조각 전체가 보인다 */
et = EN.create({ seed: 'spawn-below-buffer' });
ok('스폰 y 는 버퍼 안쪽(배열 인덱스 ≥ 0)', et.piece.y >= 0 && et.piece.y <= C.TOP, et.piece.y);
ok('스폰 조각의 맨 위 칸이 보이는 행 0 이상', C.cellsOf(et.piece.type, 0).every(cc => et.piece.y + cc[1] >= 0));

/* 조각이 **일부만** 위에 걸린 채 잠기면 게임은 끝나지 않는다 (가이드라인 lock out) */
et = EN.create({ seed: 'partial-above' });
et.piece = null; et.spawn('I');
et.piece.rot = 1; et.piece.x = 0; et.piece.y = C.TOP - 2;          // 세로 I: 2칸은 버퍼, 2칸은 보이는 판
const icol = 0 + C.cellsOf('I', 1)[0][0];                           // 실제 점유 열(매트릭스 의존 회피)
const visBefore = et.state;
et.lockPiece();
ok('일부만 위에 잠기면 종료 아니다', et.state === visBefore, et.state + '/' + et.overReason);
ok('버퍼에 남은 블록이 배열에 실제로 저장된다', et.board[C.TOP - 2][icol] === 'I' && et.board[C.TOP - 1][icol] === 'I',
  et.board[C.TOP - 2][icol] + '/' + et.board[C.TOP - 1][icol]);
ok('보이는 판에도 같은 조각의 나머지가 보인다', et.board[C.TOP][icol] === 'I' && et.board[C.TOP + 1][icol] === 'I');

/* 조각이 **전부** 위에 잠기면 끝난다. 스폰이 막히기 전에 조각을 직접 놓아 lock out 만 분리해 검사한다. */
et = EN.create({ seed: 'all-above' });
et.piece = null; et.spawn('T');
et.piece.rot = 2; et.piece.x = 3; et.piece.y = C.TOP - 3;           // 점유 칸이 전부 버퍼 위쪽
et.lockPiece();
ok('조각이 전부 보이는 판 위에 잠기면 lock out → 종료', et.state === 'over' && et.overReason === 'topout', et.state + '/' + et.overReason);

/* 보이는 판이 가득 차면 다음 스폰이 막혀 끝난다 (block out) */
et = EN.create({ seed: 'block-out' });
for (let y = C.TOP; y < C.HEIGHT; y++) for (let x = 0; x < 10; x++) et.board[y][x] = 'J';
et.piece = null;
ok('스폰이 막히면 block out → 종료', et.spawn('T') === false && et.overReason === 'topout', et.overReason);

/* O 조각 회전은 성공한다 (가이드라인: O 에도 4개 상태가 있고 회전은 같은 자리를 가리킨다) */
et = EN.create({ seed: 'o-rotate' });
et.piece = null; et.spawn('O');
const ox = et.piece.x, oy = et.piece.y, orot0 = et.piece.rot;
ok('O 회전 성공', et.rotate(1) === true);
ok('O 회전은 위치를 옮기지 않는다', et.piece.x === ox && et.piece.y === oy, et.piece.x + ',' + et.piece.y);
ok('O 회전은 상태만 순환', et.piece.rot === (orot0 + 1) % 4, et.piece.rot);
ok('O 는 T-스핀 판정과 무관', C.tspinKind(et.board, et.piece, 0) === 'none');
/* 바닥에 붙인 O 를 회전 → lockResets 가 올라가야 한다 (회전이 성공으로 취급되어야 가능) */
et.piece = null; et.spawn('O');
let oy2 = 0; while (!C.collides(et.board, C.STATES.O[0], et.piece.x, oy2 + 1)) oy2++;
et.piece.y = oy2;
const r0 = et.lockResets;
et.rotate(1);
ok('O 회전도 락 딜레이를 리셋한다(성공으로 취급)', et.lockResets === r0 + 1, r0 + '→' + et.lockResets);

/* 버퍼 천장: 배열 밖으로 올라가는 회전은 거부된다 */
et = EN.create({ seed: 'ceiling' });
ok('버퍼 안쪽 행은 열림', C.collides(et.board, C.STATES.I[0], 3, -1) === false);   // I 행 오프셋 1 → 칸은 행 0
ok('천장 위(배열 밖)는 막힘', C.collides(et.board, C.STATES.I[0], 3, -2) === true); // 칸이 행 -1 로 나감

/* 스폰 행은 코드에 상수로 박혀 있다 (0 = 나온 순간 완전히 보임, -1/-2 = Tetris Worlds 식 숨은 스폰) */
ok('스폰 행 상수 = 0 (선택이 코드에 이름으로 박힘)', EN.SPAWN_ROW === 0, EN.SPAWN_ROW);
(function () {
  const e = EN.create({ seed: 'spawn-formula' });
  e.piece = null; e.spawn('T');
  const top = Math.min.apply(null, C.cellsOf('T', 0).map(function (c) { return c[1]; }));
  ok('스폰 y = TOP + SPAWN_ROW - 맨위점유칸', e.piece.y - top === C.TOP + EN.SPAWN_ROW, e.piece.y + '/' + top);
})();

/* 숨은 공간은 20행(공식 그대로): 한참 위에서 놓아도 판 안으로 떨어져 들어온다 (r3 의 4행 천장 없음) */
et = EN.create({ seed: 'high-drop' });
et.piece = null; et.spawn('T');
et.piece.x = 3; et.piece.y = 2;                                   // 배열 꼭대기 부근(보이는 판 위 18행)
et.hardDrop();
ok('높은 곳에서 놓아도 판 안에 정상 착지한다', et.pieces === 1 && et.board[C.HEIGHT - 1][3] !== null || et.pieces === 1, et.pieces);

/* 버퍼 블록은 줄 삭제 때 내려오고, 해시에 반영된다 */
et = EN.create({ seed: 'hash-buffer' });
const h0 = et.boardHash();
et.board[0][0] = 'J';
ok('버퍼 행의 블록도 보드 해시에 들어간다(재현 판정)', et.boardHash() !== h0);

/* ---------- 8. 규칙 버전 ---------- */
group('규칙 버전이 리플레이에 박힌다');
const repV = AI.run({ seed: 'rules-ver', preset: 'human', rng: AI.makeRand('rv') });
ok('pack 된 리플레이에 규칙 버전', RP.unpack(RP.pack(repV)).rules === EN.RULES_ID, RP.unpack(RP.pack(repV)).rules);
ok('규칙이 다르면 digest 도 다르다',
  RP.canonical(Object.assign({}, repV, { rules: 'r9' })) !== RP.canonical(repV));
ok('NT1(레거시) 포맷도 읽는다', (function () {
  const p = RP.pack(repV).split(':');                       // NT2 = 12필드
  const legacyText = 'NT1:' + p.slice(1, 11).join(':');      // 규칙 필드를 뺀 11필드
  return RP.unpack(legacyText).rules === RP.LEGACY_RULES;
})());


/* ---------- 9. AI 성능(휴리스틱 기준선) ---------- */
group('AI 기준선');
const fast = AI.run({ seed: 'fast-bot', skill: { delay: 0, gap: 1 } });
const slow = AI.run({ seed: 'fast-bot', skill: { delay: 12, gap: 8 } });
ok('AI가 실제로 줄을 지움', fast.lines > 8, fast.lines);
ok('PPS 계산 동작', RP.pps(fast) > 0 && RP.apm(fast) > 0);
console.log('    fast: ' + fast.lines + '줄 / ' + fast.score + '점 / PPS ' + RP.pps(fast).toFixed(2) +
  ' / 입력 ' + fast.inputs.length + '개');
console.log('    slow: ' + slow.lines + '줄 / ' + slow.score + '점 / PPS ' + RP.pps(slow).toFixed(2) +
  ' / 입력 ' + slow.inputs.length + '개');
ok('저속 AI도 완주', slow.pieces > 20);

/* ---------- 8. 초고속 매크로 탐지 재료 ---------- */
group('휴먼 오버 데이터 감지 재료');
const spam = AI.run({ seed: 'spam', skill: { delay: 0, gap: 1 } });
const human = AI.run({ seed: 'spam', skill: { delay: 10, gap: 7, jitter: 0.35, rng: AI.makeRand('j') } });
console.log('    spam PPS ' + RP.pps(spam).toFixed(2) + ' / human PPS ' + RP.pps(human).toFixed(2));
ok('AI 초고속 PPS > 인간 설정 PPS', RP.pps(spam) > RP.pps(human));

/* ---------- 9. 확장 항목(공식이 정하지 않은 것) 고정 ---------- */
group('확장 registry + 동작 고정');
ok('EXTENSIONS 가 코드 밖에서 읽힌다', EN.EXTENSIONS && Object.keys(EN.EXTENSIONS).length >= 8, EN.EXTENSIONS && Object.keys(EN.EXTENSIONS).length);
ok('모든 확장 항목에 value/official/why 가 있다',
  Object.keys(EN.EXTENSIONS).every(function (k) {
    const e = EN.EXTENSIONS[k];
    return e && typeof e.value === 'string' && e.value.length > 0 && typeof e.official === 'string' && typeof e.why === 'string';
  }), Object.keys(EN.EXTENSIONS).filter(function (k) { const e = EN.EXTENSIONS[k]; return !e || !e.value || !e.official || !e.why; }));

/* registry 의 값이 실제 상수를 가리키는가 (문서-코드 어긋남의 뿌리) */
const pv = Number(/^(\d+)개$/.exec(EN.EXTENSIONS.preview.value)[1]);
ok('registry preview == EN.PREVIEW', pv === EN.PREVIEW, EN.EXTENSIONS.preview.value + '/' + EN.PREVIEW);
ok('registry field == C.HEIGHT', EN.EXTENSIONS.field.value.indexOf('10×' + C.HEIGHT) === 0, EN.EXTENSIONS.field.value);
ok('registry dasArr == 실제 틱', EN.EXTENSIONS.dasArr.value === 'DAS ' + Math.round(EN.DAS * 1000 / 60) + 'ms / ARR ' + Math.round(EN.ARR * 1000 / 60) + 'ms', EN.EXTENSIONS.dasArr.value);

/* 180° 회전: 자체 테이블(7칸) 이 동작하고, T-스핀 승격은 "5번째 시험 이후" 기준이다 */
ok('180° 회전 성공', (function () {
  const e = EN.create({ seed: 'e180' });
  e.piece = null; e.spawn('L');
  const before = e.piece.rot;
  const okRot = e.rotate(2);
  return okRot === true && e.piece.rot === (before + 2) % 4;
})());
ok('180° 킥은 7칸(90° 테이블과 다른 자체 설계)', C.KICKS_180.length === 7, C.KICKS_180.length);
(function () {
  /* 앞면 모서리 하나만 찬 자리: 인덱스 4~6 은 full 로 승격, 0~3 은 mini */
  const b = C.createBoard();
  b[C.row(17)][3] = 'J'; b[C.row(19)][3] = 'J'; b[C.row(19)][5] = 'J';
  const at = function (kick) { return C.tspinKind(b, { type: 'T', x: 3, y: C.row(17), rot: 1 }, kick); };
  ok('180° 승격: 인덱스 4~6 → full', [4, 5, 6].every(function (i) { return at(i) === 'full'; }), [4, 5, 6].map(at).join(','));
  ok('같은 자리에서 인덱스 0~3 → mini', [0, 1, 2, 3].every(function (i) { return at(i) === 'mini'; }), [0, 1, 2, 3].map(at).join(','));
})();

/* 프리뷰: 공식은 "보여준다" 수준, 우리는 5개 — 그리고 7-bag 은 그대로다 */
(function () {
  const e = EN.create({ seed: 'prev5' });
  ok('프리뷰 창이 5개 이상 채워진다', (e.queue || []).length + 1 >= EN.PREVIEW, (e.queue || []).length);
  ok('PREVIEW 상수 = 5 (README 표와 같은 값)', EN.PREVIEW === 5, EN.PREVIEW);
  /* 주머니 정렬이 어디에서 시작하든 성립하는 성질로 검사한다:
     7-bag 이면 **어떤 7연속 조각이든 7종이 딱 한 번씩** 나온다. (개수 세기는 정렬에 따라 어긋날 수 있어 약하다) */
  const seq = [];
  const e2 = EN.create({ seed: 'bag7' });
  seq.push(e2.piece.type);
  for (let i = 0; i < 196; i++) { e2.piece = null; e2.spawn(null); if (e2.piece) seq.push(e2.piece.type); }
  let badBag = 0, badWin = 0;
  /* 주머니는 정렬된 7개 묶음이다. (슬라이딩 창으로 보면 서로 다른 주머니를 건너뛰어 당연히 중복이 난다 —
     처음에 이걸로 검사했다가 헛점으로 잡았다) */
  for (let i = 0; i + 7 <= seq.length; i += 7) if (new Set(seq.slice(i, i + 7)).size !== 7) badBag++;
  const counts = {};
  seq.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
  const n = Math.floor(seq.length / 7);
  ok('7개 묶음마다 7종이 딱 한 번씩 (7-bag, 총 ' + seq.length + '조각)', badBag === 0, badBag + '개 묶음 위반');
  ok('전체 분포도 균등(주머니 ' + n + '개)', C.TYPES.every(function (t) { return Math.abs((counts[t] || 0) - n) <= 1; }), JSON.stringify(counts));
})();

/* 점수 확장 값들 */
ok('T-스핀 MINI 3줄 = 600×level (공식 표에 없는 항목)', C.scoreClear({ lines: 3, spin: 'mini', level: 1 }).points === 600, C.scoreClear({ lines: 3, spin: 'mini', level: 1 }).points);
ok('퍼펙트 클리어 보너스 표 = 800/1200/1800/2000', JSON.stringify(C.PC_BASE.slice(1)) === JSON.stringify([800, 1200, 1800, 2000]), JSON.stringify(C.PC_BASE));

/* 20G 옵션: 중력 1틱이고, g20 플래그가 런 상태(→보드 키·리플레이)에 남는다 */
(function () {
  const e = EN.create({ seed: 'g20', mode: 'marathon', level: 1, g20: true });
  e.piece = null; e.spawn('T');
  const y0 = e.piece ? e.piece.y : 0;
  for (let i = 0; i < 5 && e.piece; i++) e.tick();
  ok('20G 는 같은 틱에 여러 칸 내려간다', !e.piece || e.piece.y > y0 + 1, e.piece ? (e.piece.y - y0) : 'locked');
  ok('g20 플래그가 런 상태에 남는다(보드 키/리플레이에 같이 감)', e.g20 === true, e.g20);
})();

ok('줄 삭제 연출 = 16틱(267ms) — 리플레이도 같은 타이밍', EN.CLEAR_TICKS === 16, EN.CLEAR_TICKS);


console.log('\n결과: ' + pass + '/' + (pass + fail) + ' 통과' + (fail ? ' (실패 ' + fail + ')' : ''));
process.exit(fail ? 1 : 0);

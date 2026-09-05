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
ok('40줄에서 종료', e.lines === 40 && e.overReason === 'finish', e.lines + '/' + e.overReason);
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

/* ---------- 7. AI 성능(휴리스틱 기준선) ---------- */
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

console.log('\n결과: ' + pass + '/' + (pass + fail) + ' 통과' + (fail ? ' (실패 ' + fail + ')' : ''));
process.exit(fail ? 1 : 0);

/* core.js 로직 테스트: node test.js */
const C = require('./core.js');
let fails = 0, ran = 0;
function ok(cond, msg) {
  ran++;
  if (!cond) { fails++; console.log('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}
function key(cells) { return cells.map(function (c) { return c[0] + ',' + c[1]; }).sort().join(' | '); }

console.log('\n[조각/회전]');
C.TYPES.forEach(function (t) {
  ok(C.STATES[t].length === 4, t + ': 회전 상태 4개');
  ok(C.cellsOf(t, 0).length === 4, t + ': 칸 4개');
  const a = key(C.cellsOf(t, 0)), b = key(C.cellsOf(t, 4));
  ok(a === b, t + ': 4회 회전 후 원복');
});
// O 조각은 회전해도 형태 동일
ok(key(C.cellsOf('O', 1)) === key(C.cellsOf('O', 0)), 'O: 회전 불변');
// T 방향 확인 (0=위, 1=오른쪽, 2=아래, 3=왼쪽)
ok(key(C.cellsOf('T', 0)) === '0,1 | 1,0 | 1,1 | 2,1', 'T rot0 = 위쪽 향함');
ok(key(C.cellsOf('T', 2)) === '0,1 | 1,1 | 1,2 | 2,1', 'T rot2 = 아래쪽 향함');

console.log('\n[스폰 위치]');
C.TYPES.forEach(function (t) {
  const m = C.STATES[t][0];
  const x = Math.floor((C.COLS - m[0].length) / 2);
  const y = -C.EMPTY_TOP[t];
  ok(!C.collides(C.createBoard(), m, x, y), t + ': 스폰 위치 유효');
  const cells = C.cellsOf(t, 0).map(function (c) { return c[1] + y; });
  ok(Math.min.apply(null, cells) >= 0, t + ': 스폰 시 화면 위쪽 잘림 없음');
});
const oCols = C.cellsOf('O', 0).map(function (c) { return c[0] + 4; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
ok(oCols.join() === '4,5', 'O: 중앙 정렬 (열 4,5)');

console.log('\n[충돌/월킥]');
(function () {
  const b = C.createBoard();
  for (let x = 0; x < C.COLS; x++) b[C.ROWS - 1][x] = 'J';
  ok(C.collides(b, C.STATES.I[0], 3, 18), '바닥 접촉 감지');
  ok(!C.collides(b, C.STATES.I[0], 3, 16), '바닥 여유 있으면 통과');
  ok(C.collides(b, C.STATES.J[0], -1, 0), '왼쪽 벽 감지');
  ok(C.collides(b, C.STATES.J[0], 8, 0), '오른쪽 벽 감지');
  ok(!C.collides(b, C.STATES.J[0], 0, -2), '천장 위는 열림');
})();
// I 조각 스피너 월킥: 왼쪽 벽에 붙었을 때 회전 가능해야 함
(function () {
  const b = C.createBoard();
  const from = 1, to = 2;
  const kicks = C.kicksFor('I', from, to);
  ok(kicks.length === 5, 'I 킥 5개 후보');
  ok(C.kicksFor('O', 0, 1).length === 1, 'O 킥 없음');
})();

console.log('\n[회전 + 월킥 통합]');
// game.js 의 회전 로직과 동일하게 재현
 function tryRotate(b, p, dir) {
  const from = p.rot;
  const to = dir === 2 ? (p.rot + 2) % 4 : (p.rot + (dir > 0 ? 1 : 3)) % 4;
  const table = dir === 2 ? C.KICKS_180 : C.kicksFor(p.type, from, to);
  const m = C.STATES[p.type][to];
  for (let i = 0; i < table.length; i++) {
    if (!C.collides(b, m, p.x + table[i][0], p.y + table[i][1])) {
      return { x: p.x + table[i][0], y: p.y + table[i][1], rot: to, kick: i };
    }
  }
  return null;
}
(function () {
  const b = C.createBoard();
  // I 세움 → 왼쪽 벽에 밀착 (열 0)
  const p = { type: 'I', x: -2, y: 16, rot: 1 };
  ok(!C.collides(b, C.STATES.I[1], p.x, p.y), 'I 세움/왼쪽 벽 밀착 상태');
  const r = tryRotate(b, p, 1);
  ok(r !== null && r.kick > 0, '벽에 붙은 I 회전 = 월킥 발동 (kick #' + (r && r.kick) + ')');
  ok(r && !C.collides(b, C.STATES.I[r.rot], r.x, r.y), '킥 후 위치 유효');
  // 스피너: 위가 막혀 있어도 회전 가능
  // 막힌 회전는 실패해야 함
  const b3 = C.createBoard();
  for (let y = 0; y < C.ROWS; y++) for (let x = 0; x < C.COLS; x++) b3[y][x] = 'J';
  ok(tryRotate(b3, { type: 'T', x: 3, y: 5, rot: 0 }, 1) === null, '완전 찬 보드에서 회전 실패');
  // 180 회전
  const r180 = tryRotate(C.createBoard(), { type: 'L', x: 3, y: 5, rot: 0 }, 2);
  ok(r180 && r180.rot === 2, '180° 회전 동작');
})();

console.log('\n[T-스핀 판정]');
(function () {
  const b = C.createBoard();
  // piece x=3,y=5 → center (4,6), corners (3,5)(5,5)(3,7)(5,7)
  b[5][3] = 'J'; b[5][5] = 'J'; b[7][3] = 'J';
  ok(C.tspinKind(b, { type: 'T', x: 3, y: 5, rot: 0 }, 0) === 'full', '앞모서리 2개 → T-SPIN');
  const b2 = C.createBoard();
  b2[5][3] = 'J'; b2[7][3] = 'J'; b2[7][5] = 'J';
  ok(C.tspinKind(b2, { type: 'T', x: 3, y: 5, rot: 0 }, 0) === 'mini', '앞모서리 1개 → T-SPIN MINI');
  ok(C.tspinKind(b2, { type: 'T', x: 3, y: 5, rot: 0 }, 4) === 'full', '마지막 킥 → 만회 판정(full)');
  const b3 = C.createBoard();
  b3[5][3] = 'J'; b3[5][5] = 'J';
  ok(C.tspinKind(b3, { type: 'T', x: 3, y: 5, rot: 0 }, 0) === 'none', '모서리 2개 → 노스핀');
  ok(C.tspinKind(b, { type: 'L', x: 3, y: 5, rot: 0 }, 0) === 'none', 'T 이외는 노스핀');
})();
// 실제 T-스핀 더블(TSD) 상황 시뮬레이션
(function () {
  const b = C.createBoard();
  for (let x = 0; x < C.COLS; x++) { b[19][x] = 'J'; b[18][x] = 'J'; }
  b[19][4] = null;            // 아래 홈
  b[18][3] = b[18][4] = b[18][5] = null; // T가 들어갈 3칸
  b[17][3] = 'J';             // 오버행 (앞모서리 1개)
  const p = { type: 'T', x: 3, y: 17, rot: 2 };
  ok(!C.collides(b, C.STATES.T[2], p.x, p.y), 'TSD 슬롯에 T 착석');
  ok(C.tspinKind(b, p, 0) === 'full', 'TSD → T-SPIN(full) 판정');
  C.merge(b, p);
  ok(C.fullRows(b).join() === '18,19', 'TSD: 2줄 삭제');
  ok(C.scoreClear({ lines: 2, spin: 'full', level: 1 }).points === 1200, 'TSD 점수 1200');
  ok(C.wouldBePerfect(C.createBoard(), [0]) === true, '퍼펙트 클리어 예측');
})();

console.log('\n[줄 삭제]');
(function () {
  const b = C.createBoard();
  for (let x = 0; x < C.COLS; x++) { b[19][x] = 'I'; b[18][x] = 'O'; }
  b[19][0] = null;
  ok(C.fullRows(b).join() === '18', '가득 찬 행만 인식');
  b[19][0] = 'I';
  ok(C.fullRows(b).join() === '18,19', '2줄 인식');
  C.removeRows(b, [18, 19]);
  ok(C.isEmptyBoard(b), '줄 제거 후 비움');
  const b2 = C.createBoard();
  b2[19][0] = 'I'; b2[18][3] = 'J';
  for (let x = 0; x < C.COLS; x++) b2[19][x] = b2[19][x] || 'S';
  C.removeRows(b2, [19]);
  ok(b2[19][3] === 'J' && b2[19][0] === null, '위 행이 아래로 내려옴');
  ok(b2[0].every(function (v) { return !v; }), '맨 위에 빈 행 생성');
})();

console.log('\n[스코어링]');
(function () {
  const s = C.scoreClear.bind(C);
  ok(s({ lines: 1, level: 1 }).points === 100, '싱글 100');
  ok(s({ lines: 4, level: 3 }).points === 2400, '테트리스 800×3');
  ok(s({ lines: 4, level: 1, b2b: true }).points === 1200, 'B2B 테트리스 1.5배');
  ok(s({ lines: 0, spin: 'full', level: 2 }).points === 800, 'T-스핀 무삭제 400×2');
  ok(s({ lines: 3, spin: 'full', level: 1 }).points === 1600, 'T-스핀 트리플 1600');
  ok(s({ lines: 2, level: 1, combo: 3 }).points === 300 + 150, '콤보 보너스 50×콤보×레벨');
  ok(s({ lines: 4, level: 1, perfect: true }).points >= 2800, '퍼펙트 클리어 보너스');
  ok(s({ lines: 4, level: 1, difficult: true }).difficult === true, '테트리스는 B2B 대상');
  ok(s({ lines: 2, level: 1 }).difficult === false, '더블은 B2B 대상 아님');
})();

console.log('\n[7-bag]');
(function () {
  const r = C.createRandomizer();
  const counts = {};
  for (let i = 0; i < 70; i++) { const t = r.next(); counts[t] = (counts[t] || 0) + 1; }
  ok(C.TYPES.every(function (t) { return counts[t] === 10; }), '70개 → 각 타입 정확히 10개');
})();

console.log('\n[중력]');
ok(C.gravityFor(1) > C.gravityFor(5) && C.gravityFor(5) > C.gravityFor(10), '레벨↑ = 낙하↑');

console.log('\n결과: ' + (ran - fails) + '/' + ran + ' 통과' + (fails ? ' — 실패 ' + fails + '건' : ''));
process.exit(fails ? 1 : 0);

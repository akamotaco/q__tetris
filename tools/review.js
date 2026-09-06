/**
 * 검수 CLI — 자동 판정은 기각 5종뿐이고, **휴먼 오버 지표(속도·간격·반응)는 상태를 바꾸지 않는다**
 * (사람은 CTWL·ASD·롤킹 같은 손기술로 그 문턱을 그냥 넘는다). 그래서 ⚑ 는 여기서 사람이 붙인다.
 *   node tools/review.js                    ⚑ 대기열 (사람이 flag 한 것만 쌓인다)
 *   node tools/review.js 40                 개수 조절
 *   node tools/review.js --show <share>     상세(지표·순위 이력·1위 유지)
 *   node tools/review.js --flag <share> 메모  ⚑ 붙이기 (리플레이를 보고 판단)
 *   node tools/review.js --clear <share>    ⚑ 떼기 (verified)
 *   node tools/review.js --hide  <share>    목록 제외 (hidden, 삭제 아님)
 *
 * 만능 자동 탐지는 없다. 상위권은 사람이 리플레이를 보는 것이 실제 방어선이다.
 */
'use strict';
const DB = require('../server/db.js');
const RP = require('../replay.js');
const EN = require('../engine.js');   /* HZ — 틱을 초로 바꾸는 단일 기준 */

const args = process.argv.slice(2);
const num = args.find((a) => /^\d+$/.test(a));
const limit = num ? parseInt(num, 10) : 20;

function row(r) {
  return [
    '#' + (r.rank_at_submit == null ? '?' : r.rank_at_submit),
    (r.score || 0).toLocaleString().padStart(11),
    (r.lines + 'L').padStart(6),
    RP.fmtTime(r.ticks).padStart(9),
    (r.pps == null ? '-' : r.pps.toFixed(2) + 'pps').padStart(9),
    (r.mode + (r.level > 1 ? ':' + r.level : '') + (r.g20 ? ':20G' : '     ')).padEnd(16),
    (r.fp || '익명').padEnd(8),
    (r.ip_hint || '-').padEnd(16),
    r.share,
    r.status,
  ].join(' ');
}

function detail(share) {
  const r = DB.getRunByShare(share);
  if (!r) return console.log('없음: ' + share);
  const own = r.fp ? DB.ownerOf(r.fp) : null;
  console.log('share      :', r.share, '→ /r/' + r.share);
  console.log('상태        :', r.status, r.flags ? '(' + r.flags + ')' : '', r.review_note ? '— 검수: ' + r.review_note : '');
  console.log('보드/포인트 :', r.board, '점수', r.score.toLocaleString(), '/', r.lines, 'L /', RP.fmtTime(r.ticks), '/ 조각', r.pieces);
  let mp = {}; try { mp = JSON.parse(r.metrics || '{}'); } catch (e) { }
  console.log('지표        :', JSON.stringify({
    pps: +Number(r.pps || 0).toFixed(2), apm: +Number(r.apm || 0).toFixed(1),
    inputs: r.input_count, tetrises: r.tetrises, tspins: r.tspins, pcs: r.pcs,
    gapModeShare: mp.gapModeShare, gapStdev: mp.gapStdev, reactMedian: mp.reactMedian, reactFastShare: mp.reactFastShare, stackPeak: mp.stackPeak, hardShare: mp.hardShare,
    /* 속도는 증거가 아니지만, **실시간/시뮬 배율**은 다른 종류의 진술이다. 이 값이 큰 건 빠르게 친 것이
       아니라 게임 시계가 실생활보다 느리게 갔다는 뜻(밀린 프레임·정지) — 정지/대기면 정상이라 자동 판정은 하지 않는다. */
    realMs: mp.realMs, 실시간배율: mp.realMs ? +(mp.realMs / (r.ticks / EN.HZ * 1000)).toFixed(2) : null,
  }));
  console.log('소유(검사용) :', own ? own.codename + ' · ' + own.fp + (own.display_name ? ' · "' + own.display_name + '"' : ' (이름 없음)') : '없음');
  console.log('네트워크     :', r.ip_hint || '(파기됨)', '/ 해시 ' + (r.ip_hash || '-').slice(0, 8));
  const ev = DB.db.prepare('SELECT kind, rank, beat_run_id, gap, at FROM rank_events WHERE run_id = ? ORDER BY at').all(r.id);
  console.log('순위 이력    :', ev.map((e) => e.kind + '#' + e.rank + (e.gap ? '(+' + e.gap + ')' : '') + ' @' + new Date(e.at).toISOString().slice(0, 16)).join(', '));
  console.log('1위 유지     :', JSON.stringify(DB.holdForRun(r.id)));
  const sameNet = DB.db.prepare('SELECT COUNT(*) c FROM runs WHERE ip_hash = ? AND ip_hash IS NOT NULL').get(r.ip_hash || '').c;
  const sameFp = r.fp ? DB.db.prepare('SELECT COUNT(*) c FROM runs WHERE fp = ?').get(r.fp).c : 0;
  console.log('같은 네트워크 기록:', sameNet, '/ 같은 지문 기록:', sameFp, '(다음이 많으면 한 사람 다계정 또는 공유기)');
  console.log('리플레이 길이 :', r.replay.length, '바이트');
}

const want = args[0];
if (want === '--show' || want === '--clear' || want === '--hide' || want === '--flag') {
  const share = args[1];
  if (!share) { console.log('공유 키를 주세요.'); process.exit(1); }
  if (want === '--show') detail(share);
  else {
    /* 세 가지 모두 상태만 바꾼다 — 행·지표·순위 이력은 그대로 남는다(삭제 없음). */
    const st = want === '--clear' ? 'verified' : (want === '--flag' ? 'flagged' : 'hidden');
    const note = want === '--flag' ? args.slice(2).join(' ') : null;
    if (want === '--flag' && !note) { console.log('왜 ⚑ 인지 메모를 남기세요: --flag <share> 리플레이 간격이 균일'); process.exit(1); }
    const n = DB.markReview(share, st, note);
    console.log(n ? (share + ' → ' + st + (note ? ' — ' + note : '') + ' (기록·이력은 그대로)') : ('없음: ' + share));
  }
} else {
  const rows = DB.db.prepare(`SELECT * FROM runs WHERE status = 'flagged' ORDER BY score DESC LIMIT ?`).all(limit);
  console.log('#순위        점수      줄      시간     PPS   모드              지문     네트워크          share                     상태');
  rows.forEach((r) => console.log(row(r)));
  const by = DB.db.prepare('SELECT reject, COUNT(*) c FROM runs WHERE status = \'rejected\' GROUP BY reject ORDER BY c DESC LIMIT 8').all();
  console.log('\n기각 사유 분포:', by.map((b) => b.reject + '×' + b.c).join(', ') || '없음');
  console.log('합계:', DB.totals());
  if (rows.length) console.log('\n상세: node tools/review.js --show <share>   ⚑ 제거: --clear <share>');
  else console.log('\n대기 열이 비어 있다. 자동 판정은 기각 5종뿐이고, ⚑ 는 사람이 --flag 로 붙인다.');
}

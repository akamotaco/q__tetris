/**
 * 제출 검증 — 이 서버의 존재 이유.
 *
 *   1) 형태 검사         : 허용 범위를 벗어나면 계산도 하지 않는다(CPU 보호).
 *   2) 1회용 시드        : 서버가 발급하지 않은 시드 / 이미 쓰인 시드는 그 자체로 기각.
 *   3) 내용 digest       : 같은 플레이의 재등록(도용·점수 부풀리기 재시도)을 UNIQUE 로 차단. 사전에 선등록된 것이 이긴다.
 *   4) 재시뮬레이션      : 서버가 직접 engine.js 를 돌린다. score/lines/pieces/ticks/보드해시가 하나라도 어긋나면 기각.
 *   5) 월클럭            : 게임 시간 > 실제 경과 시간은 물리적으로 불가능 → 기각.
 *   6) 인간 가능성 휴리스틱 : 자동 기각이 아니라 **플래그**. 상위권만 사람 검수로 간다 (만능 자동 탐지는 없다).
 *   7) 소유 서명         : 지문(공개키)이 이 digest 를 서명했는지 확인 → 남의 기록에 내 이름을 붙이는 것을 막는다.
 *
 * 기각 사유는 딱 5종만: shape / seed / digest-owned-by-others / mismatch / wallclock(물리).
 * 나머지는 전부 flags 로 남기고 기록은 사라지지 않는다.
 */
'use strict';
const crypto = require('crypto');
const EN = require('../engine.js');
const RP = require('../replay.js');
const ID = require('../identity.js');
const CFG = require('./config');
/* db 는 publicRun 이 불릴 때만 지연 require 한다 — 워커 스레드가 DB 를 열지 않게 */

/* ================= digest (내용 주소화) ================= */
/**
 * 점수·라인 등 "주장하는 값"은 digest 에 넣지 않는다.
 * → 같은 플레이인데 점수만 부풀려 재제출하면 **같은 digest** 가 떨어져 UNIQUE 에 걸린다.
 */
function digestOf(rec) {
  return crypto.createHash('sha256').update(RP.canonical(rec)).digest('hex');
}
function cryptosha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/* ================= 지문 / 서명 ================= */
function jwkPublicKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('jwk: EC/P-256 만 허용');
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(jwk.x || '')) || !/^[A-Za-z0-9_-]{43}$/.test(String(jwk.y || ''))) {
    throw new Error('jwk: 좌표 길이');
  }
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
}
function fpFromJwk(jwk) {
  const der = jwkPublicKey(jwk).export({ type: 'spki', format: 'der' });
  return ID.fpFromHash(crypto.createHash('sha256').update(der).digest('hex')).fp;
}
/** 서명 대상은 ID.authPayload(prefix, parts) 로 만든 문자열 그대로 (클라임과 서버가 같은 함수를 쓴다) */
function verifyOwnership(jwk, fp, payload, sigB64) {
  try {
    if (!ID.validFp(fp) || fpFromJwk(jwk) !== fp) return { ok: false, why: 'fp-mismatch' };
    const sig = normalizeEcdsaSig(Buffer.from(String(sigB64), 'base64'));
    if (sig.length < 8 || sig.length > 128) return { ok: false, why: 'sig-length' };
    try {
      const ok = crypto.verify('sha256', Buffer.from(String(payload), 'utf8'), jwkPublicKey(jwk), sig);
      return { ok: !!ok, why: ok ? null : 'sig-bad' };
    } catch (e) {
      return { ok: false, why: 'sig-error:' + e.message };
    }
  } catch (e) {
    return { ok: false, why: 'sig-error:' + e.message };
  }
}

/**
 * ECDSA 서명 인코딩 통일.
 * 브라우저 WebCrypto 는 DER(ASN.1, 약 70~72바이트) 를 돌려주지만, node 의 webcrypto 는
 * raw r||s(64바이트) 를 돌려준다. 같은 코드를 두고 "테스트에서는 되고 브라우저에서는 안 되는"
 * 사고를 막으려면 두 형태를 모두 받아야 한다.
 */
function derInt(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.slice(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([2, v.length]), v]);
}
function normalizeEcdsaSig(buf) {
  if (buf.length === 64) {   // Chrome/Edge·node webcrypto 는 raw r||s 를 돌려주기도 한다
    const body = Buffer.concat([derInt(buf.slice(0, 32)), derInt(buf.slice(32))]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);   // SEQUENCE 태그
  }
  return buf;                     // 이미 DER
}

/* ================= 닉네임 정책 (공개는 공유 링크에서만) ================= */
const RESERVED = ['admin', 'administrator', 'system', 'staff', 'mod', 'moderator', 'official', 'support',
  'null', 'undefined', 'root', 'tetris', 'neon', 'help', 'api', 'www', 'r', 'u', 'me'];
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b-\u200d\ufeff]/;

/** 반환: {ok, name, why} */
function cleanDisplayName(input) {
  if (input == null || String(input).trim() === '') return { ok: true, name: null };
  let s = String(input).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (BIDI.test(s)) return { ok: false, why: 'bidirectional/zero-width 문자 금지' };
  s = s.replace(/\s+/g, ' ');
  const len = Array.from(s).length;
  if (len < 2) return { ok: false, why: '너무 짧음' };
  if (len > 24) return { ok: false, why: '24자 초과' };
  if (/[<>&`"'\\|]/.test(s)) return { ok: false, why: '특수문자 금지' };
  if (/(https?:|www\.|\.com|\.kr|\.net|discord\.gg|\.co\.kr)/i.test(s)) return { ok: false, why: '링크 금지' };
  if (/^\d+$/.test(s)) return { ok: false, why: '숫자만 불가' };
  if (/^[.*_\-]+$/.test(s)) return { ok: false, why: '기호만 불가' };
  const low = s.toLowerCase();
  if (RESERVED.some(r => low === r || low.startsWith(r + ' ') || low === '@' + r)) return { ok: false, why: '예약어' };
  if (/[A-Za-z]/.test(s) && ID.BLOCK.some(w => low.includes(w) && w.length > 3)) return { ok: false, why: '금지어' };
  return { ok: true, name: s };
}

/* ================= 지표 계산 ================= */
function maxPerWindow(inputs, windowTicks) {
  let best = 0, i = 0, sum = 0;
  const t = inputs.map(x => x.t);
  for (let j = 0; j < t.length; j++) {
    while (t[j] - t[i] >= windowTicks) { sum--; i++; }
    sum++;
    if (sum > best) best = sum;
  }
  return best;
}
function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
/** 연타 간격 분포 — 사람이 이런 히스토그램을 만들지 않는다(특정 간격에 몰리고 분산이 0에 가까움) */
function rhythm(inputs) {
  const presses = inputs.filter(x => x.k === 1).map(x => x.t);
  const gaps = [];
  for (let i = 1; i < presses.length; i++) gaps.push(presses[i] - presses[i - 1]);
  if (gaps.length < 20) return { n: gaps.length, modeShare: 0, stdev: 0, mean: 0 };
  const hist = {};
  gaps.forEach(g => { hist[g] = (hist[g] || 0) + 1; });
  let modeGap = 0, modeN = 0;
  Object.keys(hist).forEach(g => { if (hist[g] > modeN) { modeN = hist[g]; modeGap = +g; } });
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const varc = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length;
  return { n: gaps.length, modeShare: modeN / gaps.length, stdev: Math.sqrt(varc), mean: mean, modeGap: modeGap };
}
/**
 * 스폰 → 첫 입력 지연(틱). 사람은 8~16틱, 기계는 0~2틱.
 * 단 "그 자리에 그냥 떨어뜨린" 조각(첫 입력이 하드드롭)은 반응 속도 증거가 약하므로 별도 축으로 둔다.
 */
function reaction(spawns, inputs) {
  const press = inputs.filter(x => x.k === 1);
  const t = press.map(x => x.t);
  const act = press.map(x => x.a !== 'hard');
  // nextAct[i] = i 이후 첫 "이동/회전" 입력 인덱스
  const nextAct = new Array(t.length + 1).fill(-1);
  for (let i = t.length - 1; i >= 0; i--) nextAct[i] = act[i] ? i : nextAct[i + 1];
  const latAll = [], latAct = [];
  let p = 0;
  for (const sp of spawns) {
    while (p < t.length && t[p] < sp) p++;
    if (p >= t.length) break;
    latAll.push(t[p] - sp);
    const q = nextAct[p];
    if (q >= 0) latAct.push(t[q] - sp);
  }
  const fast = latAct.filter(x => x <= 2).length;
  return {
    n: latAct.length, median: median(latAct), fastShare: latAct.length ? fast / latAct.length : 0,
    nAll: latAll.length, medianAll: median(latAll),
  };
}

/**
 * 플래그 심각도 — **상태를 바꾸지 않는다**. 여기 값은 검수자가 순서대로 볼지 고르는 관찰 지표일 뿐이다.
 *
 * 왜 상태로 쓰지 않는가 (속도는 증거가 아니다):
 *   세계 상위권은 CTWL·ASD·롤킹 같은 손기술과 전용 자세로 이 문턱들을 그냥 넘긴다
 *   (9~10 PPS, 20 APM 대를 유지한다). "인간을 넘었다"를 판정 근거로 쓰면
 *   정확히 가장 잘한 정당한 플레이어를 벌하는 모양이 되고, 반대로 사람은 느리게 돌리면
 *   얼마든지 회피한다 — 그래서 이 지표들은 자동 판정에서 완전히 빠진다.
 *   자동 판정은 "시뮬레이션이 같은 결과로 재구성되는가" 하나만 쓰고, ⚑ 는 사람이 붙인다
 *   (tools/review.js --flag).
 *   hard = "어떤 입력 장치로도 성립하기 어려운 형태" — 그래도 기각은 아니고 '먼저 볼 가치'일 뿐.
 */
const SEVERITY = {
  pps_high: 'soft', pps_extreme: 'soft', input_rate: 'soft', apm_extreme: 'soft', input_burst: 'soft',
  tick_stacking: 'soft', metronome: 'soft', reaction_superhuman: 'soft', reaction_spam: 'soft',
  machine_like: 'soft', sprint_inhuman: 'soft',
  speed_impossible: 'hard',
};

/* ================= 검증 본체 ================= */
function verify(rec, ctx) {
  ctx = ctx || {};
  const t0 = Date.now();
  const out = {
    status: 'pending', code: null, flags: [], metrics: {},
    mismatch: null, ghost: null, simMs: 0, verifyMs: 0, sim: null,
  };
  let sim = null;                 // 시뮬 이전 단계에서 기각되면 null 그대로 쓴다

  /* 1. 형태 */
  const shape = RP.checkShape(rec, CFG.LIMITS);
  if (shape.length) return reject('shape:' + shape.join(','));
  if (!EN.MODES[rec.mode]) return reject('shape:mode');
  /* 규칙 버전이 다르면 재현 자체가 성립하지 않는다 — 비싼 시뮬을 쓰기 전에 early 거둔다.
     과거 규칙도 검증하려면 그 버전의 규칙 테이블을 따로 보존해야 한다. */
  if (rec.rules && rec.rules !== EN.RULES_ID) return reject('rules-version:' + rec.rules + '!=' + EN.RULES_ID);

  /* 2. 물리적 하한 — 조각/줄 수 대비 너무 짧으면 기각 (짧은 게임 자체는 합법적으로 허용) */
  const L = CFG.LIMITS;
  if (rec.ticks < L.minTicksAbs) return reject('too-short');
  /* 속도가 물리 상한을 넘는지는 **플래그**로만 다룬다: 렌더가 밀리면 게임 시간이 압축되어
     정직한 플레이어도 초인적으로 보일 수 있다. 기각은 재시뮬 불일치·시드·월클럭만. */
  out.speedSuspect = (rec.pieces > 2 && rec.ticks < rec.pieces * L.flagTicksPerPiece) ||
    (rec.lines > 2 && rec.ticks < rec.lines * L.flagTicksPerLine);

  /* 3. 재시뮬레이션 */
  sim = EN.simulate(rec, { maxTicks: CFG.LIMITS.maxTicks + 600 });
  out.sim = sim.engine;
  out.simMs = sim.simMs;
  const e = sim.engine;
  const diff = [];
  if (e.score !== rec.score) diff.push('score');
  if (e.lines !== rec.lines) diff.push('lines');
  if (e.pieces !== rec.pieces) diff.push('pieces');
  if (e.ticks !== rec.ticks) diff.push('ticks');
  if (e.boardHash() !== rec.hash) diff.push('hash');
  if (e.mode !== rec.mode || e.startLevel !== rec.level || !!e.g20 !== !!rec.g20) diff.push('settings');
  if (diff.length) { out.mismatch = diff; return reject('mismatch:' + diff.join(',')); }
  if (rec.lines && !sim.trace.locks.length) return reject('no-locks');

  /* 4. 월클럭 — 게임 시간이 실제 경과 시간을 넘을 수 없다 (헤드리스로 100배속 돌리는 것 차단) */
  if (ctx.issuedAt) {
    const realMs = (ctx.now || Date.now()) - ctx.issuedAt;
    const gameMs = RP.seconds(rec.ticks) * 1000;
    out.metrics.realMs = realMs;
    if (gameMs > realMs + CFG.LIMITS.wallclockGraceMs) return reject('wallclock');
    out.wallclockRatio = gameMs / Math.max(1, realMs);
  }

  /* 5. 인간 가능성 휴리스틱 → flags
     입력률 지표는 press(누르기)만 센다. release 를 함께 세면 세계기록 수준
     (탭+회전+하드드롭을 1~2틱 안에 처리)만으로도 가볍게 임계값을 넘는다. */
  const secs = RP.seconds(rec.ticks);
  const presses = rec.inputs.filter(function (x) { return x.k === 1; });
  const m = {
    secs: secs,
    pps: rec.pieces / secs,
    apm: rec.lines / (secs / 60),
    ips: presses.length / secs,
    perSecPeak: maxPerWindow(presses, 60),
    per3SecPeak: maxPerWindow(presses, 180) / 3,
    hardShare: sim.trace.locks.length ? sim.trace.hard / sim.trace.locks.length : 0,
    rotPerPiece: rec.pieces ? sim.trace.rotations / rec.pieces : 0,
    stackPeak: sim.trace.maxStack,
  };
  const rh = rhythm(rec.inputs);
  m.gapModeShare = rh.modeShare; m.gapStdev = rh.stdev; m.gapMean = rh.mean;
  const rx = reaction(sim.trace.spawns, rec.inputs);
  m.reactMedian = rx.median; m.reactFastShare = rx.fastShare; m.reactMedianAll = rx.medianAll;
  out.metrics = m;

  if (out.speedSuspect) out.flags.push('speed_impossible');
  if (m.pps > 5.0) out.flags.push('pps_extreme');
  else if (m.pps > 3.2) out.flags.push('pps_high');
  if (m.apm > 260) out.flags.push('apm_extreme');
  if (m.perSecPeak > 30) out.flags.push('input_burst');
  if (m.ips > 20) out.flags.push('input_rate');
  if (m.stackPeak > 3) out.flags.push('tick_stacking');
  if (rh.n > 60 && rh.modeShare > 0.85 && rh.stdev < 1.2) out.flags.push('metronome');
  if (rx.n >= 25 && rx.median <= 3) out.flags.push('reaction_superhuman');
  if (rx.n >= 25 && rx.fastShare > 0.85) out.flags.push('reaction_spam');
  if (m.pps > 2.2 && m.hardShare > 0.97 && rh.modeShare > 0.55) out.flags.push('machine_like');
  if (rec.mode === 'sprint' && rec.ticks < 60 * 26) out.flags.push('sprint_inhuman');

  /* 심각도 분리: hard 는 "검수자가 먼저 볼 가치"일 뿐이다.
     상태는 휴리스틱으로 바꾸지 않는다 — ⚑(flagged) 는 사람이 붙인다. */
  out.hard = out.flags.filter(function (f) { return SEVERITY[f] === 'hard'; });
  out.status = 'verified';
  out.ghost = ghostOf(sim);
  out.verifyMs = Date.now() - t0;
  return out;

  function reject(code) {
    out.status = 'rejected';
    out.code = code;
    out.ghost = ghostOf(sim);
    out.verifyMs = Date.now() - t0;
    return out;
  }
}

/** 서버가 시뮬에서 뽑아내는 고스트 타임라인 (클라가 보내면 속임수가 되므로 서버 파생값만 쓴다) */
function ghostOf(sim) {
  if (!sim || !sim.engine) return null;
  const locks = sim.engine.locks;
  if (!locks.length) return null;
  const step = Math.max(1, Math.ceil(locks.length / 1200));
  const g = [];
  for (let i = 0; i < locks.length; i += step) g.push([locks[i].t, locks[i].score, locks[i].lines]);
  const last = locks[locks.length - 1];
  if (g.length && g[g.length - 1][0] !== last.t) g.push([last.t, last.score, last.lines]);
  return g;
}

/* ================= 공개 응답 투영 ================= */
/**
 * 월드 보드/통계 응답에는 display_name 필드를 **존재시키지 않는다**.
 * UI에서 숨기는 것과 다르다: JSON 으로 새어나가면 보드가 곧 이름 목록이 된다.
 * → 이 함수 하나로 막고, tools/verifytest.js 가 응답 문자열에 display_name 이 없는지 검사한다.
 */
function publicRun(run, opt) {
  opt = opt || {};
  const o = {
    share: run.share, board: run.board, mode: run.mode, level: run.level, g20: !!run.g20,
    score: run.score, lines: run.lines, pieces: run.pieces, ticks: run.ticks,
    duration: RP.seconds(run.ticks), status: run.status,
    queued: run.status === 'queued' || run.status === 'verifying',
    flags: (function () { try { return run.flags ? JSON.parse(run.flags) : []; } catch (e) { return []; } })(),
    rankAtSubmit: run.rank_at_submit, submittedAt: run.submitted_at, verifiedAt: run.verified_at || null,
    fp: run.fp || null,
    codename: null, ipHint: null,
    rules: run.rules || null,
    metrics: (function () {
      try { return Object.assign({ pps: run.pps, apm: run.apm, inputs: run.input_count, inpRate: run.inp_rate }, run.metrics ? JSON.parse(run.metrics) : {}); }
      catch (e) { return { pps: run.pps, apm: run.apm, inputs: run.input_count }; }
    })(),
    reject: run.reject || null, mismatch: (function () { try { return run.mismatch ? JSON.parse(run.mismatch) : null; } catch (e) { return null; } })(),
    tetrises: run.tetrises, tspins: run.tspins, pcs: run.pcs,
    challengeOf: run.challenge_of || null,
    overReason: run.over_reason,
  };
  o.hardFlags = o.flags.filter(function (f) { return SEVERITY[f] === 'hard'; });
  o.softFlags = o.flags.filter(function (f) { return SEVERITY[f] !== 'hard'; });
  const own = run.fp ? require('./db').ownerOf(run.fp) : null;
  if (own) o.codename = own.codename;
  if (opt.reveal) {
    // 이름이 보이는 유일한 경로: 제출자가 공유를 택한 링크
    o.displayName = (run.reveal && own && own.display_name) || null;
    o.ipHint = run.ip_hint || null;
  }
  return o;
}
function boardList(rows, opt) {
  return rows.map(r => publicRun(r, opt));
}

module.exports = {
  digestOf, cryptosha, verify, ghostOf, SEVERITY,
  fpFromJwk, jwkPublicKey, verifyOwnership,
  cleanDisplayName, publicRun, boardList,
  maxPerWindow, rhythm, reaction, median,
};

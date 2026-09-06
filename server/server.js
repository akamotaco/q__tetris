/**
 * NEON TETRIS 서버 (node:http + node:sqlite — 외부 의존성 0)
 *
 *   node server/server.js        →  http://localhost:8787
 *
 * · 정적 파일은 **허용 목록** 방식 (server/, data/, tools/ 가 실수로 공개되는 사고를 구조적으로 차단)
 * · /r/<share> 는 이름이 노출되는 페이지이므로 noindex. 대신 OG 태그로 클릭을 부른다.
 * · 월드 보드 응답에는 displayName 필드를 만들지 않는다 → server/verify.js:publicRun() 이 유일한 관문.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const CFG = require('./config');
const DB = require('./db');
const V = require('./verify');
const RP = require('../replay.js');
const EN = require('../engine.js');
const ID = require('../identity.js');
const { queue } = require('./queue.js');

const START = Date.now();

/* ================= 이벤트 루프 지연 감시 =================
 * "검증 때문에 사이트가 멈추는지" 를 남의 측정이 아니라 스스로 보고한다.
 * 20ms 주기 타이머가 실제로 몇 ms 늦게 돌아야 했는지가 곧 루프 정체다. */
const LAG_INTERVAL = 20;
const lagSamples = [];
let lagPrev = process.hrtime.bigint();
setInterval(function () {
  const t = process.hrtime.bigint();
  const late = Number(t - lagPrev) / 1e6 - LAG_INTERVAL;
  lagPrev = t;
  if (late > 0.5) { lagSamples.push(late); if (lagSamples.length > 5000) lagSamples.shift(); }
}, LAG_INTERVAL).unref();
function lagStats() {
  if (!lagSamples.length) return { n: 0 };
  const a = lagSamples.slice().sort((x, y) => x - y);
  const p = (q) => +a[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(1);
  return { n: a.length, p50: p(0.5), p95: p(0.95), max: +a[a.length - 1].toFixed(1) };
}

/* ================= 정적 허용 목록 ================= */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/ui.css': ['ui.css', 'text/css; charset=utf-8'],   /* 빠져 있었다 — 한 번도 서빙되지 않은 파일 (probe 는 file:// 라 못 봤다) */
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/replay.js': ['replay.js', 'text/javascript; charset=utf-8'],
  '/identity.js': ['identity.js', 'text/javascript; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/docs/preview.png': ['docs/preview.png', 'image/png'],
  '/docs/preview-mobile.png': ['docs/preview-mobile.png', 'image/png'],
};

/* ================= 요청 유틸 ================= */
function clientIp(req) {
  if (CFG.TRUST_PROXY_HOPS > 0) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      return parts[Math.max(0, parts.length - CFG.TRUST_PROXY_HOPS)] || parts[0];
    }
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '0.0.0.0';
}
function cleanIp(ip) {
  let s = String(ip || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}
function baseUrl(req) {
  if (CFG.BASE_URL) return CFG.BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + CFG.PORT;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + host;
}
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  /* 인라인 스크립트/서드파티 없음 — 이름 필드가 들어와도 실행될 자리를 없앤다 */
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function send(res, code, body, headers) {
  const h = Object.assign({}, BASE_HEADERS, headers || {});
  res.writeHead(code, h);
  res.end(body);
}
const json = (res, code, obj, headers) =>
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, res) {
  let raw;
  try { raw = await readBody(req, CFG.LIMITS.bodyBytes); }
  catch (e) { json(res, 413, { error: 'body-too-large' }); return null; }
  try { return JSON.parse(raw || '{}'); }
  catch (e) { json(res, 400, { error: 'bad-json' }); return null; }
}

/* ================= HTML + OG ================= */
let htmlCache = { mtime: 0, text: '' };
function indexHtml() {
  const p = path.join(CFG.ROOT, 'index.html');
  const m = fs.statSync(p).mtimeMs;
  if (htmlCache.mtime !== m) htmlCache = { mtime: m, text: fs.readFileSync(p, 'utf8') };
  return htmlCache.text;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function serveIndex(req, res, run) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': run ? 'no-store' : 'public, max-age=60',
  };
  let title = 'NEON TETRIS';
  let desc = 'SRS·T-스핀·퍼펙트클리어. 브라우저에서 바로 하는 테트리스 — 모든 기록은 서버가 리플레이를 다시 돌려 검증합니다.';
  if (run) {
    const own = run.fp ? DB.ownerOf(run.fp) : null;
    const who = (run.reveal && own && own.display_name) || (own ? own.codename : '누군가');
    title = run.score.toLocaleString() + '점 · ' + run.lines + 'L — ' + who + ' (NEON TETRIS)';
    desc = who + '의 ' + run.lines + '줄 / ' + RP.fmtTime(run.ticks) + ' 기록. 서버 재시뮬 검증' +
      (run.rank_at_submit ? ' · 발행 당시 세계 ' + run.rank_at_submit + '위' : '') +
      '. 같은 조건으로 바로 도전할 수 있습니다.';
    headers['X-Robots-Tag'] = 'noindex';           // 이름이 검색 색인이 되지 않게
  }
  const og = [
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="' + esc(baseUrl(req) + (run ? '/r/' + run.share : '/')) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<title>' + esc(title) + '</title>',
  ].join('\n');
  const html = indexHtml();
  /* /r/<share> 같이 경로를 들여 쓰는 페이지에서는 상대 경로 에셋이 /r/ 아래로 새므로
     base 를 걸어준다. (file:// 직접 실행은 이 코드를 거치지 않아 상대 경로 유지) */
  const base = run ? '<base href="/">' : '';
  const out = html.indexOf('<!--OG-->') >= 0
    ? html.replace('<!--OG-->', base + og)
    : html.replace('</title>', ' — ' + esc(run ? '기록' : '') + '</title>\n' + base + og);
  send(res, 200, out, headers);
}

/* ================= 소유 증명 ================= */
/**
 * body.owner = { jwk, sig }. sig 는 ID.authPayload(prefix, parts) 를 서명한 base64(DER).
 * 지문은 공개키에서 결정적으로 파생되므로 "이 기기가 이 내용을 승인했다"가 증명된다.
 */
function ownership(body, fp, prefix, parts) {
  if (!ID.validFp(fp)) return { ok: false, why: 'bad-fp' };
  const o = body.owner;
  if (!o || !o.jwk || !o.sig) return { ok: false, why: 'no-signature' };
  return V.verifyOwnership(o.jwk, fp, ID.authPayload(prefix, parts), o.sig);
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

/* ================= 검증 완료 처리 (워커 → 발행) ================= */
function onVerified(job, r) {
  try {
    if (!job.id) return;
    if (r.status === 'rejected') {
      const n = DB.countUp('rej:' + (job.ipHash || 'na'), 36e5);
      if (n > CFG.LIMITS.rejectsBeforeBan) DB.ban(job.ipHash, 'repeat-rejection:' + r.code);
      DB.finalizeRun(job.id, {
        status: 'rejected', reject: r.code, flags: r.flags,
        mismatch: r.mismatch ? JSON.stringify(r.mismatch) : null,
        metrics: JSON.stringify(r.metrics || {}),
        sim_ms: r.simMs, verify_ms: r.verifyMs, verified_at: DB.now(),
        real_ms: r.metrics && r.metrics.realMs != null ? r.metrics.realMs : null,
      });
      return;
    }
    const s = r.sim || {};
    DB.finalizeRun(job.id, {
      status: r.status, flags: r.flags, ghost: r.ghost,
      // 주장값이 아니라 **재시뮬이 만들어낸 값**을 박는다 (일치할 때만 여기 도달한다)
      score: s.score, lines: s.lines, pieces: s.pieces, ticks: s.ticks, hash: s.hash,
      over_reason: s.over_reason, tetrises: s.tetrises, tspins: s.tspins, pcs: s.pcs, max_combo: s.max_combo,
      pps: r.metrics.pps, apm: r.metrics.apm, inp_rate: r.metrics.ips,
      metrics: JSON.stringify(r.metrics || {}),
      sim_ms: r.simMs, verify_ms: r.verifyMs, verified_at: DB.now(),
      /* 순위 지표는 재현 시간(결정적)이고, real_ms 는 **대비용 실측치**다. 둘 다 남긴다. */
      real_ms: r.metrics.realMs != null ? r.metrics.realMs : null,
    });
  } catch (e) {
    console.error('[queue] 완료 처리 실패 #' + job.id + ':', e.message);
  }
}
queue.onDone = onVerified;

/* ================= API ================= */
async function handleApi(req, res, u) {
  const ip = cleanIp(clientIp(req));
  const iph = DB.ipToHash(ip);
  const seg = u.pathname.replace(/^\/api\//, '').replace(/\/$/, '').split('/');
  const q = (k) => u.searchParams.get(k);
  const banned = DB.isBanned(iph);

  if (banned) return json(res, 403, { error: 'banned' });

  /* ---------- 읽기 ---------- */
  if (req.method === 'GET' && seg[0] === 'health') {
    return json(res, 200, Object.assign({ ok: true, uptime: Math.round((Date.now() - START) / 1000), loopLag: lagStats(), queue: queue.info() }, DB.totals()));
  }
  if (req.method === 'GET' && seg[0] === 'stats') {
    return json(res, 200, Object.assign({
      modes: Object.keys(EN.MODES).map(m => ({
        id: m, name: EN.MODES[m].name, metric: DB.metricOf(m),
        targetLines: EN.MODES[m].targetLines || null, timeLimit: EN.MODES[m].timeLimit || null,
      })),
      maxLevel: EN.MAX_LEVEL, tickHz: EN.HZ,
      boards: DB.boards().slice(0, 40),
      periods: DB.periodList(null),
      serverTime: DB.now(),
      limits: { displayName: 24, modes: Object.keys(EN.MODES) },
    }, DB.totals()), { 'Cache-Control': 'public, max-age=10' });
  }
  if (req.method === 'GET' && seg[0] === 'board') {
    const board = DB.boardKey(q('mode') || 'marathon', parseInt(q('level') || '1', 10) || 1, q('g20') === '1');
    const rows = DB.listBoard(board, {
      limit: Math.min(100, parseInt(q('limit') || '25', 10) || 25),
      offset: Math.max(0, parseInt(q('offset') || '0', 10) || 0),
      strict: q('strict') === '1',
    });
    return json(res, 200, {
      board: board, metric: DB.metricOf(DB.boardParts(board).mode),
      total: DB.countBoard(board),
      list: V.boardList(rows, { reveal: false }),      // ← 보드에는 이름을 절대 싣지 않는다
      hold: DB.holdInfo(board),
      updatedAt: DB.now(),
    }, { 'Cache-Control': 'public, max-age=' + Math.max(5, Math.round(CFG.LIMITS.boardCacheMs / 1000)) });
  }
  if (req.method === 'GET' && seg[0] === 'periods') {
    const board = q('board');
    return json(res, 200, {
      periods: DB.periodList(board, 60),
      current: DB.periodKeys(DB.now()),
      available: DB.knownPeriods().slice(0, 60),
    }, { 'Cache-Control': 'public, max-age=600' });
  }
  if (req.method === 'GET' && seg[0] === 'period') {
    const period = q('period') || DB.periodKeys(DB.now()).week;
    const board = q('board');
    const rows = DB.periodBoardAny(period, board, parseInt(q('limit') || '10', 10) || 10);
    return json(res, 200, {
      period: period, board: board || null,
      rows: rows.map(r => ({
        rank: r.rank, share: r.share, board: r.board, mode: r.mode, score: r.score,
        lines: r.lines, ticks: r.ticks, fp: r.fp, status: r.status,
        codename: r.fp ? ID.codename(r.fp, 'ko') : null,        // 기간 뷰도 이름은 싣지 않는다
      })),
    }, { 'Cache-Control': 'public, max-age=300' });
  }
  if (req.method === 'GET' && seg[0] === 'hof') {
    /* 명예의 전당: 기간별 1위 + 최장 1위 유지.  ·여기서도 이름은 싣지 않는다(코드네임/지문만). */
    const board = q('board');
    const kind = q('kind') === 'month' ? 'month' : 'week';
    const lim = Math.max(1, Math.min(12, parseInt(q('limit') || '8', 10) || 8));
    const prefix = kind === 'week' ? 'w:' : 'm:';
    const current = DB.periodKeys(DB.now())[kind];
    const entry = function (row, p, live) {
      return {
        period: p, current: !!live, share: row.share, board: row.board, mode: row.mode,
        score: row.score, lines: row.lines, ticks: row.ticks, fp: row.fp, status: row.status,
        codename: row.fp ? ID.codename(row.fp, 'ko') : null,
      };
    };
    const champions = [];
    /* 진행 중인 기간은 스냅샬(1시간 주기)을 기다리지 않고 라이브로 넣는다.
       안 그러면 막 세운 기록이 명예의 전당에 한 시간 동안 안 뜨고 빈 판이 보인다. */
    const liveTop = DB.periodBoardAny(current, board, 1)[0];
    if (liveTop) champions.push(entry(liveTop, current, true));
    DB.periodList(board).forEach(function (p) {
      if (champions.length >= lim || p.indexOf(prefix) !== 0 || p === current) return;
      const row = DB.periodBoard(p, board, 1)[0];
      if (row) champions.push(entry(row, p, false));
    });
    let longest = null;
    if (board) {
      const hold = DB.holdInfo(board);
      const cand = (hold.past || []).slice();
      if (hold.current) cand.push(Object.assign({}, hold.current, { held_ms: DB.now() - hold.current.since }));
      cand.forEach(function (h) {
        if (h.held_ms > 0 && (!longest || h.held_ms > longest.held_ms)) {
          longest = { share: h.share, held_ms: h.held_ms, score: h.score, ticks: h.ticks, fp: h.fp, running: !h.until_ms };
        }
      });
    }
    /* 진행 중 기간은 라이브로 계산한다(제출 직후에 갱신돼야 한다). 그래도 캐시를 10분으로 두면
         브라우저가 빈 판을 10분간 붙 들고 있어 '방금 세운 기록이 안 보인다' 가 된다. */
    return json(res, 200, { kind: kind, board: board || null, current: current, champions: champions, longest: longest },
      { 'Cache-Control': 'public, max-age=60' });
  }
  if (req.method === 'GET' && seg[0] === 'hold') {
    const board = DB.boardKey(q('mode') || 'marathon', parseInt(q('level') || '1', 10) || 1, q('g20') === '1');
    return json(res, 200, DB.holdInfo(board), { 'Cache-Control': 'public, max-age=60' });
  }
  if (req.method === 'GET' && seg[0] === 'replay' && DB.validShare(seg[1])) {
    const run = DB.getRunByShare(seg[1]);
    if (!run || ['hidden', 'withdrawn'].indexOf(run.status) >= 0) return json(res, 404, { error: 'not-found' });
    if (run.status === 'rejected') {
      return json(res, 200, { share: run.share, status: 'rejected', queued: false, reject: run.reject,
        mismatch: safeParse(run.mismatch), flags: safeParse(run.flags),
        submittedAt: run.submitted_at, verifiedAt: run.verified_at }, { 'Cache-Control': 'no-store' });
    }
    const view = V.publicRun(run, { reveal: !!run.reveal });     // ← 여기서만 이름이 노출된다
    view.displayName = view.displayName || null;      // '미표시'를 클라가 구분할 수 있게
    view.replay = run.replay;
    view.ghost = run.ghost ? JSON.parse(run.ghost) : null;
    if (view.queued) {
      view.queue = queue.position(run.id);
      view.rank = null;                                  // 검증 전에는 순위를 매기지 않는다
    } else {
      view.hold = DB.holdForRun(run.id);
      view.lineage = DB.lineageOf(run.id).map(e => ({
        kind: e.kind, rank: e.rank, at: e.at,
        beat: e.beat_share ? { share: e.beat_share, score: e.beat_score2, ticks: e.beat_ticks, codename: e.beat_codename } : null,
      }));
      view.rank = { current: DB.rankOnBoard(run.board, run), atSubmit: run.rank_at_submit, best: DB.bestRankOf(run.id), total: DB.countBoard(run.board) };
    }
    return json(res, 200, view, { 'Cache-Control': view.queued ? 'no-store' : 'public, max-age=300' });
  }
  if (req.method === 'GET' && seg[0] === 'queue') {
    return json(res, 200, Object.assign({ loopLag: lagStats() }, queue.info()), { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET' && seg[0] === 'rank' && DB.validShare(seg[1])) {
    const run = DB.getRunByShare(seg[1]);
    if (!run) return json(res, 404, { error: 'not-found' });
    return json(res, 200, {
      share: run.share, board: run.board, metric: DB.metricOf(run.mode),
      rank: DB.rankOnBoard(run.board, run), rankAtSubmit: run.rank_at_submit,
      best: DB.bestRankOf(run.id), total: DB.countBoard(run.board), hold: DB.holdForRun(run.id),
    });
  }

  /* ---------- 쓰기 ---------- */
  if (req.method === 'POST' && seg[0] === 'session') {
    const body = await readJson(req, res); if (!body) return;
    if (!DB.takeSlot('tok:' + iph, CFG.LIMITS.tokenPerHour, 36e5)) return json(res, 429, { error: 'rate-limit' });
    const fp = ID.validFp(body.fp) ? body.fp : null;
    if (fp && !DB.takeSlot('tokfp:' + fp, CFG.LIMITS.tokenPerHour * 2, 36e5)) return json(res, 429, { error: 'rate-limit' });
    const mode = EN.MODES[body.mode] ? body.mode : 'marathon';
    const level = Math.max(1, Math.min(EN.MAX_LEVEL, (body.level | 0) || 1));
    const g20 = !!body.g20;
    const board = DB.boardKey(mode, level, g20);
    const seed = DB.issueToken(board, iph, fp);
    return json(res, 200, {
      seed, board, mode, level, g20,
      issuedAt: DB.now(), serverTime: DB.now(), tickHz: EN.HZ,
      nonce: crypto.randomBytes(8).toString('base64url'),
    }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'POST' && seg[0] === 'play' && DB.validShare(seg[1])) {
    const run = DB.getRunByShare(seg[1]);
    if (run) DB.playback(run.id, q('v'), 'api', q('via'));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && seg[0] === 'submit') {
    const body = await readJson(req, res); if (!body) return;
    if (!DB.takeSlot('sub:' + iph, CFG.LIMITS.submitPerMin, 6e4)) return json(res, 429, { error: 'rate-limit-60s' }, { 'Retry-After': '10' });
    if (!DB.takeSlot('subh:' + iph, CFG.LIMITS.submitPerHour, 36e5)) return json(res, 429, { error: 'rate-limit' });

    let rec;
    try { rec = RP.unpack(String(body.replay || '')); }
    catch (e) { return json(res, 400, { error: 'bad-replay', why: e.message }); }

    const board = DB.boardKey(rec.mode, rec.level, rec.g20);
    const fp = ID.validFp(body.fp) ? body.fp : null;
    const digest = V.digestOf(rec);

    /* 1) 내용 중복 (가장 싼 검사부터). 같은 내용을 다시 보내는 경우는 "재전송"으로 봐준다.
       다른 지문이면 도용 → 409. 선등록자 우선이라 남의 리플레이를 복사해 올리는 것이 불가능하다. */
    const dup = DB.getRunByDigest(digest);
    if (dup) {
      if (fp && dup.fp === fp) {
        return json(res, 200, { status: dup.status, share: dup.share, url: '/r/' + dup.share, duplicate: 'self' });
      }
      return json(res, 409, {
        error: 'duplicate', of: dup.share, at: dup.submitted_at,
        why: '이미 등록된 리플레이입니다. 같은 플레이를 다른 사람 기록으로 올릴 수 없습니다.',
      });
    }

    /* 2) 1회용 시드 — 서버가 발급하지 않은/이미 쓰인 시드는 재시뮬할 것도 없이 기각 */
    const tok = DB.peekToken(rec.seed);
    if (!tok.ok) return json(res, 422, { error: 'token', why: tok.why });
    if (tok.board !== board) return json(res, 422, { error: 'token', why: 'board-mismatch' });

    /* 3) 소유 서명: 이 내용을 이 기기가 승인했다 */
    if (fp) {
      const ov = ownership(body, fp, 'NTSUB1', [digest, String(body.nonce || '')]);
      if (!ov.ok) return json(res, 422, { error: 'ownership', why: ov.why });
      if (!DB.takeSlot('subfp:' + fp, CFG.LIMITS.submitPerHour, 36e5)) return json(res, 429, { error: 'rate-limit' });
      DB.touchOwner(fp, null, body.lang);
    }
    const dn = V.cleanDisplayName(body.displayName);
    if (!dn.ok) return json(res, 400, { error: 'display-name', why: dn.why });
    if (dn.name && fp) DB.touchOwner(fp, dn.name, body.lang);

    /* 4) 계산 없이 걸러내는 것들 — 워커에 넘기기 전에 끝낸다 (싸고, flooding 에 강하다) */
    const shape = RP.checkShape(rec, CFG.LIMITS);
    if (shape.length) return json(res, 400, { error: 'bad-replay', why: shape.join(',') });
    if (rec.ticks < CFG.LIMITS.minTicksAbs) return json(res, 422, { error: 'rejected', code: 'too-short' });
    const realMs = DB.now() - tok.issuedAt;
    if (RP.seconds(rec.ticks) * 1000 > realMs + CFG.LIMITS.wallclockGraceMs) {
      DB.consumeToken(rec.seed, iph, fp);
      const n = DB.countUp('rej:' + iph, 36e5);
      if (n > CFG.LIMITS.rejectsBeforeBan) DB.ban(iph, 'repeat-rejection:wallclock');
      return json(res, 422, { error: 'rejected', code: 'wallclock', strikes: n });
    }

    /* 5) 동시 대기 제한 — 한 네트워크/기기가 큐를 독차지하지 못하게 */
    if (DB.inFlightByIp(iph) >= CFG.LIMITS.inFlightPerIp)
      return json(res, 429, { error: 'queue-busy', why: '이 네트워크에 검증 대기 중 인 기록이 너무 많습니다' }, { 'Retry-After': '30' });
    if (fp && DB.inFlightByFp(fp) >= CFG.LIMITS.inFlightPerFp)
      return json(res, 429, { error: 'queue-busy' }, { 'Retry-After': '30' });

    /* 6) 접수 — 재시뮬은 요청 경로에서 하지 않는다. 행을 queued 로 박아두고(크래시 복구용)
          워커 큐에 넘긴 다음 즉시 202 로 돌려준다. 시드는 이 시점에 원자적으로 소진된다. */
    const used = DB.consumeToken(rec.seed, iph, fp);
    if (!used.ok) return json(res, 422, { error: 'token', why: used.why });

    const challengeOf = body.challengeOf && DB.validShare(body.challengeOf) && DB.getRunByShare(body.challengeOf)
      ? body.challengeOf : null;

    const run = DB.insertRun({
      share: DB.shareKey(), digest: digest, replay: String(body.replay), board: board,
      mode: rec.mode, level: rec.level, g20: rec.g20 ? 1 : 0, seed: rec.seed,
      score: rec.score, lines: rec.lines, pieces: rec.pieces, ticks: rec.ticks, hash: rec.hash,
      rules: rec.rules || EN.RULES_ID, status: 'queued', input_count: rec.inputs.length, ghost: null,
    }, {
      ipHash: iph, ipHint: ID.ipMask(ip), fp: fp, reveal: body.reveal !== false,
      challengeOf: challengeOf, clientVer: body.clientVer, lang: body.lang, issuedAt: tok.issuedAt,
      device: V.cleanDevice(body.device),   /* 표시 전용 태그(자가 신고). 판정에는 쓰지 않는다. */
    });

    const added = queue.add({
      id: run.id, packed: String(body.replay), board: board, mode: rec.mode,
      score: rec.score, ticks: rec.ticks, fp: fp, ipHash: iph, issuedAt: tok.issuedAt,
    });
    if (!added.ok) {
      DB.finalizeRun(run.id, { status: 'rejected', reject: 'queue-full', verified_at: DB.now() });
      return json(res, 503, { error: 'queue-full', depth: added.pos }, { 'Retry-After': '60' });
    }

    return json(res, 202, {
      status: 'queued', share: run.share, url: '/r/' + run.share,
      tier: added.tier, queue: queue.position(run.id),
      displayName: dn.name || null,
      codename: fp ? ID.codename(fp, body.lang) : null,
      fp: fp,
    }, { 'Cache-Control': 'no-store' });
  }

  /* 내 기록 — 지문 소유 증명(서명)이 있어야 한다. 지문 자체는 31^5 라서 총공격 가능 → 서명 필수 */
  if (req.method === 'POST' && seg[0] === 'mine') {
    const body = await readJson(req, res); if (!body) return;
    const fp = body.fp;
    const ov = ownership(body, fp, 'NTMINE1', [String(body.nonce || '')]);
    if (!ov.ok) return json(res, 403, { error: 'ownership', why: ov.why });
    return json(res, 200, {
      codename: ID.codename(fp, body.lang),
      list: V.boardList(DB.runsByFp(fp, 50), { reveal: true }),      // 자기 기록이므로 이름 노출 OK
    }, { 'Cache-Control': 'no-store' });
  }

  /* 본인 요청 숨김 — 삭제 아님, 목록 제외만 */
  if (req.method === 'POST' && seg[0] === 'hide' && DB.validShare(seg[1])) {
    const body = await readJson(req, res); if (!body) return;
    const run = DB.getRunByShare(seg[1]);
    if (!run || !run.fp) return json(res, 404, { error: 'not-found' });
    const ov = ownership(body, run.fp, 'NTHIDE1', [run.share, String(body.nonce || '')]);
    if (!ov.ok) return json(res, 403, { error: 'ownership', why: ov.why });
    DB.recordNote(run.id, 'withdrawn');
    return json(res, 200, { ok: true, note: '기록은 삭제되지 않고 목록에서만 제외됩니다.' });
  }

  return json(res, 404, { error: 'no-such-api', path: u.pathname });
}

/* ================= 라우터 ================= */
function serveStatic(res, rel, type) {
  const p = path.join(CFG.ROOT, rel);
  if (!p.startsWith(CFG.ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  send(res, 200, fs.readFileSync(p), {
    'Content-Type': type,
    'Cache-Control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, 'bad url', { 'Content-Type': 'text/plain' }); }
  const p = u.pathname;
  try {
    if (p.indexOf('/api/') === 0) return await handleApi(req, res, u);
    if (STATIC[p]) {
      const [rel, type] = STATIC[p];
      if (rel === 'index.html') return serveIndex(req, res, null);
      return serveStatic(res, rel, type);
    }
    const m = /^\/r\/([0-9a-z]{17})$/.exec(p);            // 공유 링크
    if (m) {
      const run = DB.getRunByShare(m[1]);
      if (!run || ['rejected', 'hidden', 'withdrawn'].indexOf(run.status) >= 0) {
        return send(res, 404, '없는 기록입니다.', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      return serveIndex(req, res, run);
    }
    return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' });
  } catch (err) {
    console.error('[err]', p, (err && err.stack) || err);
    return send(res, 500, 'internal error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

/* ================= 배치 (스냅샷·파기) ================= */
function startJobs() {
  setInterval(() => {
    try {
      const s = DB.snapshot(10);
      if (s.rows) console.log('[snap] boards=' + s.rows + ' at=' + new Date(s.at).toISOString());
      DB.sweepTokens();
      DB.pruneIps();
    } catch (e) { console.error('[job]', e.message); }
  }, 36e5).unref();
  setInterval(() => { try { DB.sweepTokens(); DB.pruneIps(); } catch (e) { /* noop */ } }, 6e5).unref();
}

if (require.main === module) {
  startJobs();
  /* 워커 격자는 첫 제출 때 만드는 게 아니라 지금 만든다 — 워커 한 개 기동에 ~200ms 걸려
     그 비용이 아무 관계 없는 첫 사용자에게 떨어지는 걸 막는다. */
  queue.start();
  try { DB.snapshot(10); } catch (e) { console.error('[snap] 초기 스냅샷 실패:', e.message); }
  try { queue.recover(); } catch (e) { console.error('[queue] 복구 실패:', e.message); }
  server.listen(CFG.PORT, CFG.HOST, () => {
    /* "http://localhost:8787" 만 찍어 온 걸 고친다. 0.0.0.0 에 떠서 다른 기기가 붙는 서버가
       로그만 보면 localhost 전용으로 보인다 → 애플리케이션을 30분 의심하고 방화벽을 마지막에 본다(실사례).
       IP 를 보여주면 그 다음 함정(비-locahost http 는 보안 컨텍스트가 아니라 제출이 꺼진다)도 같이 알려야 한다. */
    const os = require('os');
    const lan = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) if (String(it.family) === 'IPv4' && !it.internal) lan.push(it.address);
    }
    const open = CFG.HOST === '0.0.0.0' || CFG.HOST === '::';
    console.log('NEON TETRIS   data: ' + CFG.DATA_DIR + '   workers: ' + CFG.LIMITS.workers);
    console.log('  바인딩      ' + CFG.HOST + ':' + CFG.PORT + (open ? ' (모든 인터페이스)' : ' ← 이 주소로만 열림'));
    console.log('  이 기기     http://localhost:' + CFG.PORT + '   (제출·보드·공유 활성)');
    lan.forEach((ip) => {
      console.log('  이 네트워크 http://' + ip + ':' + CFG.PORT + (open ? '' : '   ← 바인딩이 ' + CFG.HOST + ' 라 이 주소로는 안 열립니다'));
    });
    if (lan.length && open) {
      console.log('  참고        IP 주소로 열면 브라우저가 보안 컨텍스트가 아니라 제출·보드·공유가 꺼지고 게임만 돈다 (http://localhost 는 예외).');
      console.log('              다른 기기에서 안 열리면 대개 그 기기의 방화벽 인바운드(TCP ' + CFG.PORT + ') 문제이지 이 서버가 아니다.');
    }
  });
}

module.exports = { server, handleApi, queue };

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

const START = Date.now();

/* ================= 정적 허용 목록 ================= */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
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

/* ================= 재시뮬 동시성 보호 ================= */
let simBusy = 0;
function simSlot() {
  if (simBusy >= CFG.SIM_SLOTS) return null;
  simBusy++;
  return () => { simBusy--; };
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
    return json(res, 200, Object.assign({ ok: true, uptime: Math.round((Date.now() - START) / 1000), simBusy: simBusy }, DB.totals()));
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
    const rows = DB.periodBoard(period, board, parseInt(q('limit') || '10', 10) || 10);
    return json(res, 200, {
      period: period, board: board || null,
      rows: rows.map(r => ({
        rank: r.rank, share: r.share, board: r.board, mode: r.mode, score: r.score,
        lines: r.lines, ticks: r.ticks, fp: r.fp, status: r.status,
        codename: r.fp ? ID.codename(r.fp, 'ko') : null,        // 기간 뷰도 이름은 싣지 않는다
      })),
    }, { 'Cache-Control': 'public, max-age=300' });
  }
  if (req.method === 'GET' && seg[0] === 'hold') {
    const board = DB.boardKey(q('mode') || 'marathon', parseInt(q('level') || '1', 10) || 1, q('g20') === '1');
    return json(res, 200, DB.holdInfo(board), { 'Cache-Control': 'public, max-age=60' });
  }
  if (req.method === 'GET' && seg[0] === 'replay' && DB.validShare(seg[1])) {
    const run = DB.getRunByShare(seg[1]);
    if (!run || ['rejected', 'hidden', 'withdrawn'].indexOf(run.status) >= 0) return json(res, 404, { error: 'not-found' });
    const view = V.publicRun(run, { reveal: !!run.reveal });     // ← 여기서만 이름이 노출된다
    view.replay = run.replay;
    view.ghost = run.ghost ? JSON.parse(run.ghost) : null;
    view.displayName = view.displayName || null;   // 클라가 '미표시'를 구분할 수 있게 명시
    view.hold = DB.holdForRun(run.id);
    view.lineage = DB.lineageOf(run.id).map(e => ({
      kind: e.kind, rank: e.rank, at: e.at,
      beat: e.beat_share ? { share: e.beat_share, score: e.beat_score2, ticks: e.beat_ticks, codename: e.beat_codename } : null,
    }));
    view.rank = { current: DB.rankOnBoard(run.board, run), atSubmit: run.rank_at_submit, best: DB.bestRankOf(run.id), total: DB.countBoard(run.board) };
    return json(res, 200, view, { 'Cache-Control': 'public, max-age=300' });
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

    /* 4) 시드 소진(원자적) — 기각으로 끝나도 이 시드는 다시 쓸 수 없다 */
    const used = DB.consumeToken(rec.seed, iph, fp);
    if (!used.ok) return json(res, 422, { error: 'token', why: used.why });

    const release = simSlot();
    if (!release) return json(res, 503, { error: 'busy', retryAfter: 5 }, { 'Retry-After': '5' });
    let v;
    try { v = V.verify(rec, { issuedAt: tok.issuedAt, now: DB.now(), ipHash: iph }); }
    finally { release(); }

    if (v.status === 'rejected') {
      const row = DB.registerRun({
        share: DB.shareKey(), digest: 'rej-' + digest, replay: String(body.replay), board: board,
        mode: rec.mode, level: rec.level, g20: rec.g20 ? 1 : 0, seed: rec.seed,
        score: rec.score, lines: rec.lines, pieces: rec.pieces, ticks: rec.ticks, hash: rec.hash,
        status: 'rejected', reject: v.code, flags: v.flags, sim_ms: v.simMs, verify_ms: v.verifyMs,
      }, { ipHash: iph, ipHint: ID.ipMask(ip), fp: fp, clientVer: body.clientVer, lang: body.lang });
      const n = DB.countUp('rej:' + iph, 36e5);
      if (n > CFG.LIMITS.rejectsBeforeBan) DB.ban(iph, 'repeat-rejection:' + v.code);
      return json(res, 422, { error: 'rejected', code: v.code, mismatch: v.mismatch, share: row.share, strikes: n });
    }

    const challengeOf = body.challengeOf && DB.validShare(body.challengeOf) && DB.getRunByShare(body.challengeOf)
      ? body.challengeOf : null;

    const run = DB.registerRun({
      share: DB.shareKey(), digest: digest, replay: String(body.replay), board: board,
      mode: rec.mode, level: rec.level, g20: rec.g20 ? 1 : 0, seed: rec.seed,
      score: rec.score, lines: rec.lines, pieces: rec.pieces, ticks: rec.ticks, hash: rec.hash,
      over_reason: rec.overReason || null,
      tetrises: v.sim.tetrises, tspins: v.sim.tspins, pcs: v.sim.pcs, max_combo: v.sim.maxCombo,
      pps: v.metrics.pps, apm: v.metrics.apm, inp_rate: v.metrics.ips, input_count: rec.inputs.length,
      ghost: JSON.stringify(v.ghost || null),
      status: v.status, flags: v.flags, sim_ms: v.simMs, verify_ms: v.verifyMs,
    }, {
      ipHash: iph, ipHint: ID.ipMask(ip), fp: fp, reveal: body.reveal !== false,
      challengeOf: challengeOf, clientVer: body.clientVer, lang: body.lang, issuedAt: tok.issuedAt,
    });

    const top = DB.topOfBoard(board);
    return json(res, 200, {
      status: run.status, share: run.share, url: '/r/' + run.share,
      hardFlags: v.hard, softFlags: (v.flags || []).filter(function (f) { return V.SEVERITY[f] !== 'hard'; }),
      rank: run.rank_at_submit, total: DB.countBoard(board),
      isTop: !!(top && top.id === run.id),
      bestRank: DB.bestRankOf(run.id),
      flags: v.flags, metrics: v.metrics,
      displayName: dn.name || null,
      codename: fp ? ID.codename(fp, body.lang) : null,
      fp: fp, verifyMs: v.verifyMs, simMs: v.simMs,
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
    const m = /^\/r\/([0-9a-z]{13})$/.exec(p);            // 공유 링크
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
  try { DB.snapshot(10); } catch (e) { console.error('[snap] 초기 스냅샷 실패:', e.message); }
  server.listen(CFG.PORT, CFG.HOST, () => {
    console.log('NEON TETRIS  http://localhost:' + CFG.PORT + '   data: ' + CFG.DATA_DIR);
  });
}

module.exports = { server, handleApi };

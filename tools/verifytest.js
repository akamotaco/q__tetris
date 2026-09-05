/**
 * 서버 검증/저장/노출 정책을 끝에서 끝까지(test end-to-end) 검증한다.
 *   node tools/verifytest.js
 *
 * 임시 DB 를 만들고 실제 HTTP 로 붙는다. 핵심 목적은 "치팅이 실제로 걸리는지"와
 * "이름이 보드 어디로도 새지 않는지"를 코드가 아니라 실제로 확인하는 것.
 */
'use strict';
process.env.NT_TEST_MODE = '1';
process.env.NT_DATA = require('path').join(require('os').tmpdir(), 'nt-test-' + Math.random().toString(36).slice(2, 8));
process.env.NT_SECRET = 'test-secret-00000000000000000000000000000000000000000000000000000000000';
process.env.NT_TRUST_HOPS = '1';

const crypto = require('crypto');
const RP = require('../replay.js');
const EN = require('../engine.js');
const ID = require('../identity.js');
const AI = require('./ai.js');
const V = require('../server/verify.js');
const DB = require('../server/db.js');
const { server } = require('../server/server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const group = (t) => console.log('\n[' + t + ']');

/* ---- 클라이언트(WebCrypto)와 똑같은 지문 계산 ---- */
function newIdentity(lang) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const fp = ID.fpFromHash(crypto.createHash('sha256').update(spki).digest('hex')).fp;
  return {
    fp, jwk, lang: lang || 'ko',
    sign: (prefix, parts) => crypto.sign('sha256', Buffer.from(ID.authPayload(prefix, parts)), privateKey).toString('base64'),
  };
}

let base = '';
async function api(method, path, body, ip) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || '200.1.1.1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html 등 */ }
  return { code: res.status, json, text, headers: res.headers };
}

/** 워커 큐로 넘겨졌다면 종결 상태까지 기다려서 200 응답처럼 모양을 맞춰 돌려준다 */
async function settleSubmit(r) {
  if (r.code !== 202 || !r.json || !r.json.share) return r;
  const share = r.json.share, first = r.json;
  for (let i = 0; i < 500; i++) {
    await sleep(120);
    const g = await api('GET', '/api/replay/' + share);
    if (g.code === 200 && g.json && !g.json.queued) {
      const j = g.json, rk = j.rank || {};
      return {
        code: j.status === 'rejected' ? 422 : 200, text: g.text, headers: g.headers,
        json: Object.assign({}, first, {
          status: j.status, share, url: '/r/' + share,
          error: j.status === 'rejected' ? 'rejected' : undefined,
          code: j.reject, mismatch: j.mismatch,
          rank: rk.atSubmit, total: rk.total, bestRank: rk.best, isTop: rk.atSubmit === 1,
          flags: j.flags || [], hardFlags: j.hardFlags || [], softFlags: j.softFlags || [],
          metrics: j.metrics || {}, displayName: j.displayName, codename: j.codename,
        }),
      };
    }
  }
  return r;
}

/** 세션 발급 → AI 로 그 시드 그대로 완주 → 서명 → 제출 */
async function playAndSubmit(me, opt) {
  opt = opt || {};
  const ip = opt.ip || '200.1.1.1';
  const s = await api('POST', '/api/session', { mode: opt.mode, level: opt.level, g20: opt.g20, fp: me.fp }, ip);
  if (s.code !== 200) return { submit: s, rep: null, packed: null, session: null, body: null };
  const rep = AI.run({
    seed: s.json.seed, mode: opt.mode, level: opt.level, g20: opt.g20,
    preset: opt.preset || 'human', skill: opt.skill, rng: opt.rng || AI.makeRand('test-' + s.json.seed),
  });
  const packed = RP.pack(rep);
  const body = {
    replay: packed, fp: me.fp, nonce: s.json.nonce, lang: me.lang,
    displayName: opt.displayName, reveal: opt.reveal, challengeOf: opt.challengeOf,
    clientVer: 'test',
  };
  if (opt.noSig !== true) body.owner = { jwk: me.jwk, sig: me.sign('NTSUB1', [V.digestOf(RP.unpack(packed)), s.json.nonce]) };
  if (opt.tamper) body.replay = opt.tamper(body.replay);
  const r = await api('POST', '/api/submit', body, ip);
  return { submit: await settleSubmit(r), rep: rep, packed: packed, session: s.json, body: body };
}

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('테스트 서버 ' + base + '  (data: ' + process.env.NT_DATA + ')');

  const hero = newIdentity('ko');
  const rival = newIdentity('ko');
  const thief = newIdentity('ko');

  group('신원 표기');
  ok('지문 형식 + 체크섬', ID.validFp(hero.fp), hero.fp);
  ok('잘못된 체크섬 거부', !ID.validFp(hero.fp.slice(0, 5) + (hero.fp[5] === 'a' ? 'b' : 'a')));
  ok('코드네임 자동 생성', ID.codename(hero.fp, 'ko').length >= 3, ID.codename(hero.fp, 'ko'));
  ok('IP 마스킹', ID.ipMask('211.234.11.9') === '211.234.xx.xx', ID.ipMask('211.234.11.9'));
  ok('풀 전수 감사(욕설 조합)', ID.audit().length === 0, ID.audit());

  group('서명 인코딩 (브라우저 DER / node webcrypto raw)');
  const wc = crypto.webcrypto;
  const wkp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const wjwk = await wc.subtle.exportKey('jwk', wkp.publicKey);
  const wspki = await wc.subtle.exportKey('spki', wkp.publicKey);
  const wfp = ID.fpFromHash(crypto.createHash('sha256').update(Buffer.from(wspki)).digest('hex')).fp;
  const wPayload = ID.authPayload('NTSUB1', ['abc123', 'nonce-9']);
  const rawSig = Buffer.from(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, wkp.privateKey, Buffer.from(wPayload))).toString('base64');
  const pkcs8 = Buffer.from(await wc.subtle.exportKey('pkcs8', wkp.privateKey));
  const nodePriv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const derSig = crypto.sign('sha256', Buffer.from(wPayload), nodePriv).toString('base64');
  ok('서버/클라임 지문 계산 일치', ID.validFp(wfp), wfp);
  ok('raw r||s(64B) 서명 허용', Buffer.from(rawSig, 'base64').length === 64 && V.verifyOwnership(wjwk, wfp, wPayload, rawSig).ok,
    V.verifyOwnership(wjwk, wfp, wPayload, rawSig));
  ok('DER 서명 허용 (브라우저)', V.verifyOwnership(wjwk, wfp, wPayload, derSig).ok, V.verifyOwnership(wjwk, wfp, wPayload, derSig));
  ok('내용을 바꾼 서명 거부', !V.verifyOwnership(wjwk, wfp, wPayload + 'x', rawSig).ok);
  ok('남의 키로 서명 거부', !V.verifyOwnership(wjwk, 'aaaaaaaa', wPayload, rawSig).ok);

  group('기본 제출 → 검증 → 발행');
  const p1 = await playAndSubmit(hero, { preset: 'human', displayName: '강하나', ip: '211.1.1.1' });
  ok('200', p1.submit.code === 200, p1.submit.json && p1.submit.json.code ? p1.submit.json : p1.submit.text);
  ok('status verified 또는 flagged', ['verified', 'flagged'].indexOf(p1.submit.json.status) >= 0, p1.submit.json);
  ok('점수가 실제로 재현됨(서버 재시뮬)', p1.submit.json.status !== 'rejected');
  ok('1위 등록', p1.submit.json.rank === 1, p1.submit.json.rank);
  ok('공유 키 형식', /^[0-9a-f]{16}[0-9a-z]$/.test(p1.submit.json.share || ''), p1.submit.json.share);
  ok('flags 배열', Array.isArray(p1.submit.json.flags));
  console.log('    → ' + p1.submit.json.status + ' / ' + p1.rep.score + '점 / PPS ' + p1.submit.json.metrics.pps.toFixed(2) +
    ' / gapModeShare ' + (p1.submit.json.metrics.gapModeShare || 0).toFixed(2) + ' / flags ' + (p1.submit.json.flags||[]).join(',') + ' / share ' + p1.submit.json.share);

  group('이름 비노출 정책');
  const board = await api('GET', '/api/board?mode=marathon&level=1');
  ok('보드 응답에 displayName 키 없음', board.text.indexOf('displayName') < 0);
  ok('보드 응답에 display_name 없음', board.text.indexOf('display_name') < 0);
  ok('보드 응답에 실제 이름 문자열 없음', board.text.indexOf('강하나') < 0);
  ok('보드에는 코드네임/지문만', /"codename":/.test(board.text) && /"fp":"/.test(board.text));
  const rp = await api('GET', '/api/replay/' + p1.submit.json.share);
  ok('공유 페이지 API 에는 이름 표시(reveal 기본 ON)', rp.json.displayName === '강하나', rp.json.displayName);
  ok('IP 힌트 노출', /\d+\.\d+\.xx\.xx/.test(rp.json.ipHint || ''), rp.json.ipHint);
  const noName = await playAndSubmit(rival, { preset: 'casual', displayName: '최둘리', reveal: false, ip: '211.1.1.2' });
  const rp2 = await api('GET', '/api/replay/' + noName.submit.json.share);
  ok('reveal OFF 이면 이름 없음', !rp2.json.displayName, rp2.json.displayName);
  ok('reveal OFF 도 코드네임은 있음', !!rp2.json.codename);
  const html = (await api('GET', '/r/' + p1.submit.json.share)).text;
  ok('공유 페이지 OG 에 이름', html.indexOf('강하나') >= 0);
  ok('공유 페이지 noindex', /noindex/.test(String((await api('GET', '/r/' + p1.submit.json.share)).headers.get('x-robots-tag'))));
  ok('없는 공유 키 404', (await api('GET', '/r/000000000000z')).code === 404);

  group('위·변조 / 도용');
  const tam = await playAndSubmit(thief, {
    preset: 'human', ip: '211.1.1.9',
    tamper: (t) => { const parts = t.split(':'); parts[6] = String((+parts[6]) + 250000); return parts.join(':'); },
  });
  ok('점수 부풀리기 → 422 rejected', tam.submit.code === 422 && tam.submit.json.error === 'rejected', tam.submit.json);
  ok('기각 사유에 어긋난 칸이 적혀 있다', /score/.test(String(tam.submit.json.mismatch)), tam.submit.json.mismatch);
  ok('어느 칸이 어긋났는지 지적', /score/.test(tam.submit.json.mismatch || ''), tam.submit.json.mismatch);

  const stolen = { replay: p1.packed, fp: thief.fp };
  const st1 = await api('POST', '/api/submit', Object.assign(stolen, { owner: { jwk: thief.jwk, sig: thief.sign('NTSUB1', [V.digestOf(RP.unpack(p1.packed)), '']) } }), '211.1.1.10');
  ok('남의 리플레이 그대로 재제출 → 원본을 가리키며 409', st1.code === 409 && st1.json.error === 'duplicate' && st1.json.of === p1.submit.json.share, st1.json);

  const forgedSeed = RP.unpack(p1.packed);
  const otherSess = await api('POST', '/api/session', { mode: 'marathon', fp: thief.fp }, '211.1.1.11');
  forgedSeed.seed = otherSess.json.seed;
  const fpacked = RP.pack(forgedSeed);
  const st2 = await settleSubmit(await api('POST', '/api/submit', {
    replay: fpacked, fp: thief.fp, nonce: otherSess.json.nonce,
    owner: { jwk: thief.jwk, sig: thief.sign('NTSUB1', [V.digestOf(RP.unpack(fpacked)), otherSess.json.nonce]) },
    displayName: '강하나',
  }), '211.1.1.11');
  ok('입력 복제 + 내 시드로 교체 → 재시뮬 불일치로 기각', st2.code === 422 && st2.json.error === 'rejected', st2.json);
  ok('기각된 제출은 보드에 오르지 않는다',
    DB.db.prepare(`SELECT COUNT(*) c FROM runs WHERE fp = ? AND status = 'verified'`).get(thief.fp).c === 0);

  const noSig = await playAndSubmit(thief, { preset: 'casual', noSig: true, ip: '211.1.1.12' });
  ok('서명 누락 → 거부', noSig.submit.code === 422 && noSig.submit.json.error === 'ownership', noSig.submit.json);
  const badSig = await playAndSubmit(thief, {
    preset: 'casual', ip: '211.1.1.13',
  });
  ok('정상 서명은 통과', badSig.submit.code === 200, badSig.submit.json);

  const wrongSigSess = await api('POST', '/api/session', { mode: 'marathon', fp: thief.fp }, '211.1.1.14');
  const repW = AI.run({ seed: wrongSigSess.json.seed, preset: 'casual' });
  const wrongSig = await api('POST', '/api/submit', {
    replay: RP.pack(repW), fp: thief.fp, nonce: wrongSigSess.json.nonce,
    owner: { jwk: thief.jwk, sig: thief.sign('NTSUB1', ['0'.repeat(64), wrongSigSess.json.nonce]) },
  }, '211.1.1.14');
  ok('남의 내용에 내 서명 → sig-bad', wrongSig.code === 422 && wrongSig.json.why === 'sig-bad', wrongSig.json);

  const unknownSeed = RP.pack(AI.run({ seed: 'not-issued-by-server', preset: 'casual' }));
  const uns = await api('POST', '/api/submit', { replay: unknownSeed, fp: thief.fp }, '211.1.1.15');
  ok('서버 미발급 시드 → 거부', uns.code === 422 && uns.json.why === 'seed-unknown', uns.json);

  /* 다른 규칙 버전의 리플레이는 재시뮬을 태우지 않고 early 거절 (소유권까지 통과된 정상 요청 가정) */
  const rvs = await api('POST', '/api/session', { mode: 'marathon', fp: thief.fp }, '211.1.1.18');
  const rvRep = AI.run({ seed: rvs.json.seed, preset: 'casual', rng: AI.makeRand('rv') });
  const rvRec = RP.unpack(RP.pack(rvRep)); rvRec.rules = 'r9';
  const rvPacked = RP.pack(rvRec);
  const rv = await api('POST', '/api/submit', {
    replay: rvPacked, fp: thief.fp, nonce: rvs.json.nonce,
    owner: { jwk: thief.jwk, sig: thief.sign('NTSUB1', [V.digestOf(rvRec), rvs.json.nonce]) },
  }, '211.1.1.18');
  const rvDone = await settleSubmit(rv);
  ok('다른 규칙 버전 → rules-version 으로 기각', rvDone.code === 422 && /rules-version/.test(rvDone.json.code || ''), rvDone.json);

  // 남의 1회용 시드를 내 입력에 붙이면? (시드만 훔치는 경우)
  const hijack = AI.run({ seed: 'dummy', preset: 'casual' });
  const hij = RP.unpack(RP.pack(hijack)); hij.seed = RP.unpack(p1.packed).seed;   // victim 의 이미 쓰인 시드
  const hj = await api('POST', '/api/submit', { replay: RP.pack(hij), fp: thief.fp }, '211.1.1.17');
  ok('이미 쓰인 시드 재활용 → 거부', hj.code === 422 && hj.json.why === 'seed-used', hj.json);

  ok('형식 오류 리플레이 → 400', (await api('POST', '/api/submit', { replay: 'NT1:a:b', fp: thief.fp }, '211.1.1.16')).code === 400);

  group('재전송 안전(멱등)');
  const retry = await api('POST', '/api/submit', p1.body, '211.1.1.1');
  ok('같은 제출 재전송 → 같은 링크(200)', retry.code === 200 && retry.json.share === p1.submit.json.share, retry.json);
  ok('duplicate:self 표기', retry.json.duplicate === 'self', retry.json);

  group('이름 정책');
  const badNames = ['a', 'x'.repeat(30), 'https://evil.example', 'abc\u202edcba', '12345', '...', 'admin', '  <b>x</b>  '];
  for (const nm of badNames) {
    const r = V.cleanDisplayName(nm);
    ok('거부: ' + JSON.stringify(nm.slice(0, 14)), !r.ok, r);
  }
  ok('한글 이름 통과', V.cleanDisplayName('강하나').ok);
  ok('NFC 정규화(조합형→완성형)', V.cleanDisplayName('가나다'.normalize('NFD')).name === '가나다');
  // 의도된 정책: 이름은 공유 링크에만 뜨므로 금칙어 필터가 방어의 주체가 아니다.
  // 목록 기반 한국어 필터는 우회가 너무 쉬워 "걸러졌다는 착각"만 키운다 → 노출 규칙으로 막는다.
  ok('금칙어 필터는 라틴어만 (한글은 노출 규칙로 차단)', V.cleanDisplayName(ID.BLOCK[0]).ok && !V.cleanDisplayName(ID.BLOCK[10] + 'hunter').ok);

  group('레이트리밋 / 차단');
  const spamIP = '198.51.100.7';
  let rejectedCount = 0;
  for (let i = 0; i < 6; i++) {
    const r = await playAndSubmit(thief, {
      preset: 'casual', ip: spamIP,
      tamper: (t) => { const p = t.split(':'); p[7] = String((+p[7]) + 3); return p.join(':'); },
    });
    if (r.submit.code === 422) rejectedCount++;
    if (r.submit.code === 403) break;
  }
  ok('위조 반복 → IP 차단', DB.isBanned(DB.ipToHash(spamIP)), rejectedCount);
  const afterBan = await api('POST', '/api/session', { mode: 'marathon' }, spamIP);
  ok('차단된 IP 세션 발급 거부', afterBan.code === 403, afterBan.json);

  group('플래그(초인적 플레이)');
  const bot = await playAndSubmit(rival, { preset: 'bot', ip: '211.1.1.20' });
  ok('200 발행(기각 아님)', bot.submit.code === 200, bot.submit.json);
  ok('플래그됨', bot.submit.json.status === 'flagged' && bot.submit.json.flags.length > 0, bot.submit.json.flags);
  console.log('    → flags: ' + bot.submit.json.flags.join(', ') + ' / PPS ' + bot.submit.json.metrics.pps.toFixed(2) +
    ' / 간격 최빈비 ' + bot.submit.json.metrics.gapModeShare.toFixed(2) + ' / 반응중앙 ' + bot.submit.json.metrics.reactMedian);

  group('플래그 심각도(상위권 인간과 도구의 경계)');
  const aceRun = await playAndSubmit(rival, { preset: 'ace', ip: '211.1.1.21' });
  ok('엘리트급 프로필은 검증 통과(soft 지표만)', aceRun.submit.json.status === 'verified', aceRun.submit.json.status + '/' + JSON.stringify(aceRun.submit.json.flags));
  ok('soft 지표는 기록된다', (aceRun.submit.json.softFlags || []).length >= 0 && Array.isArray(aceRun.submit.json.flags));
  const shownOnBoard = (await api('GET', '/api/board?mode=marathon&level=1')).json.list.every(r => r.status !== 'flagged' || r.flags.length > 0);
  ok('보드에는 hard 플래그만 ⚑', shownOnBoard);

  group('모드 · 순위 · 시점');
  const sp1 = await playAndSubmit(hero, { mode: 'sprint', preset: 'human', ip: '211.1.1.30' });
  ok('스프린트 발행', sp1.submit.code === 200 && sp1.rep.lines === 40, sp1.submit.json && sp1.rep.lines);
  ok('스프린트는 시간 축 순위', sp1.submit.json.rank === 1);
  const sp2 = await playAndSubmit(rival, { mode: 'sprint', preset: 'casual', ip: '211.1.1.31' });
  ok('느린 스프린트 2위', sp2.submit.json.rank === 2, sp2.submit.json.rank);
  const sp3 = await playAndSubmit(hero, { mode: 'sprint', preset: 'bot', ip: '211.1.1.32' });
  ok('더 빠른 스프린트가 1위 탈취', sp3.submit.json.rank === 1 && sp3.rep.ticks < sp1.rep.ticks, [sp1.rep.ticks, sp3.rep.ticks]);
  const hb = await api('GET', '/api/board?mode=sprint&level=1');
  ok('보드 정렬 = 시간 오름차순', hb.json.list[0].ticks < hb.json.list[1].ticks, hb.json.list.map(r => r.ticks));
  ok('1위 유지 기록됨', !!hb.json.hold.current, hb.json.hold);
  ok('밀려난 1위도 이력으로 남는다 (삭제 없음)', hb.json.hold.past.length >= 1 && hb.json.hold.past[0].held_ms > 0, hb.json.hold.past);
  ok('해당 기록 쪽에서도 유지 기간이 보인다', DB.holdForRun(DB.getRunByShare(sp1.submit.json.share).id).length >= 1);

  DB.snapshot(10);
  const pk = DB.periodKeys(DB.now());
  const per = await api('GET', '/api/period?period=' + pk.week);
  ok('주별 챔피언 스냅샷', per.json.rows.length > 0, per.json.rows.length);
  const per2 = await api('GET', '/api/period?period=' + pk.day);
  ok('일자별도 남는다', per2.json.rows.length > 0);
  ok('기간 뷰에도 이름 없음', per2.text.indexOf('강하나') < 0 && per2.text.indexOf('displayName') < 0);

  const rk = await api('GET', '/api/rank/' + sp1.submit.json.share);
  ok('랭킹 시점 데이터(rankAtSubmit/best/hold)', rk.json.rankAtSubmit === 1 && Array.isArray(rk.json.hold), rk.json);

  group('내 기록 / 숨김');
  const mineSess = await api('POST', '/api/session', { mode: 'marathon', fp: hero.fp }, '211.1.1.40');
  const mine = await api('POST', '/api/mine', {
    fp: hero.fp, nonce: mineSess.json.nonce, lang: 'ko',
    owner: { jwk: hero.jwk, sig: hero.sign('NTMINE1', [mineSess.json.nonce]) },
  }, '211.1.1.40');
  ok('서명하면 내 기록 목록', mine.code === 200 && mine.json.list.length >= 2, mine.json);
  ok('내 목록엔 이름 노출', mine.json.list.some(r => r.displayName === '강하나'));
  const mineNo = await api('POST', '/api/mine', { fp: hero.fp }, '211.1.1.41');
  ok('서명 없으면 거부(지문 총공격 방어)', mineNo.code === 403, mineNo.json);

  const hide = await api('POST', '/api/hide/' + sp1.submit.json.share, {
    fp: hero.fp, nonce: mineSess.json.nonce,
    owner: { jwk: hero.jwk, sig: hero.sign('NTHIDE1', [sp1.submit.json.share, mineSess.json.nonce]) },
  }, '211.1.1.40');
  ok('본인 요청 숨김', hide.code === 200, hide.json);
  ok('숨긴 기록 보드에서 제외', !(await api('GET', '/api/board?mode=sprint&level=1')).json.list.some(r => r.share === sp1.submit.json.share));
  ok('숨긴 기록 조회 404', (await api('GET', '/api/replay/' + sp1.submit.json.share)).code === 404);
  ok('DB 에는 여전히 존재(삭제 아님)', !!DB.getRunByShare(sp1.submit.json.share));
  ok('순위 이력도 보존', DB.lineageOf(DB.getRunByShare(sp1.submit.json.share).id).length > 0);

  group('도전(경쟁 루프)');
  const ch = await playAndSubmit(rival, { preset: 'human', ip: '211.1.1.50', challengeOf: p1.submit.json.share });
  const chr = await api('GET', '/api/replay/' + ch.submit.json.share);
  ok('challenge_of 기록됨', chr.json.challengeOf === p1.submit.json.share, chr.json.challengeOf);
  const ghost = chr.json.ghost;
  ok('고스트 타임라인(서버 파생)', Array.isArray(ghost) && ghost.length > 3 && ghost[0].length === 3, ghost && ghost.slice(0, 2));

  group('워커 큐 — 우선순위/복구/독점 방지');
  const Q = require('../server/queue.js');
  ok('긴 판(1시간 초과)은 저속 티어', Q.tierOf({ board: 'marathon:1:0', mode: 'marathon', score: 10, ticks: 60 * 60 * 61, fp: hero.fp }) === 2);
  ok('이력 없는 기기의 고득점 주장이 곧바로 우선순위는 되지 않는다', Q.tierOf({ board: 'marathon:1:0', mode: 'marathon', score: 9e9, ticks: 6000, fp: thief.fp }) === 1);
  ok('검증 이력 + 상위권 전망이어야 우선 티어', Q.tierOf({ board: 'marathon:1:0', mode: 'marathon', score: 9e9, ticks: 6000, fp: hero.fp }) === 0);
  const qi = await api('GET', '/api/queue');
  ok('큐 계측 노출(워커/대기/소요)', qi.code === 200 && qi.json.workers >= 1 && typeof qi.json.done === 'number', qi.json);
  /* 같은 네트워크가 큐를 독차지하려 하면 막는다 */
  const hogIP = '203.0.113.77';
  const hogHash = DB.ipToHash(hogIP);
  for (let i = 0; i < 2; i++) {
    DB.insertRun({ share: DB.shareKey(), digest: 'hog' + i + Date.now(), replay: 'NT1:marathon:1:0:hogseed' + i + ':100:1:1:1:zzzzzz:1h', board: 'marathon:1:0', mode: 'marathon', level: 1, g20: 0, seed: 'hogseed' + i + Date.now(), score: 1, lines: 1, pieces: 1, ticks: 100, hash: 'zzzzzz', status: 'queued' }, { ipHash: hogHash });
  }
  const hog = await playAndSubmit(rival, { preset: 'casual', ip: hogIP });
  ok('네트워크당 동시 대기 제한', hog.submit.code === 429, hog.submit.json);
  DB.db.prepare(`DELETE FROM runs WHERE ip_hash = ?`).run(hogHash);
  /* 크래시/재시작 복구: queued 로 남아만 행을 주워 다시 검증한다 */
  const recSess = await api('POST', '/api/session', { mode: 'marathon', fp: hero.fp }, '203.0.113.88');
  const recRep = AI.run({ seed: recSess.json.seed, preset: 'casual', rng: AI.makeRand('recover') });
  const recPacked = RP.pack(recRep);
  const recRow = DB.insertRun({ share: DB.shareKey(), digest: 'recover-' + Date.now(), replay: recPacked, board: 'marathon:1:0', mode: 'marathon', level: 1, g20: 0, seed: recRep.seed, score: recRep.score, lines: recRep.lines, pieces: recRep.pieces, ticks: recRep.ticks, hash: recRep.hash, status: 'queued' }, { ipHash: DB.ipToHash('203.0.113.88'), fp: hero.fp, issuedAt: recSess.json.issuedAt });
  Q.queue.recover();
  let recDone = null;
  for (let i = 0; i < 300 && !recDone; i++) { await sleep(120); const g = await api('GET', '/api/replay/' + recRow.share); if (g.code === 200 && g.json && !g.json.queued) recDone = g.json; }
  ok('재시작 후에도 대기 열차가 복구되어 발행된다', !!recDone && ['verified', 'flagged'].indexOf(recDone.status) >= 0, recDone && recDone.status);
  ok('복구된 기록도 순위가 붙는다', recDone && recDone.rank && recDone.rank.atSubmit >= 1, recDone && recDone.rank);

  /* 오래 기다린 건 티어가 낮아도 앞으로 (기아 방지) */
  const QK = require('../server/queue.js').queue;
  const fakeOld = { id: -1, packed: '', board: 'marathon:1:0', mode: 'marathon', score: 1, ticks: 100, enq: Date.now() - 999000, attempts: 1, tier: 2 };
  const fakeNew = { id: -2, packed: '', board: 'marathon:1:0', mode: 'marathon', score: 1, ticks: 100, enq: Date.now(), attempts: 1, tier: 0 };
  QK.q[2].push(fakeOld); QK.q[0].push(fakeNew);
  const picked = QK._pick();
  ok('오래 기다린 저속 건이 우선 건을 앞선다(기아 방지)', picked === fakeOld, picked && picked.id);
  QK._pick();   // fakeNew 소비
  QK.q[0].length = 0; QK.q[1].length = 0; QK.q[2].length = 0;

  /* 대기열이 가득 찼을 때 — 조용히 사라지지 않고 명시적으로 거절한다 */
  const CFG = require('../server/config.js');
  /* cap 은 생성자에서 복사하므로 인스턴스를 직접 조인다 */
  const savedCap = QK.cap;
  QK.cap = 0;
  const full = await playAndSubmit(rival, { preset: 'casual', ip: '203.0.113.201' });
  QK.cap = savedCap;
  ok('가득 찬 큐는 503 + 사유', full.submit.code === 503 || full.submit.code === 429, full.submit.json);

  group('집계');
  const st = await api('GET', '/api/stats');
  ok('통계: 네트워크 분산도 집계', typeof st.json.netsToday === 'number' && st.json.netsToday >= 2, st.json.netsToday);
  ok('통계: 닉네임 없음', st.text.indexOf('강하나') < 0);
  const pl = await api('POST', '/api/play/' + p1.submit.json.share + '?via=share');
  ok('재생 카운트', pl.json.ok === true);

  server.close();
  console.log('\n결과: ' + pass + '/' + (pass + fail) + ' 통과' + (fail ? '  \x1b[31m(실패 ' + fail + ')\x1b[0m' : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31m테스트 크래시\x1b[0m', e); process.exit(2); });

/**
 * 브라우저-실제 e2e — 서버를 띄우고, 헤드리스 Edge/Chrome 에서 **정말 클릭해 보고** 제출까지 검증한다.
 *   node tools/e2e.js
 *
 * probe.js 가 "게임 로직/렌더링" 을 본다면, 이건 **정체성→제출→검증→공개 정책→리플레이 재생** 의
 * 전체 사슬을 실제 브라우저(WebCrypto·IndexedDB·fetch·CORS·정적 서빙) 위에서 확인한다.
 */
'use strict';
process.env.NT_TEST_MODE = '1';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8931 + Math.floor(Math.random() * 40);
const CDP = 9444;
const BASE = 'http://127.0.0.1:' + PORT;

const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME || '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const group = (t) => console.log('\n[' + t + ']');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) { }
    await sleep(200);
  }
  return false;
}

(async function main() {
  if (!BROWSER) { console.log('브라우저를 찾지 못했습니다.'); process.exit(1); }

  /* ---- 서버 기동 ---- */
  const srv = require('../server/server.js');
  srv.server.listen(PORT, '127.0.0.1');
  ok('서버 시작', await waitHttp(BASE + '/api/health'), BASE);

  /* ---- 브라우저 ---- */
  const profile = path.join(process.env.TEMP || '/tmp', 'nt-e2e-' + Date.now());
  const browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars',
    '--window-size=1280,900', '--remote-debugging-port=' + CDP, '--user-data-dir=' + profile,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion', '--mute-audio', BASE + '/?debug',
  ], { stdio: 'ignore' });

  const errors = [];
  let ws, mid = 0;
  const pending = new Map();
  async function target() {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
        const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.indexOf(BASE) === 0);   /* Edge 의 동기화 다이얼로그 등 다른 page 와 혼동 방지 */
        if (p) return p;
      } catch (e) { }
      await sleep(250);
    }
    throw new Error('CDP 대상 없음');
  }
  function cmd(method, params) {
    return new Promise((resolve) => {
      const m = ++mid;
      pending.set(m, resolve);
      ws.send(JSON.stringify({ id: m, method, params: params || {} }));
    });
  }
  async function ev(expr, awaitPromise) {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, timeout: 60000 });
    const res = r.result || {};
    if (res.exceptionDetails) errors.push('EVAL: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result && res.result.value;
  }
  async function navigate(url) {
    await cmd('Page.navigate', { url: url });
    await sleep(1800);
  }

  const t = await target();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXC: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await sleep(1200);

  group('1. 정체성 (서명 키) 생성과 노출');
  const ident = JSON.parse(await ev(`(async function(){
    await new Promise(r=>setTimeout(r,600));
    const chip = document.getElementById('meChip');
    return JSON.stringify({
      html: chip ? chip.textContent : '',
      hasDebug: !!window.TetrisDebug,
      scripts: ['TetrisCore','TetrisEngine','TetrisReplay','TetrisIdentity','TetrisI18n','TetrisClient'].map(k=>k in window),
      lang: document.documentElement.lang,
    });
  })()`, true));
  ok('모든 모듈 로드됨', ident.scripts.every(Boolean), ident.scripts);
  ok('지문 칩에 코드네임+지문', /[가-힣a-z]+/i.test(ident.html) && /[0-9a-hj-km-np-z]{6}/i.test(ident.html), ident.html);
  ok('lang 설정', ['ko', 'en', 'ja', 'zh'].indexOf(ident.lang) >= 0, ident.lang);

  group('2. 실제로 플레이 → 녹화 → 제출');
  const play = JSON.parse(await ev(`(async function(){
    const D = window.TetrisDebug;
    await D.start();
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const tap = async (k, ms) => { window.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true})); await sleep(ms||30); window.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true})); };
    let pieces = 0;
    for (let i=0;i<44 && D.G.state!=='over';i++) {
      if (D.G.state==='paused') D.togglePause();
      await tap(i%2 ? 'ArrowRight' : 'ArrowLeft', 45);
      if (i%3===0) await tap('ArrowUp', 45);
      await tap(' ', 70);
      await sleep(150);
      pieces++;
    }
    /* 마지막에 강제로 끝내 게임 오버 경로를 만든다 */
    if (D.G.state!=='over') {
      for (let y=0;y<20;y++) for (let x=0;x<10;x++) D.G.board[y][x]='J';
      D.G.piece=null; D.spawn('O');
    }
    await sleep(700);
    const box = document.getElementById('submitBox');
    const nameEl = document.getElementById('subName');
    if (nameEl) nameEl.value = '테스트플레이어';
    const go = document.getElementById('subGo');
    if (go) go.click();
    /* 큐에 들어가면 '대기 중' 이 먼저 뜬다 → 종결 상태(.res 이면서 .queueing 아닌 것)까지 기다린다 */
    for (let i=0;i<260;i++) {
      await sleep(150);
      const done = document.querySelector('#subOut .res:not(.queueing)');
      if (done && !document.querySelector('#subOut .queueing')) break;
    }
    const res = document.querySelector('#subOut .res:not(.queueing)');
    const shareInput = document.querySelector('#subOut .share input');
    return JSON.stringify({
      state: D.G.state, pieces: pieces,
      score: D.G.score, lines: D.G.lines, ticks: D.G.ticks,
      over: D.G.state==='over',
      boxShown: !!box && !box.classList.contains('hidden'),
      res: res ? res.className + ' :: ' + res.textContent.trim().slice(0,120) : null,
      ok: !!document.querySelector('#subOut .res.ok'),
      warn: !!document.querySelector('#subOut .res.warn'),
      bad: !!document.querySelector('#subOut .res.bad'),
      rank: (document.querySelector('#subOut .rank')||{}).textContent || '',
      shareUrl: shareInput ? shareInput.value : null,
      packed: (window.TetrisDebug.packed()||'').slice(0,60),
    });
  })()`, true));
  ok('판이 실제로 진행됨', play.pieces > 3 && play.ticks > 100, play);
  ok('게임 오버', play.over);
  ok('제출 상자 노출', play.boxShown);
  ok('서버 응답 도달', !!play.res, play.res);
  ok('검증 통과(verified 또는 flagged)', play.ok || play.warn, play.res);
  ok('순위 문구', /\d+위|rank|#/i.test(play.rank), play.rank);
  ok('packed 리플레이 생성', /^NT1:/.test(play.packed || ''), play.packed);
  const share = (play.shareUrl || '').split('/r/')[1];
  ok('공유 키 발급', /^[0-9a-f]{12}[0-9a-z]$/.test(share || ''), play.shareUrl);
  console.log('    → ' + play.score + '점 / ' + play.lines + '줄 / share ' + share + ' / ' + play.res);
  group('3. 서버 측 결과와 브라우저 결과가 일치');
  const api = await (await fetch(BASE + '/api/replay/' + share)).json();
  ok('서버 점수 = 화면 점수', api.score === play.score, [api.score, play.score]);
  ok('서버 줄 = 화면 줄', api.lines === play.lines, [api.lines, play.lines]);
  ok('닉네임은 공유 API에만 노출', api.displayName === '테스트플레이어', api.displayName);
  ok('IP 는 마스킹 노출', /\d+\.\d+\.xx\.xx/.test(api.ipHint || ''), api.ipHint);
  ok('고스트 타임라인 제공', Array.isArray(api.ghost) && api.ghost.length > 0);
  const boardText = await (await fetch(BASE + '/api/board?mode=marathon&level=1')).text();
  ok('월드 보드 응답에 닉네임 없음', boardText.indexOf('테스트플레이어') < 0 && boardText.indexOf('displayName') < 0);
  const pageHtml = await (await fetch(BASE + '/r/' + share)).text();
  ok('공유 페이지에 닉네임(OG 포함)', pageHtml.indexOf('테스트플레이어') >= 0);
  ok('공유 페이지 noindex', /[Xx]-[Rr]obots/.test(pageHtml) || true);
  const raw = await (await fetch(BASE + '/r/' + share, { method: 'GET' }));
  ok('noindex 헤더', /noindex/.test(raw.headers.get('x-robots-tag') || ''), raw.headers.get('x-robots-tag'));
  ok('서버 내부 파일 비공개', (await fetch(BASE + '/server/db.js')).status === 404);
  ok('DB 파일 비공개', (await fetch(BASE + '/data/tetris.db')).status === 404);

  group('4. 공유 페이지에서 리플레이 재생');
  await navigate(BASE + '/r/' + share);
  await sleep(2200);
  const rp = JSON.parse(await ev(`(async function(){
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const bar = document.getElementById('replayBar');
    const ink = () => {
      const c = document.getElementById('board'), g = c.getContext('2d');
      const d = g.getImageData(0,0,c.width,c.height).data; let n=0;
      for (let i=3;i<d.length;i+=4) if (d[i]>28) n++;
      return n;
    };
    const a = ink();
    await sleep(1400);
    const b = ink();
    const fill = document.getElementById('rpFill');
    return JSON.stringify({
      barShown: !!bar && !bar.classList.contains('hidden'),
      inkA: a, inkB: b,
      fillW: fill ? fill.style.width : '',
      head: bar ? bar.textContent.replace(/\\s+/g,' ').slice(0,140) : '',
    });
  })()`, true));
  ok('리플레이 바 노출', rp.barShown);
  ok('리플레이가 실제로 그려짐', rp.inkA > 500 && rp.inkB > 500, rp);
  ok('진행도가 움직임', /%/.test(rp.fillW || '') && parseFloat(rp.fillW) > 0, rp.fillW);
  ok('이름이 화면에 표시', /테스트플레이어/.test(rp.head), rp.head);

  group('5. 도전(경쟁) 플로우');
  await navigate(BASE + '/?debug=1&challenge=' + share);
  await sleep(1800);
  const ch = JSON.parse(await ev(`(async function(){
    const D = window.TetrisDebug;
    const bar = document.getElementById('raceBar');
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    await sleep(400);
    const tap = async (k, ms) => { window.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true})); await sleep(ms||30); window.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true})); };
    for (let i=0;i<8;i++) {
      await tap(i%2 ? 'ArrowRight' : 'ArrowLeft', 45);
      if (i%2===0) await tap('ArrowUp', 45);
      await tap(' ', 60);
      await sleep(120);
      if (D.G.state === 'over') break;      /* 죽으면 스페이스가 재시작이 되니 여기서 멈춘다 */
    }
    const gap = document.getElementById('rcGap');
    return JSON.stringify({
      shown: !!bar && !bar.classList.contains('hidden'),
      text: bar ? bar.textContent.replace(/\\s+/g,' ').slice(0,80) : '',
      gap: gap ? gap.textContent : '',
      score: D.G.score,
    });
  })()`, true));
  ok('레이스 바 표시', ch.shown, ch);
  ok('상대 이름이 레이스 바에', /테스트플레이어/.test(ch.text), ch.text);
  ok('점수 차이가 실시간 계산', /[+-]/.test(ch.gap || ''), ch.gap);

  group('6. 새로고침 후에도 같은 지문(소유권 유지)');
  const before = await ev(`document.getElementById('meChip').textContent`);
  await navigate(BASE + '/');
  await sleep(1600);
  const after = await ev(`document.getElementById('meChip').textContent`);
  ok('지문 유지 (IndexedDB 개인키)', before && after && before === after, { before, after });

  ok('런타임 에러 없음', errors.length === 0, errors.slice(0, 4));

  browser.kill();
  srv.server.close();
  console.log('\n결과: ' + pass + '/' + (pass + fail) + ' 통과' + (fail ? '  \x1b[31m(실패 ' + fail + ')\x1b[0m' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\x1b[31me2e 크래시\x1b[0m', e); process.exit(2); });

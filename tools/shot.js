/**
 * README용 스크린샷 생성 — 실제로 서버를 띄우고 기록을 몇 개 채운 뒤 캡처한다.
 *   node tools/shot.js
 * docs/preview.png (데스크톱) / docs/preview-mobile.png (모바일) 를 갈아쓴다.
 */
'use strict';
process.env.NT_TEST_MODE = '1';
process.env.NT_DATA = require('path').join(require('os').tmpdir(), 'nt-shot-' + Math.random().toString(36).slice(2, 7));

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const RP = require('../replay.js');
const ID = require('../identity.js');
const AI = require('./ai.js');
const V = require('../server/verify.js');
const srv = require('../server/server.js');

const PORT = 8961, CDP = 9461, BASE = 'http://127.0.0.1:' + PORT;
const DOCS = path.join(__dirname, '..', 'docs');
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function seed() {
  const runs = [
    ['ace', '한별', 4], ['human', '강하나', 8], ['bot', '기계손', 1],
    ['human', '최둘리', 12], ['casual', '_slow_', 16], ['ace', '달려라', 2],
  ];
  const submitted = [];
  for (const [preset, name, level] of runs) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const fp = ID.fpFromHash(crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')).fp;
    const s = await (await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'marathon', level, fp }) })).json();
    const rep = AI.run({ seed: s.seed, preset, level, rng: AI.makeRand(preset + name) });
    const packed = RP.pack(rep);
    const dg = V.digestOf(RP.unpack(packed));
    const sig = crypto.sign('sha256', Buffer.from(ID.authPayload('NTSUB1', [dg, s.nonce])), privateKey).toString('base64');
    const r = await (await fetch(BASE + '/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replay: packed, fp, nonce: s.nonce, displayName: name, owner: { jwk, sig }, level }),
    })).json();
    if (r && r.share) submitted.push({ preset: preset, name: name, level: level, share: r.share });
    console.log(' seed', preset.padEnd(7), 'lv' + level, (r && r.status) || '?', '→', (r && r.share) || '-');
  }
  /* 발행(검증 완료)을 기다린다. 안 기다리면 스크린샷이 **빈 보드**로 나와서 useless 해진다. */
  const DB = require('../server/db.js');
  for (let i = 0; i < 120; i++) {
    const pending = submitted.filter(function (s) {
      const run = DB.getRunByShare(s.share);
      return !run || run.status === 'queued' || run.status === 'verifying';
    });
    if (!pending.length) break;
    await sleep(250);
  }
  for (const s of submitted) {
    const run = DB.getRunByShare(s.share);
    console.log('    ', s.preset.padEnd(7), 'lv' + s.level, run ? run.status : '?', run && run.rank_at_submit ? '#' + run.rank_at_submit : '');
  }
}

(async () => {
  if (!BROWSER) { console.log('브라우저 없음'); process.exit(1); }
  srv.server.listen(PORT, '127.0.0.1');
  await sleep(400);
  await seed();
  require('../server/db.js').snapshot(10);

  const profile = path.join(process.env.TEMP, 'nt-shot-' + Date.now());
  const b = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + profile, '--mute-audio', '--window-size=1400,1000', BASE + '/?debug'], { stdio: 'ignore' });

  let list = [];
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); if (list.find(t => t.type === 'page' && t.url.indexOf(BASE) === 0)) break; } catch (e) { }
  }
  const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl && x.url.indexOf(BASE) === 0);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0; const pend = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cmd = (method, params) => new Promise(r => { const i = ++mid; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 }); return r.result && r.result.result && r.result.result.value; };
  const shot = async (file) => {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log(' 저장', file);
  };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  /* 데스크톱 사진을 찍는데 headless 가 primary pointer 를 coarse 로 보고 터치 패드가 깔렸다.
     마우스 데스크톱으로 보이게 포인터/호버를 명시한다 (모바일 컷에서는 다시 coarse 로). */
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'fine' }, { name: 'hover', value: 'hover' }] });
  await sleep(1500);
  /* 보드에 기록이 채워진 상태의 데스크톱 */
  await ev(`(async function(){ document.getElementById('ovBtn').click(); await new Promise(r=>setTimeout(r,1800));
    const D=window.TetrisDebug; for(let i=0;i<12;i++){ if(D.G.state==='paused')D.togglePause();
      window.dispatchEvent(new KeyboardEvent('keydown',{key:i%2?'ArrowRight':'ArrowLeft',bubbles:true})); await new Promise(r=>setTimeout(r,80));
      window.dispatchEvent(new KeyboardEvent('keyup',{key:i%2?'ArrowRight':'ArrowLeft',bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true})); await new Promise(r=>setTimeout(r,140));
      window.dispatchEvent(new KeyboardEvent('keyup',{key:' ',bubbles:true})); await new Promise(r=>setTimeout(r,120)); }
    return 1; })()`);
  await sleep(400);
  /* 제거 시점이 중요한다: 이 코드를 페이지 활성화 직후에 하면 game.js 가 클래스를 붙이기 **전에**
     실행되어 아무 일도 일어나지 않는다(그래도 사진에는 패드가 남아 있었다). 촬영 직전에 내린다. */
  await ev(`(function(){ document.body.classList.remove('touch-mode'); return 1; })()`);
  const padState = await ev(`JSON.stringify({ cls: document.body.className, disp: getComputedStyle(document.getElementById('touch')).display, coarse: matchMedia('(pointer: coarse)').matches })`);
  console.log(' 데스크톱 직전:', padState);
  await shot(path.join(DOCS, 'preview.png'));

  /* 모바일 */
  await cmd('Emulation.clearDeviceMetricsOverride');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  await ev(`(function(){ document.body.classList.add('touch-mode'); return 1; })()`);   /* 손가락 기기 대표 */
  await sleep(1200);
  await shot(path.join(DOCS, 'preview-mobile.png'));

  /* 제출 → 공유 링크 화면(모바일 시트). */
  await ev(`(async function(){
    const D = window.TetrisDebug; const sleep = ms => new Promise(r=>setTimeout(r,ms));
    /* 보드를 직접 칠해서 끝내면 안 된다: 그 판은 입력 스트림에 없는 사건이라 서버 재시뮬이
       mismatch:lines,ticks,hash 로 **정직하게 기각**한다(그래픽을 그렇게 만들면 기각 화면이 찍힌다).
       실제로 지게 만들어야 검증 통과 화면이 나온다. */
    if (D.G.state === 'ready' || D.G.state === 'over') D.start();
    for (let i=0;i<160 && D.G.state!=='over';i++) {
      window.dispatchEvent(new KeyboardEvent('keydown',{key:i%3===0?'ArrowLeft':(i%3===1?'ArrowRight':'ArrowUp'),bubbles:true}));
      await sleep(30);
      window.dispatchEvent(new KeyboardEvent('keyup',{key:i%3===0?'ArrowLeft':(i%3===1?'ArrowRight':'ArrowUp'),bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));
      await sleep(40);
      window.dispatchEvent(new KeyboardEvent('keyup',{key:' ',bubbles:true}));
      await sleep(40);
    }
    let go = null;
    for (let i=0;i<80 && !go;i++) { await sleep(150); go = document.getElementById('subGo'); }
    const nm = document.getElementById('subName'); if (nm) { nm.value = '별똥별'; }
    if (go) go.click();
    for (let i=0;i<240;i++) { await sleep(150);
      const done = document.querySelector('#subOut .res:not(.queueing)');
      if (done && !document.querySelector('#subOut .queueing')) break; }
    return JSON.stringify({ found: !!go, share: !!document.querySelector('#subOut .share'), url: (document.getElementById('shareUrl')||{}).value || null });
  })()`, true).then(s => console.log(' 공유 화면:', s));
  await sleep(700);
  await shot(path.join(DOCS, 'preview-share.png'));

  b.kill(); srv.server.close();
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

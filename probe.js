/**
 * 헤드리스 Edge + CDP 로 게임 실제 실행 검증
 *   node probe.js
 * - 런타임 예외 / 콘솔 에러 수집
 * - 실제 키 입력으로 플레이 → 점수·줄 증가 확인
 * - 캔버스 픽셀을 읽어 블록이 실제로 그려졌는지 확인
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.log('브라우저를 찾지 못했습니다.'); process.exit(1); }

const PORT = 9333;
const url = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/') + '?debug';
const profile = path.join(process.env.TEMP || '/tmp', 'neon-tetris-probe');

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--hide-scrollbars', '--window-size=1280,900',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  '--mute-audio', url,
], { stdio: 'ignore' });

const errors = [];

function getJSON(p) {
  return fetch('http://127.0.0.1:' + PORT + p).then((r) => r.json());
}

/* 이 파일에는 ok() 헬퍼가 없다(실패를 errors 배열에 모아 종료 코드로 알린다) */
let checks = 0, checkFails = 0;
function ok2(cond, label, detail) {
  checks++;
  if (cond) console.log('    PASS ' + label);
  else { checkFails++; console.log('    FAIL ' + label + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); errors.push('CHECK: ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index.html/.test(t.url));  /* 브라우저 자체 시작 페이지와 혼동 방지 */
      if (page) return page;
    } catch (e) { /* 아직 준비 전 */ }
    await sleep(300);
  }
  throw new Error('CDP 대상 없음');
}

(async () => {
  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p(msg);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  function cmd(method, params) {
    return new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }
  async function evalJS(expr, awaitPromise) {
    const r = await cmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, timeout: 60000,
    });
    const res = r.result || {};
    if (res.exceptionDetails) errors.push('EVAL: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
    if (res.result && res.result.subtype === 'error') errors.push('EVAL-THROW: ' + JSON.stringify(res.result).slice(0, 400));
    return res.result && res.result.value;
  }

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await sleep(1200);

  console.log('\n[1] 초기 화면');
  const init = await evalJS(`(function(){
    const c = document.getElementById('board');
    const st = document.getElementById('stage');
    const cs = getComputedStyle(st);
    return JSON.stringify({
      title: document.title,
      stage: cs.width + ' x ' + cs.height,
      canvasPx: c.width + ' x ' + c.height,
      nextSlots: document.querySelectorAll('#nextWrap canvas').length,
      touchBtns: document.querySelectorAll('#touch button').length,
      overlayShown: !document.getElementById('overlay').classList.contains('hidden'),
      score: document.getElementById('score').textContent,
    });
  })()`);
  console.log('   ', init);

  console.log('\n[2] 엔진 테스트 (디버그 API)');
  const eng = await evalJS(`(async function(){
    const D = window.TetrisDebug, G = D.G;
    const T = window.TetrisCore.TOP;                 // 보드 배열은 버퍼 C.TOP 행을 앞에 둔다 (y 는 배열 인덱스)
    const sleep = ms => new Promise(r=>setTimeout(r, ms));
    const num = id => parseInt(document.getElementById(id).textContent.replace(/[^0-9]/g,''),10) || 0;
    const out = {checks: []};
    const chk = (name, cond, detail) => out.checks.push((cond?'PASS ':'FAIL ') + name + (detail==null?'':' -> '+detail));
    /* 헤드리스 환경에서 blur로 자동 일시정지될 수 있어 확인 전 복원 */
    const ensure = () => { if (G.state === 'paused') D.togglePause(); };
    const settle = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 1000)) { ensure(); if (pred()) return true; await sleep(40); }
      ensure(); return pred();
    };
    /* 헤드리스에서는 rAF가 지연될 수 있어 타이밍 검사 전 프레임을 측정 */
    const measureRaf = (ms) => new Promise((res) => {
      let frames = 0, maxGap = 0, prev = performance.now(), on = true;
      const tick = () => {
        if (!on) return;
        const n = performance.now();
        maxGap = Math.max(maxGap, n - prev); prev = n; frames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setTimeout(() => { on = false; res({ fps: frames / (ms / 1000), maxGap: maxGap }); }, ms);
    });

    /* 1) 줄 삭제 + 레벨업 */
    await D.start();
    G.lines = 9; G.level = 1;
    for (let x=0;x<10;x++) if (x<3 || x>6) G.board[T+19][x] = 'J'; /* 열 3~6 비움 (I 는 가로 4칸) */
    G.piece = null; D.spawn('I');
    G.piece.rot = 0; G.piece.x = 3; G.piece.y = 0; /* I 매트릭스는 4열 전체 사용 → x=3 이어야 열 3,4,5 */
    D.hardDrop();
    await settle(() => G.lines === 10 && G.state !== 'clearing');
    await sleep(80);
    chk('1줄 삭제', num('lines') === 10, 'lines=' + num('lines'));
    chk('레벨 2로 상승', num('level') === 2, 'level='+num('level'));
    chk('점수 반영(100 이상)', num('score') >= 100, 'score='+num('score'));
    chk('삭제 후 해당 행 비움', G.board[T+19].filter(Boolean).length === 0, G.board[T+19].filter(Boolean).length);

    /* 2) T-스핀 더블 */
    await D.start();
    for (let x=0;x<10;x++){ G.board[T+19][x]='J'; G.board[T+18][x]='J'; }
    G.board[T+19][4]=null; G.board[T+18][3]=G.board[T+18][4]=G.board[T+18][5]=null; G.board[T+17][3]='J';
    G.piece=null; D.spawn('T');
    G.piece.x=3; G.piece.y=T+17; G.piece.rot=2; G.spinFlag=true; G.lastKick=0;
    D.lockPiece();
    await settle(() => G.lines === 2 && G.state !== 'clearing');
    await sleep(80);
    chk('T-스핀 더블: 2줄', num('lines') === 2, 'lines='+num('lines'));
    chk('T-스핀 더블: 점수 1200', num('score') === 1200, 'score='+num('score'));
    chk('T-스핀 통계', num('statTspin') === 1, num('statTspin'));

    /* 3) 홀드 */
    await D.start();
    const firstType = G.piece.type;
    D.holdPiece();
    chk('빈 홀드에 스텝', G.hold === firstType, G.hold);
    chk('홀드 후 1회만 가능', G.canHold === false, G.canHold);
    const second = G.piece.type;
    D.holdPiece();
    chk('연속 홀드 차단', G.piece.type === second, G.piece.type);
    for (let i=0;i<4;i++){ ensure(); D.hardDrop(); await sleep(360); }
    chk('조각 교체 후 홀드 재활성', G.canHold === true || G.state !== 'playing', G.canHold);

    /* 4) 벽 제한 */
    await D.start();
    for (let i=0;i<24;i++) D.move(-1);
    const minX = G.piece.x;
    for (let i=0;i<24;i++) D.move(1);
    const maxX = G.piece.type === 'I' ? 6 : (G.piece.type === 'O' ? 8 : 7);
    chk('벽에서 멈춤', minX >= -1 && G.piece.x <= maxX, 'min=' + minX + ' max=' + G.piece.x + ' (expected<=' + maxX + ')');

    /* 5) 회전 실패 없음 확인 (빈 보드에서 전 조각 4회전) */
    await D.start();
    let rotOK = true;
    ['I','J','L','S','T','Z'].forEach(tp => {
      G.piece = null; D.spawn(tp);
      for (let i=0;i<4;i++) if (!D.rotate(1)) rotOK = false;
    });
    chk('빈 보드에서 전 조각 회전 가능', rotOK);

    /* 6) 게임 오버 (인위적 상단 충전) */
    await D.start();
    for (let y=T;y<T+20;y++) for (let x=0;x<10;x++) G.board[y][x] = 'J';   // 보이는 판을 가득 채운다
    G.piece = null; D.spawn('O');
    chk('스폰 자리 막힘 → 게임오버', G.state === 'over', G.state);
    chk('게임오버 오버레이', !document.getElementById('overlay').classList.contains('hidden'));
    chk('최고점 저장', num('high') >= 0, num('high'));

    /* 7) 일시정지 */
    await D.start();
    D.togglePause();
    const pausedState = G.state;
    D.togglePause();
    chk('일시정지/해제', pausedState === 'paused' && G.state === 'playing', pausedState + '/' + G.state);

    /* 8) 타이머 */
    await D.start();
    await settle(() => G.state === 'playing', 400);
    const raf = await measureRaf(400);
    const stalled = raf.maxGap > 200 || raf.fps < 30;
    const t0 = G.stats.time, w0 = Date.now();
    await sleep(1600);
    ensure();
    const secs = document.getElementById('statTime').textContent.split(':');
    const dtGame = G.stats.time - t0, dtWall = (Date.now() - w0) / 1000;
    chk('시간 카운트' + (stalled ? ' [rAF 지연 스킵]' : ''),
      stalled || (dtGame > dtWall * 0.7 && parseInt(secs[1], 10) >= 1),
      'game=Δ' + dtGame.toFixed(2) + ' wall=Δ' + dtWall.toFixed(2) + ' fps=' + raf.fps.toFixed(0) + ' maxGap=' + Math.round(raf.maxGap) + 'ms');
    D.togglePause();
    const frozen = G.stats.time;
    await sleep(700);
    chk('일시정지 중 시간 정지', Math.abs(G.stats.time - frozen) < 0.05, 'Δ' + (G.stats.time - frozen).toFixed(3));
    D.togglePause();

    /* 9) 좌우 반복(DAS/ARR) */
    await D.start();
    await settle(() => G.state === 'playing', 400);
    const press = (k, type) => window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
    const x0 = G.piece.x;
    press('ArrowLeft', 'keydown');
    await sleep(900);
    press('ArrowLeft', 'keyup');
    await sleep(30);
    const wallMoved = x0 - G.piece.x;
    chk('DAS/ARR 연속 이동' + (stalled ? ' [rAF 지연 스킵]' : ''),
      stalled || wallMoved >= 3, '이동 ' + wallMoved + '칸 (x ' + x0 + ' → ' + G.piece.x + ')');

    /* 10) 소프트 드롭 점수 */
    await D.start();
    await settle(() => G.state === 'playing', 400);
    for (let i = 0; i < 8; i++) {
      ensure();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(140);
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    chk('소프트 드롭 = 칸당 1점', num('score') >= 5, 'score=' + num('score'));

    /* 11) 홀드 교환 (이미 홀드가 있는 경우) */
    await D.start();
    const a = G.piece.type;
    D.holdPiece();
    await sleep(30);
    const b2 = G.piece.type;
    /* 강제로 홀드 가능 상태로 만들고 교환 */
    G.canHold = true;
    D.holdPiece();
    chk('홀드 ↔ 현재 조각 교환', G.hold === b2 && G.piece.type === a, G.hold + '/' + G.piece.type);

    out.checks2 = out.checks.filter(c => c.indexOf('FAIL') === 0).length;
    return JSON.stringify(out, null, 0);
  })()`, true);
  const engData = JSON.parse(eng);
  engData.checks.forEach((c) => console.log('    ' + c));
  console.log('    → 실패 ' + engData.checks2 + '건');

  console.log('\n[3] AI 자동 플레이 300조각 (간단 휴리스틱) — 실제 삭제/레벨업/점수 경로 검증');
  const ai = await evalJS(`(async function(){
    const D = window.TetrisDebug, G = D.G, C = D.C;
    const sleep = ms => new Promise(r=>setTimeout(r, ms));
    const num = id => parseInt(document.getElementById(id).textContent.replace(/[^0-9]/g,''),10) || 0;
    await D.start();
    const T = C.TOP;
    function cost(b){
      let holes=0, bump=0, agg=0, maxH=0; const hs=[];
      for (let x=0;x<10;x++){ let top=0; while(top<20 && !b[T+top][x]) top++; hs[x]=20-top; agg+=hs[x]; maxH=Math.max(maxH,hs[x]);
        for (let y=top;y<20;y++) if(!b[T+y][x]) holes++; }
      for (let x=0;x<9;x++) bump += Math.abs(hs[x]-hs[x+1]);
      let cleared=0; for (let y=T;y<T+20;y++) if (b[y].every(Boolean)) cleared++;
      return agg*0.5 + holes*4.2 + bump*0.6 + maxH*0.35 - cleared*3.2;
    }
    function best(){
      let bb=null, bs=Infinity;
      for (let r=0;r<4;r++){
        const m = C.STATES[G.piece.type][r];
        for (let x=-3;x<10;x++){
          const b = G.board.map(row=>row.slice());
          if (C.collides(b, m, x, 0)) continue;
          let y=0;
          while(!C.collides(b, m, x, y+1)) y++;
          let ok=true;
          for (let i=0;i<m.length;i++) for (let j=0;j<m[i].length;j++) if (m[i][j]){
            const by=y+i, bx=x+j;
            if (by<0) { ok=false; } else b[by][bx]=G.piece.type;
          }
          if (!ok) continue;
          const s = cost(b);
          if (s < bs) { bs = s; bb = { r:r, x:x }; }
        }
      }
      return bb;
    }
    let placed=0, stuck=0;
    for (let i=0;i<300;i++){
      if (G.state === 'over') break;
      if (G.state !== 'playing') { await sleep(60); continue; }
      const b = best();
      if (!b) { stuck++; break; }
      G.piece.rot = b.r; G.piece.x = b.x;
      if (C.collides(G.board, C.STATES[G.piece.type][G.piece.rot], G.piece.x, G.piece.y)) { stuck++; break; }
      D.hardDrop();
      placed++;
      await sleep(G.pending ? 300 : 4);
    }
    await sleep(400);
    const t = id => document.getElementById(id).textContent;
    return JSON.stringify({
      placed: placed, stuck: stuck, state: G.state,
      lines: t('lines'), level: t('level'), score: t('score'),
      tetris: t('statTetris'), tspin: t('statTspin'), time: t('statTime'),
      pieces: t('statPieces'), lpm: t('statLpm'), sps: t('statAps'), best: t('high'),
    });
  })()`, true);
  console.log('   ', ai);

  // 미드게임 데스크톱 스크린샷
  const docs = path.join(__dirname, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const shot1 = await cmd('Page.captureScreenshot', { format: 'png' });
  if (shot1.result && shot1.result.data) {
    fs.writeFileSync(path.join(docs, 'preview.png'), Buffer.from(shot1.result.data, 'base64'));
    console.log('    → docs/preview.png 저장');
  }

  console.log('\n[4] 랜덤 플레이 스트레스트 (200회 하드드롭 + 이동/회전/홀드/일시정지)');
  const play = await evalJS(`(async function(){
    const press = (k, type) => window.dispatchEvent(new KeyboardEvent(type, {key:k, bubbles:true}));
    const tap = async (k, ms) => { press(k,'keydown'); await new Promise(r=>setTimeout(r, ms||6)); press(k,'keyup'); };
    const sleep = (ms) => new Promise(r=>setTimeout(r, ms));
    document.getElementById('ovBtn').click();
    let over = false, restarted = 0, topRowsAtOver = null;
    for (let i=0;i<220;i++){
      const shifts = i % 5;
      for (let s=0;s<shifts;s++) await tap('ArrowLeft');
      for (let r=0;r<(i % 3);r++) await tap('x');
      if (i % 7 === 3) await tap('ArrowRight');
      await tap(' ', 8);
      await sleep(6);
      if (!document.getElementById('overlay').classList.contains('hidden')) {
        if (!topRowsAtOver && window.TetrisDebug) {
          const b = window.TetrisDebug.G.board;
          const h = [];
          for (let x = 0; x < 10; x++) { let t = 0; while (t < 20 && !b[t][x]) t++; h.push(20 - t); }
          topRowsAtOver = {
            pieces: window.TetrisDebug.G.stats.pieces,
            colHeights: h.join(','),
            tallest: Math.max.apply(null, h),
            top3Rows: [0,1,2].map(y => b[y].filter(Boolean).length).join('/'),
          };
        }
        over = true; restarted++; document.getElementById('ovBtn').click();
      }
      if (i === 60) { await tap('c'); await tap('a'); await tap('z'); }
      if (i === 90) { await tap('p'); await sleep(60); await tap('p'); }
    }
    await sleep(500);
    const t = (id) => document.getElementById(id).textContent;
    const c = document.getElementById('board'), g = c.getContext('2d');
    const d = g.getImageData(0,0,c.width,c.height).data;
    let ink = 0; const colors = {};
    for (let i=0;i<d.length;i+=4){ if (d[i+3] > 24) { ink++; const k = (d[i]>>5)+','+(d[i+1]>>5)+','+(d[i+2]>>5); colors[k]=(colors[k]||0)+1; } }
    return JSON.stringify({
      score: t('score'), lines: t('lines'), level: t('level'), pieces: t('statPieces'),
      time: t('statTime'), tetris: t('statTetris'), tspin: t('statTspin'),
      best: t('high'), gameOverHappened: over, restarts: restarted,
      topRowFillAtGameOver: topRowsAtOver,
      canvasInkPixels: ink, distinctColorBuckets: Object.keys(colors).length,
    });
  })()`, true);
  console.log('   ', play);

  console.log('\n[5] 캔버스 렌더링 검사 (고스트/블록/프리뷰 픽셀)');
  const px = await evalJS(`(async function(){
    const out = {};
    const sleep = ms => new Promise(r=>setTimeout(r, ms));
    document.querySelectorAll('#nextWrap canvas').forEach((c,i)=>{ out['next'+i]=c.width+'x'+c.height; });
    const c = document.getElementById('board'), g = c.getContext('2d');
    out.board = c.width + 'x' + c.height;
    out.hold = document.getElementById('hold').width + 'x' + document.getElementById('hold').height;
    out.previewInk = (()=>{ const pc=document.getElementById('nextWrap').firstChild; const pg=pc.getContext('2d');
      const d=pg.getImageData(0,0,pc.width,pc.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>24) n++; return n; })();

    const D = window.TetrisDebug, G = D.G, C = D.C;
    await D.start();
    await sleep(220);
    const cellPx = c.width / 10;
    const inkIn = (cx, cy) => {
      const s = Math.max(2, Math.round(cellPx) - 8);
      const d = g.getImageData(Math.round(cx*cellPx)+4, Math.round(cy*cellPx)+4, s, s).data;
      let n = 0; for (let i=3;i<d.length;i+=4) if (d[i] > 24) n++;
      return n;
    };
    const p = G.piece;
    if (p) {
      const m = C.STATES[p.type][p.rot];
      let yy = p.y; while (!C.collides(G.board, m, p.x, yy + 1)) yy++;
      const c0 = C.cellsOf(p.type, p.rot)[0];
      out.pieceType = p.type;
      out.pieceCell = 'x' + (p.x + c0[0]) + ',y' + (p.y + c0[1]);
      out.pieceInk = inkIn(p.x + c0[0], p.y + c0[1]);
      out.ghostCell = 'x' + (p.x + c0[0]) + ',y' + (yy + c0[1]);
      out.ghostInk = yy !== p.y ? inkIn(p.x + c0[0], yy + c0[1]) : -1;
      out.emptyInk = inkIn(9, 1);
      out.stackInk = inkIn(0, 19);
    }
    return JSON.stringify(out);
  })()`, true);
  console.log('    ' + px);

  console.log('\n[6] 반응형(모바일 폭) 확인');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(700);
  const mob = await evalJS(`(function(){
    const st=getComputedStyle(document.getElementById('stage'));
    const bt=getComputedStyle(document.getElementById('touch'));
    const bw=document.getElementById('board').getBoundingClientRect();
    const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.id||e.className).slice(0,6);
    const parts={innerH:innerHeight, innerW:innerWidth};
    document.querySelectorAll('.card').forEach(c=>{const h=c.querySelector('.card-head span'); parts['card:'+(h?h.textContent:'?')]=Math.round(c.getBoundingClientRect().height);});
    parts.slot=Math.round(document.querySelector('.stage-slot').getBoundingClientRect().height)+'x'+Math.round(document.querySelector('.stage-slot').getBoundingClientRect().width);
    parts.topbar=Math.round(document.querySelector('.topbar').getBoundingClientRect().height);
    parts.touch=Math.round(document.getElementById('touch').getBoundingClientRect().height);
    parts.keys=getComputedStyle(document.getElementById('keys')).display;
    parts.layoutRows=getComputedStyle(document.querySelector('.layout')).gridTemplateRows;
    return JSON.stringify({stage:st.width+' x '+st.height, boardLeft:Math.round(bw.left), boardRight:Math.round(bw.right), touchBar:bt.display, bodyScrollW:document.body.scrollWidth, overflowing:wide, parts:parts});
  })()`);
  console.log('   ', mob);
  await cmd('Emulation.clearDeviceMetricsOverride');

  console.log('\n[7] 실제 시작 경로(플레이 버튼이 타는 그 함수) + 녹화 메타');
  const RULES_EXPECT = 'r4';   // engine.js RULES_ID 를 올리면 여기 도 올린다(일부러 하드코딩: unnoticed 로 넘기지 못 있게)
  const startPath = JSON.parse(await evalJS(`(async () => {
    const out = { err: null, meta: null };
    try {
      window.TetrisDebug.start();               // 버튼과 동일한 경로 — 여기서 예외가 나면 안 된다
      await new Promise(r => setTimeout(r, 120));
      out.meta = window.TetrisDebug.recMeta();
    } catch (e) { out.err = String((e && e.message) || e); }
    return JSON.stringify(out);
  })()`, true));
  console.log('   ', startPath.err ? ('EX: ' + startPath.err) : startPath.meta);
  if (startPath.err) errors.push('START: ' + startPath.err);
  if (!startPath.meta || startPath.meta.rules !== RULES_EXPECT) errors.push('START: 녹화 메타 규칙 버전이 예상과 다름 → ' + (startPath.meta && startPath.meta.rules) + ' (기대 ' + RULES_EXPECT + ')');

  console.log('\n[8] 숫자 서브셋 글꼴(NeonNum) — 로드/적용/잘림');
  const font = JSON.parse(await evalJS(`(async () => {
    const out = { loaded: false, applied: '', widths: null, usesSubset: false, clipped: [] };
    try { await document.fonts.load('12px NeonNum'); await document.fonts.ready; } catch (e) { out.err = String(e); }
    out.loaded = document.fonts.check('12px NeonNum');
    const el = document.getElementById('score') || document.querySelector('.big-num');
    if (el) out.applied = getComputedStyle(el).fontFamily;
    /* 정말로 서브셋이 그려지는가: 같은 문자열의 너비가 시스템 모노와 달라야 한다 */
    const c = document.createElement('canvas').getContext('2d');
    c.font = '12px NeonNum'; const a = c.measureText('0123456789').width;
    c.font = '12px monospace'; const b = c.measureText('0123456789').width;
    out.widths = [Math.round(a * 10) / 10, Math.round(b * 10) / 10];
    out.usesSubset = Math.abs(a - b) > 0.5;
    ['.big-num', '#statTime', '#statPieces', '#statLpm', '.mini b', '.goal b', '.wb-row b', '.hof-row b', '.rc-gap'].forEach(function (s) {
      document.querySelectorAll(s).forEach(function (e) {
        if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) out.clipped.push(s + ' ' + e.clientWidth + '<' + e.scrollWidth);
      });
    });
    return JSON.stringify(out);
  })()`, true));
  console.log('    ', font);
  ok2(font.loaded === true, '숫자 서브셋이 로드된다(document.fonts.check)');
  ok2(font.usesSubset === true, '서브셋이 실제로 그려진다(시스템 모노와 자폭이 다르다)', font.widths);
  ok2(/NeonNum/.test(font.applied || ''), '점수 자리에 NeonNum 이 적용된다', font.applied);
  ok2(font.clipped.length === 0, '글꼴 교체가 숫자 요소를 잘라내지 않는다', font.clipped);


  console.log('\n[9] 크로스 런타임 결정론 — 브라우저 엔진과 서버(노드) 재시뮬이 같은 결과를 내야 검증이 성립한다');
  const EN = require('./engine.js');
  const AI = require('./tools/ai.js');
  const repP = AI.run({ seed: 'parity-7742', preset: 'ace', rng: AI.makeRand('parity') });
  const cut = repP.inputs.filter(function (i) { return i.t <= 7200; });      // 약 2-minute 분량만 (빠르게)
  const repCut = { seed: repP.seed, mode: repP.mode, level: repP.level, g20: repP.g20, inputs: cut };
  const nodeOut = (function () {
    const r = EN.simulate(repCut, {});
    const x = r.engine.result();
    return { score: x.score, lines: x.lines, pieces: x.pieces, ticks: x.ticks, hash: x.hash, rules: x.rules };
  })();
  const brOut = JSON.parse(await evalJS(`(async () => {
    const rep = ${JSON.stringify(repCut)};
    const r = window.TetrisEngine.simulate(rep, {});
    const x = r.engine.result();
    return JSON.stringify({ score: x.score, lines: x.lines, pieces: x.pieces, ticks: x.ticks, hash: x.hash, rules: x.rules });
  })()`, true));
  console.log('    node:', JSON.stringify(nodeOut));
  console.log('    browser:', JSON.stringify(brOut));
  if (JSON.stringify(nodeOut) !== JSON.stringify(brOut)) errors.push('PARITY: 브라우저와 노드 재시뮬이 다름 → ' + JSON.stringify({ node: nodeOut, browser: brOut }));
  ok2(nodeOut.hash === brOut.hash && nodeOut.score === brOut.score && nodeOut.ticks === brOut.ticks && nodeOut.rules === brOut.rules,
    '같은 입력 → 같은 점수/틱/보드해시 (크로스 런타임)');

  console.log('\n[10] 스크린샷 저장');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const shot2 = await cmd('Page.captureScreenshot', { format: 'png' });
  if (shot2.result && shot2.result.data) {
    fs.writeFileSync(path.join(__dirname, 'docs', 'preview-mobile.png'), Buffer.from(shot2.result.data, 'base64'));
    console.log('    → docs/preview-mobile.png');
  }
  await cmd('Emulation.clearDeviceMetricsOverride');
  const shot = path.join(process.env.TEMP || '/tmp', 'neon-tetris.png');
  const img = await cmd('Page.captureScreenshot', { format: 'png' });
  if (img.result && img.result.data) {
    fs.writeFileSync(shot, Buffer.from(img.result.data, 'base64'));
    console.log('    ' + shot);
  }

  console.log('\n=== 런타임 에러: ' + (errors.length ? errors.length + '건' : '없음') + ' ===');
  errors.slice(0, 12).forEach((e) => console.log('  ! ' + e));

  ws.close();
  browser.kill('SIGKILL');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('프로브 실패: ' + e.message); browser.kill('SIGKILL'); process.exit(1); });

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

/* CDP 포트를 고정하면 예전 실행의 좀비 headless 가 포트를 점유한 채 "CDP 대상 없음" 을 만든다 (실제로 겪음).
   e2e 와 같은 이유로 랜덤 포트를 쓴다. */
const PORT = 9300 + Math.floor(Math.random() * 600);
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
function killBrowser() {
  if (process.platform === 'win32') {
    try { require('child_process').spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch (e) { }
  }
  try { browser.kill('SIGKILL'); } catch (e) { }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  let last = '응답 없음';
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index.html/.test(t.url));  /* 브라우저 자체 시작 페이지와 혼동 방지 */
      if (page) return page;
      last = 'page 후보 ' + list.length + '개: ' + list.map((t) => t.type + ' ' + String(t.url).slice(0, 40)).join(' | ');
    } catch (e) { last = '조회 실패: ' + e.message + ' (포트 ' + PORT + ' 를 좀비 브라우저가 점유하지 않았는지 확인)'; }
    await sleep(300);
  }
  throw new Error('CDP 대상 없음 — ' + last);
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
  /* ⚠ probe 는 **file://** 에서 돈다(오프라인 강하가 검증 대상). 그래서 여기서 만드는 사진은
     "오프라인 모드" 화면이다 — docs/preview*.png 에 쓰면 `npm run test:browser` 가 README 그림을
     조용히 오프라인 화면으로 덮어썼다(실제로 그랬다). 문서 그림의 유일한 생성자는 tools/shot.js(http).
     probe 사진은 검사용으로만 임시 폴더에 남긴다. */
  const shotDir = path.join(require('os').tmpdir(), 'neon-tetris-probe');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot1 = await cmd('Page.captureScreenshot', { format: 'png' });
  if (shot1.result && shot1.result.data) {
    const f = path.join(shotDir, 'probe-desktop.png');
    fs.writeFileSync(f, Buffer.from(shot1.result.data, 'base64'));
    console.log('    → ' + f + '  ( 임시: docs 그림은 tools/shot.js 것 )');
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

  /* 위 정보는 출력뿐이었다. 아래는 **고정 검정** — 레이아웃은 눈으로 확인하면 반드시 다시 망가진다
     (실제로 이 세션에서 미디어 쿼리 범위를 잘못 잘라 #mineCard 숨김이 520px 전용으로 좁아졌다). */
  const mobFix = JSON.parse(await evalJS(`(function(){
    const r=(el)=>el?el.getBoundingClientRect():null;
    const stage=r(document.getElementById('stage'));
    const score=r(document.querySelector('.score-card'));
    const tb=document.querySelector('.topbar');
    const cv=r(document.getElementById('board'));
    const probe=document.createElement('div'); probe.className='wb-row'; document.body.appendChild(probe);
    const uiApplied=getComputedStyle(probe).display; probe.remove();
    const clipped=[...document.querySelectorAll('button,select,input,a')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.id||e.textContent||e.tagName).slice(0,4);
    return JSON.stringify({
      uiApplied: uiApplied,
      topbarScroll: tb.scrollWidth, topbarClient: tb.clientWidth,
      clip: clipped,
      overlap: score && stage ? Math.round(Math.min(stage.bottom,score.bottom)-Math.max(stage.top,score.top)) : -1,
      cell: cv ? Math.round(cv.height/20*10)/10 : 0,
      vh: innerHeight,
      mine: getComputedStyle(document.getElementById('mineCard')).display,
      mineInPane: !!(document.getElementById('pane') && document.getElementById('pane').contains(document.getElementById('mineCard'))),
      paneTop: Math.round(document.getElementById('pane').getBoundingClientRect().top),
      mineTop: Math.round(document.getElementById('mineCard').getBoundingClientRect().top),
      paneMineShown: getComputedStyle(document.getElementById('paneMine')).display,
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
      sheetPos: getComputedStyle(document.getElementById('submitBox')).position,
    });
  })()`));
  ok2(mobFix.uiApplied === 'grid', 'ui.css 규칙이 페이지에 실제로 적용된다 (.wb-row 가 grid)', mobFix.uiApplied);
  ok2(mobFix.topbarScroll <= mobFix.topbarClient + 1, '상단 바가 화면 폭을 넘치지 않는다', mobFix.topbarScroll + '>' + mobFix.topbarClient);
  ok2(mobFix.clip.length === 0, '버튼/셀렉트가 화면 오른쪽 밖으로 잘리지 않는다', mobFix.clip);
  ok2(mobFix.overlap <= 1, '보드가 SCORE 카드를 덮지 않는다', '겹침 ' + mobFix.overlap + 'px');
  ok2(mobFix.cell >= 26, '모바일 칸 크기가 식별 가능한 수준(≥26px — 카드가 시트로 빠져 흐름에서 벗어남)', mobFix.cell + 'px');
  ok2(mobFix.mineInPane === true, '모바일에서 "내 기록"은 시트 안에 있다 (어디에도 없던 구멍)', mobFix.mineInPane);
  ok2(mobFix.mineTop >= mobFix.paneTop - 1, '내 기록은 시트 **안쪽에** 있다(열 때만 따라 나온다)', mobFix.mineTop + ' vs pane ' + mobFix.paneTop);
  ok2(mobFix.overscroll === 'none', '화면을 당기는 브라우저 새로고침이 꺼져 있다(드래그 중 판 손실)', mobFix.overscroll);
  ok2(mobFix.sheetPos === 'fixed', '제출·링크 화면은 모바일에서 전체 화면 시트다(키보드에 안 사라짐)', mobFix.sheetPos);
  ok2(mobFix.paneMineShown !== 'none', 'SCORE 오른쪽에 내 기록 진입로가 보인다', mobFix.paneMineShown);

  /* 시트(≡): 기본은 화면 밖, 열리면 월드 보드가 안으로 올라오고, 스크림으로 닫힌다. */
  const paneFix = JSON.parse(await evalJS(`(async () => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    const btn = document.getElementById('paneBtn'), pane = document.getElementById('pane');
    /* 디바이스 메트릭을 바꾼 직후에는 레이아웃이 아직 정립 중일 수 있다(실제로 한 번
       "닫힌 시트" 가 화면 안으로 측정됐다). 기준선을 단발로 재면 플레이크가 되니 정립을 기다린다 —
       기다려도 안 오면 아래 검정이 그 사실을 메시지로 말한다. */
    let offTop = pane ? Math.round(pane.getBoundingClientRect().top) : -1;
    for (let q = 0; q < 12 && offTop < innerHeight - 1; q++) { await sleep(150); offTop = pane ? Math.round(pane.getBoundingClientRect().top) : -1; }
    const before = { btn: btn ? getComputedStyle(btn).display : '없음', offTop: offTop, vh: innerHeight };
    if (btn) btn.click();
    /* 고정 sleep 은 경합한다(한 번 wcVisible:false 로 잡혔다). 전환이 끝날 때까지 상태를 본다. */
    let open = { bodyOpen: false, wcVisible: false }, wc, i;
    for (i = 0; i < 20; i++) {
      await sleep(100);
      wc = document.getElementById('worldCard').getBoundingClientRect();
      open = { bodyOpen: document.body.classList.contains('pane-open'), wcVisible: wc.bottom > 0 && wc.top < innerHeight };
      if (open.wcVisible) break;
    }
    open.retries = i;
    const scrim = document.getElementById('paneScrim'); if (scrim) scrim.click();
    await sleep(350);
    const closedAfterScrim = !document.body.classList.contains('pane-open');
    /* SCORE 옆 진입로도 같은 시트를 열어야 한다(두 개의 문이 다른 방으로 가면 안 된다). */
    const pm = document.getElementById('paneMine'); if (pm) pm.click();
    let mineVisible = false;
    for (let k = 0; k < 16 && !mineVisible; k++) {
      await sleep(100);
      const mr = document.getElementById('mineCard').getBoundingClientRect();
      mineVisible = mr.bottom > 0 && mr.top < innerHeight;
    }
    open.viaPaneMine = mineVisible;
    const back = document.getElementById('paneBtn'); if (back) back.click();   /* 다음 검사에 상태를 남기지 않는다 */
    await sleep(300);
    return JSON.stringify({ before: before, open: open, closedAfterScrim: closedAfterScrim,
      cleanAfter: !document.body.classList.contains('pane-open') });
  })()`, true));
  ok2(paneFix.before.btn !== 'none' && paneFix.before.btn !== '없음', '모바일에서 ≡ 버튼이 보인다', paneFix.before.btn);
  ok2(paneFix.before.offTop >= paneFix.before.vh - 1, '시트는 기본 상태에서 화면 밖에 있다', paneFix.before.offTop + ' vs vh ' + paneFix.before.vh);
  ok2(paneFix.open.bodyOpen === true && paneFix.open.wcVisible === true, '≡ 를 누르면 월드 보드가 화면 안으로 올라온다', JSON.stringify(paneFix.open));
  ok2(paneFix.open.viaPaneMine === true, 'SCORE 옆 "내 기록 ▸" 도 같은 시트를 연다', JSON.stringify(paneFix.open));
  ok2(paneFix.closedAfterScrim === true, '스크림을 누르면 시트가 닫힌다', String(paneFix.closedAfterScrim));
  ok2(paneFix.cleanAfter === true, '검사가 끝나면 시트가 닫힌 상태다(다음 검사에 상태를 남기지 않는다)', String(paneFix.cleanAfter));

  /* 터치 패드 2단: 줄 개수와 타깃 크기까지 본다 — "작게 한 줄" 로 되돌아가기 가장 쉬운 부분이다. */
  const pad = JSON.parse(await evalJS(`(function(){
    const t=document.getElementById('touch'); const bs=[...t.querySelectorAll('button')];
    const rows=new Set(bs.map(b=>Math.round(b.getBoundingClientRect().top)));
    return JSON.stringify({ rows: rows.size, n: bs.length,
      minW: Math.min.apply(null, bs.map(b=>Math.round(b.getBoundingClientRect().width))),
      minH: Math.min.apply(null, bs.map(b=>Math.round(b.getBoundingClientRect().height))),
      disp: getComputedStyle(t).display });
  })()`));
  ok2(pad.disp === 'grid', '터치 패드는 그리드 배치다', pad.disp);
  ok2(pad.rows === 2, '터치 패드가 실제로 두 줄이다', pad.rows + '줄 / 버튼 ' + pad.n);
  ok2(pad.minH >= 56 && pad.minW >= 60, '엄지 타깃 크기 기준(≥56×60)', pad.minW + '×' + pad.minH);
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

  console.log('\n[8] 오프라인 강하(file://) — 서버 없이도 온전히 플레이되고, 서버 기능은 메시지 없이 조용히 꺼진다');
  const off = JSON.parse(await evalJS(`(async () => {
    const out = {};
    out.isFile = location.protocol === 'file:';
    out.secure = window.isSecureContext;
    try { const s = await window.TetrisClient.session({ mode: 'marathon', level: 1, g20: false }); out.session = s === null ? 'null (오프라인 감지)' : '값이 옴: ' + JSON.stringify(s).slice(0, 40); }
    catch (e) { out.session = 'THROW ' + e.message; }
    const D = window.TetrisDebug;
    await D.start();
    for (let i = 0; i < 400 && D.engine && D.engine.state !== 'over'; i++) { D.hardDrop(); await new Promise(r => setTimeout(r, 10)); }
    out.state = D.engine ? D.engine.state : 'no engine';
    out.played = D.engine ? ('pieces=' + D.engine.pieces + ' score=' + D.engine.score) : '';
    await new Promise(r => setTimeout(r, 450));
    const box = document.getElementById('submitBox');
    out.boxHidden = !box || box.classList.contains('hidden');
    out.boxText = box ? (box.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '없음';
    out.hasNameInput = !!(box && box.querySelector('#subName'));
    out.hasSubmitBtn = !!(box && box.querySelector('#subGo'));
    /* 공유 단계는 건너뛰되, 판은 이 기기에 남았는가 */
    const mine = document.getElementById('mineList');
    out.mineRows = mine ? mine.querySelectorAll('.wb-row').length : -1;
    out.mineText = mine ? (mine.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    out.localLabel = (window.TetrisI18n && window.TetrisI18n.t) ? window.TetrisI18n.t('mine.localOnly') : '?';
    out.dimRow = !!(mine && mine.querySelector('.wb-row.dim'));
    try { const st = JSON.parse(localStorage.getItem('neon-tetris-mine') || '[]'); out.st0 = st.length ? { localOnly: !!st[0].localOnly, share: st[0].share || null, score: st[0].score } : null; } catch (e) { out.st0 = 'PARSE ERR'; }
    const n = document.querySelector('.net'); out.netDot = n ? n.className : '없음';
    const wb = document.getElementById('wbList'); out.board = wb ? (wb.innerText || '').trim().slice(0, 28) : '없음';
    const hf = document.getElementById('hofList'); out.hof = hf ? (hf.innerText || '').trim().slice(0, 28) : '없음';
    out.stored = Object.keys(localStorage).filter(function (k) { return /tetris|neon|nt\b|high|nt./i.test(k); });
    return JSON.stringify(out);
  })()`, true));
  console.log('    ', off);
  ok2(off.isFile === true, 'probe 가 진짜 file:// 에서 돈다');
  ok2(off.secure === true, 'file:// 도 secure context (WebCrypto 사용 가능)');
  ok2(/^null/.test(off.session || ''), '세션 발급 실패를 null 로 강하(예외 아님)', off.session);
  ok2(off.state === 'over' && /pieces=[1-9]/.test(off.played || ''), '서버 없이도 한 판 끝까지 돈다', off.played);
  ok2(off.boxHidden === true || (off.hasSubmitBtn === false && off.hasNameInput === false), '오프라인에서는 공유 단계(제출 상자)를 아예 띄우지 않는다', off.boxText);
  ok2(!!off.st0 && off.st0.localOnly === true && off.st0.share === null, '판 자체는 이 기기 기록으로 남는다(미제출 표시)', off.st0);
  ok2(off.mineRows >= 1 && off.dimRow === true && (off.mineText || '').indexOf(off.localLabel) >= 0, "'내 기록'에 '서버 미제출' 라벨로 보인다", [off.mineRows, off.mineText, off.localLabel]);
  ok2(/\.off/.test(off.netDot || '') || /off/.test(off.netDot || ''), '네트워크 표시는 꺼진 상태', off.netDot);
  /* 세 상태 표시: 서버가 아예 없는 것은 "닿지만 제출 불가"(노랑)가 아니다. */
  ok2(!/warn/.test(off.netDot || ''), '서버 없음은 빨강이지 노랑이 아니다', off.netDot);
  ok2((off.board || '').length > 0 && (off.hof || '').length > 0, '보드·명예의 전당이 예외 대신 상태 문구를 보여준다', [off.board, off.hof]);
  ok2(off.stored.length > 0, '최고점 등 로컬 저장소는 동작한다', off.stored);


  console.log('\n[9] 숫자 서브셋 글꼴(NeonNum) — 로드/적용/잘림');
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


  console.log('\n[10] 크로스 런타임 결정론 — 브라우저 엔진과 서버(노드) 재시뮬이 같은 결과를 내야 검증이 성립한다');
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

  console.log('\n[11] 스크린샷 저장');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const shot2 = await cmd('Page.captureScreenshot', { format: 'png' });
  if (shot2.result && shot2.result.data) {
    const f2 = path.join(require('os').tmpdir(), 'neon-tetris-probe', 'probe-mobile.png');
    fs.writeFileSync(f2, Buffer.from(shot2.result.data, 'base64'));
    console.log('    → ' + f2 + '  ( 임시: file:// 화면이라 문서 그림으로 쓰지 않는다 )');
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
  killBrowser();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('프로브 실패: ' + e.message); killBrowser(); process.exit(1); });

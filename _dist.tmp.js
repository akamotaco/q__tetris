const AI = require('./tools/ai.js');
const crypto = require('crypto');
const hist = {};
for (let i = 0; i < 300; i++) {
  const seed = crypto.randomBytes(9).toString('base64url').replace(/[^0-9a-zA-Z]/g, '');
  const r = AI.run({ seed: seed, mode: 'sprint', preset: 'human', rng: AI.makeRand(seed) });
  hist[r.lines] = (hist[r.lines] || 0) + 1;
}
const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
console.log('스프린트 종료 시 lines 분포 (300판, 서버와 같은 방식의 랜덤 시드):');
keys.forEach(k => console.log('  ' + k + '줄 : ' + String(hist[k]).padStart(3) + '  ' + '#'.repeat(Math.round(hist[k] / 3))));
const at40 = hist[40] || 0;
console.log('→ lines === 40 일 확률 ≈ ' + (at40 / 300 * 100).toFixed(1) + '%  (즉 3분의 1은 41+ 로 끝난다)');

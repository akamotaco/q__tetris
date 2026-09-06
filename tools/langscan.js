#!/usr/bin/env node
'use strict';
/* ============================================================================
 * tools/langscan.js — 한국어 파일에 다른 언어가 섞이는 사고를 잡는다.
 *
 * 왜 있나: 이 프로젝트의 문서·주석·커밋 메시지는 한국어이고, 앱 번역은 i18n.js 에
 * 4개 언어로 따로 있다. 그동안 한자·가나·중국어를 주석에서 몇 번이나 흘렸고
 * (内容/移动端/压 …) 눈으로 보면 잘 안 보인다. 그래서 커밋 전에 돌리는 저가 검사.
 *
 * 검사하지 않는 것: U+300C 「」 같은 구두점(한국어 문서에서 따옴표로 일부러 쓴다),
 * i18n.js( 번역문이 정상), tools/langscan.js 자기 자신(검사 범위를 문자로 적어야 한다).
 *
 * 쓰기: node tools/langscan.js            → 추적 파일 전부
 *       node tools/langscan.js README.md  → 지정 파일만
 * 끝날 때 오염이 있으면 exit 1 (커밋 체인에서 && 로 막을 수 있게).
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CJK = /[\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uFF61-\uFF9F\u0E00-\u0E7F\uFEFF\u200B]/;
const EXCLUDE = /(i18n\.js$|langscan\.js$|legacy[\\/]|data[\\/])/;
const ext = /\.(js|md|css|html|json|caddyfile|conf|service|yml|yaml|dockerfile)$/i;

function targets(argv) {
  if (argv.length) return argv;
  let list = [];
  try {
    list = execSync('git ls-files -z', { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch (e) {
    /* git 밖이면 어쩔 수 없이 재귀 탐색 */
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'data') return [];
      return e.isDirectory() ? walk(p) : (ext.test(e.name) ? [p.replace(/\\/g, '/')] : []);
    });
    list = walk('.');
  }
  return list.filter(f => ext.test(f) && !EXCLUDE.test(f));
}

const files = targets(process.argv.slice(2));
let bad = 0, seen = 0;
for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  seen++;
  src.split('\n').forEach((l, i) => {
    const hits = [...l].filter(c => CJK.test(c));
    if (!hits.length) return;
    bad++;
    const kinds = [...new Set(hits.map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()))];
    console.log(f + ':' + (i + 1) + '  ' + kinds.join(' ') + '\n    ' + l.trim().slice(0, 100));
  });
}
console.log('\n' + seen + '개 파일 검사 → 혼입 ' + bad + '곳' + (bad ? '' : ' ✓'));
process.exit(bad ? 1 : 0);

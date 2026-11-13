#!/usr/bin/env node
'use strict';
// Fails (exit 1) if any tracked text file contains mojibake markers, i.e.
// UTF-8 text that was decoded as Windows-1252 and saved again as UTF-8.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const EXT = /\.(js|html|css|md|json)$/i;
// U+00F0 U+0178 (emoji lead), U+00E2 followed by a CP1252-mapped char (symbols), U+00C3/U+00C2 + high char, U+FFFD
const MARKERS = [
  /\u00f0\u0178/g,
  /\u00e2[\u20ac\u0153\u009d\u0161\u2021\u2013\u2030\u2122\u201a\u0192\u201e\u2026\u2020\u02c6\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2014\u02dc\u203a\u0153\u017e\u0178]/g,
  /[\u00c2\u00c3][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u203a\u20ac\u2122]/g,
  /\ufffd/g,
];

function trackedFiles() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter((f) => f && EXT.test(f) && f !== 'tools/check-encoding.js');
}

function scan(text) {
  let n = 0;
  for (const re of MARKERS) n += (text.match(re) || []).length;
  return n;
}

function main() {
  let bad = 0;
  for (const f of trackedFiles()) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const text = buf.toString('utf8');
    const issues = [];
    const n = scan(text);
    if (n) issues.push(n + ' mojibake marker(s)');
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) issues.push('UTF-8 BOM');
    if (issues.length) {
      bad++;
      console.log(f + ': ' + issues.join(', '));
    }
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const head = /<head[^>]*>\s*<meta\s+charset=["']utf-8["']/i.test(html);
  if (!head) { bad++; console.log('index.html: <meta charset="UTF-8"> must be first in <head>'); }
  if (bad) { console.log('FAIL: encoding problems in ' + bad + ' file(s)'); process.exit(1); }
  console.log('OK: no encoding problems found');
}

if (require.main === module) main();
module.exports = { scan };

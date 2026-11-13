'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { expandString, expandValue, buildRules } = require('./build-rules');
const { macros } = require('./macros');

test('ADMIN_OF is not rewritten by the ADM macro (word boundary)', () => {
    const out = expandString("ADMIN_OF($uid)", { ADM: macros.ADM, ADMIN_OF: macros.ADMIN_OF });
    assert.ok(out.includes("root.child('usersV2').child($uid)"), out);
    assert.ok(!/\bADMIN_OF\b/.test(out));
});

test('nested macros expand to a fixpoint', () => {
    const out = expandValue('TW($teamId)', macros);
    assert.ok(!/\b(TW|SU|SI|ADM|MGR|ME)\b/.test(out), out);
    assert.ok(out.includes("everyoneSeesAll"));
});

test('build fails when a macro remains after the pass limit', () => {
    const loop = { A: { params: 0, body: 'B' }, B: { params: 0, body: 'A' } };
    assert.throws(() => expandValue('A', loop), /pass limit|Unexpanded/);
});

test('leftover macro name fails the build on a fixture', () => {
    const fixture = { rules: { '.read': 'SI && NOPE_MACRO' } };
    const m = Object.assign({}, macros, { NOPE_MACRO: { params: 0, body: 'NOPE_MACRO' } });
    assert.throws(() => buildRules(fixture, m));
});

test('generated database.rules.json is valid, macro free and in sync with the source', () => {
    const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'database.rules.src.json'), 'utf8'));
    const generatedPath = path.join(__dirname, '..', 'database.rules.json');
    const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    assert.deepStrictEqual(generated, buildRules(src));
    const text = JSON.stringify(generated);
    for (const name of Object.keys(macros)) {
        assert.ok(!new RegExp('(?<![\\w$])' + name + '(?![\\w$])').test(text), 'macro left: ' + name);
    }
});

test('SELFMOVE is gone and teams cannot be named unassigned', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
    assert.ok(!text.includes('SELFMOVE'));
    assert.ok(text.includes("$teamId !== 'unassigned'"));
});

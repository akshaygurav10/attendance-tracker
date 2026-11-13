'use strict';
// Expands the macros in rules/database.rules.src.json into ../database.rules.json.
// Longest macro name first, repeated to a fixpoint (max 10 passes). Fails if a
// macro name remains in the output or the pass limit is hit.

const fs = require('fs');
const path = require('path');
const { macros: defaultMacros } = require('./macros');

const MAX_PASSES = 10;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandString(str, macros) {
    const names = Object.keys(macros).sort((a, b) => b.length - a.length);
    let out = str;
    for (const name of names) {
        const m = macros[name];
        const re = m.params === 0
            ? new RegExp('(?<![\\w$])' + escapeRe(name) + '(?![\\w$(])', 'g')
            : new RegExp('(?<![\\w$])' + escapeRe(name) + '\\(([^()]*)\\)', 'g');
        out = out.replace(re, (_match, arg) => {
            if (m.params === 0) return m.body;
            return m.body.split('{0}').join(String(arg).trim());
        });
    }
    return out;
}

function hasMacro(str, macros) {
    return Object.keys(macros).some((name) =>
        new RegExp('(?<![\\w$])' + escapeRe(name) + '(?![\\w$])').test(str));
}

function expandValue(value, macros) {
    if (typeof value === 'string') {
        let cur = value;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const next = expandString(cur, macros);
            if (next === cur) {
                if (hasMacro(cur, macros)) {
                    throw new Error('Unexpanded macro remains in: ' + value.slice(0, 80));
                }
                return cur;
            }
            cur = next;
        }
        throw new Error('Macro expansion pass limit (' + MAX_PASSES + ') hit for: ' + value.slice(0, 80));
    }
    if (Array.isArray(value)) return value.map((v) => expandValue(v, macros));
    if (value && typeof value === 'object') {
        const o = {};
        for (const k of Object.keys(value)) o[k] = expandValue(value[k], macros);
        return o;
    }
    return value;
}

// Final check over the whole expanded document.
function assertNoMacros(json, macros) {
    const text = JSON.stringify(json);
    for (const name of Object.keys(macros)) {
        if (new RegExp('(?<![\\w$])' + escapeRe(name) + '(?![\\w$])').test(text)) {
            throw new Error('Macro name still present in output: ' + name);
        }
    }
}

function buildRules(srcObj, macros = defaultMacros) {
    const expanded = expandValue(srcObj, macros);
    assertNoMacros(expanded, macros);
    return expanded;
}

function main() {
    const src = path.join(__dirname, 'database.rules.src.json');
    const dest = path.join(__dirname, '..', 'database.rules.json');
    const srcObj = JSON.parse(fs.readFileSync(src, 'utf8'));
    const out = buildRules(srcObj);
    const text = JSON.stringify(out, null, 2) + '\n';
    fs.writeFileSync(dest, text);
    console.log('Wrote ' + path.relative(process.cwd(), dest) + ' (' + Buffer.byteLength(text) + ' bytes)');
}

module.exports = { expandString, expandValue, buildRules, assertNoMacros, hasMacro };

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error('Rules build failed: ' + e.message);
        process.exit(1);
    }
}

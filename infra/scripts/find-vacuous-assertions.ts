/**
 * Find assertions that cannot fail.
 *
 * Motivated by a real one. This spec:
 *
 *     const dump = JSON.stringify([...(store as any).map ?? []]);
 *     assert.ok(!dump.includes(debugCode), 'the code appears in clear');
 *
 * read `.map` when the field was `.data`. It serialised undefined, compared
 * against an empty string, and passed no matter what the service stored. Its
 * entire job was to catch OTP codes being written reversibly, and it did not:
 * reverting the fix left it green.
 *
 * A test that cannot go red is worse than no test. No test is a known gap; a
 * green one that cannot fail is a gap everybody believes is closed.
 *
 * This is a LINTER, not a prover — it flags shapes worth a human look:
 *
 *   1. A negative assertion (`assert.ok(!x.includes(y))`, `notEqual`,
 *      `findsNothing`) whose subject is never asserted non-empty. Empty
 *      contains nothing, so the check is free.
 *   2. `as any` reaching into a private field, which is how the subject
 *      silently became undefined in the first place.
 *
 * Exit 0 always: this reports, it does not gate. Turning it into a gate
 * before the existing findings are triaged would just teach people to
 * ignore it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.dart_tool', 'build'].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(spec|test)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
  why: string;
}

const findings: Finding[] = [];

/** Variables the file proves non-empty somewhere. */
function guardedNames(source: string): Set<string> {
  const guarded = new Set<string>();
  const patterns = [
    /assert\.ok\(\s*(\w+)\.length\s*>/g,
    /assert\.ok\(\s*(\w+)\.size\s*>/g,
    /assert\.ok\(\s*(\w+)\s*instanceof\s+Map/g,
    /assert\.equal\(\s*(\w+)\.length\s*,\s*[1-9]/g,
    /assert\.ok\(\s*(\w+)\.includes\(/g,        // a positive check on the same subject
    /expect\(\s*(\w+),\s*isNotEmpty\)/g,
    /assert\.ok\(\s*Array\.isArray\((\w+)\)\s*&&\s*\1\.length/g,
    /assert\.ok\(\s*(\w+)\s*\)/g,               // plain truthiness
    /(\w+)\.length\s*>\s*\d+/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) guarded.add(m[1]!);
  }
  return guarded;
}

for (const file of walk(join(ROOT, 'apps')).concat(walk(join(ROOT, 'libs')))) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const guarded = guardedNames(source);
  const rel = relative(ROOT, file);

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    // 1. Negative containment on an unguarded subject.
    const neg = /assert\.ok\(\s*!\s*(\w+)(?:!)?\.(?:includes|some|has)\(/.exec(trimmed);
    if (neg) {
      const subject = neg[1]!;
      if (!guarded.has(subject)) {
        findings.push({
          file: rel, line: i + 1, text: trimmed.slice(0, 100),
          why: `'${subject}' is never asserted non-empty — empty contains nothing`,
        });
      }
    }

    // 2. Private-field access through `as any`, excluding known-safe casts.
    const priv = /\((\w+) as any\)\.(\w+)/.exec(trimmed);
    if (priv && !/json\(\)|payload|__/.test(trimmed)) {
      findings.push({
        file: rel, line: i + 1, text: trimmed.slice(0, 100),
        why: `reaches into '${priv[2]}' via 'as any' — a typo yields undefined, silently`,
      });
    }
  });
}

/* ------------------------------------------------------------------ */

if (findings.length === 0) {
  console.log('No vacuous-assertion shapes found.');
  process.exit(0);
}

console.log(`\n${findings.length} assertion(s) worth a second look:\n`);
let current = '';
for (const f of findings) {
  if (f.file !== current) { console.log(`  ${f.file}`); current = f.file; }
  console.log(`    :${f.line}  ${f.why}`);
  console.log(`           ${f.text}`);
}
console.log(
  '\nThese are SHAPES, not proven bugs. The question for each: if the code'
  + '\nunder test were reverted, would this line go red? If unsure, mutate and'
  + '\ncheck — that is how the OTP one was found.\n',
);
process.exit(0);

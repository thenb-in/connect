import { readFileSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'src/engine/categorization';
const files = readdirSync(OUT).filter((f) => f.endsWith('.js'));

// Discover where each top-level const lives + whether it is exported.
const home = {};
const exported = {};
for (const f of files) {
  const txt = readFileSync(`${OUT}/${f}`, 'utf8');
  for (const m of txt.matchAll(/^(export\s+)?const (\w+)\s*=/gm)) {
    home[m[2]] = f;
    exported[m[2]] = exported[m[2]] || Boolean(m[1]);
  }
}

const stripNonCode = (txt) =>
  txt
    .replace(/import[\s\S]*?from\s*'[^']+';/g, '') // import blocks
    .replace(/\/\*[\s\S]*?\*\//g, '')              // block comments
    .replace(/\/\/[^\n]*/g, '')                    // line comments
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')      // template strings
    .replace(/'(?:\\.|[^'\\])*'/g, "''")           // single-quoted
    .replace(/"(?:\\.|[^"\\])*"/g, '""');          // double-quoted

let problems = 0;
const fail = (m) => { console.log('  ✗ ' + m); problems++; };

for (const f of files) {
  const txt = readFileSync(`${OUT}/${f}`, 'utf8');
  const imported = new Set();
  for (const m of txt.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => imported.add(n));
  }
  const code = stripNonCode(txt);

  // (a) cross-file symbol used in code must be imported + exported by its home
  for (const [name, hf] of Object.entries(home)) {
    if (hf === f) continue;
    if (new RegExp(`\\b${name}\\b`).test(code)) {
      if (!imported.has(name)) fail(`${f}: uses ${name} (in ${hf}) but does not import it`);
      else if (!exported[name]) fail(`${f}: imports ${name} but ${hf} doesn't export it`);
    }
  }
  // (b) every './'-imported name must exist + be exported
  for (const m of txt.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g)) {
    for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!home[n]) fail(`${f}: imports ${n} from ${m[2]} — defined nowhere`);
      else if (!exported[n]) fail(`${f}: imports ${n} — not exported by ${home[n]}`);
    }
  }
}

// (c) syntax check: copy to .mjs (ESM) and node --check each
const tmp = mkdtempSync(join(tmpdir(), 'catcheck-'));
for (const f of files) {
  const dest = join(tmp, f.replace(/\.js$/, '.mjs'));
  writeFileSync(dest, readFileSync(`${OUT}/${f}`, 'utf8'));
  try {
    execSync(`node --check ${dest}`, { stdio: 'pipe' });
  } catch (e) {
    fail(`${f}: syntax -> ${String(e.stderr || e).split('\n').find((l) => l.includes('Error')) || ''}`);
  }
}
rmSync(tmp, { recursive: true, force: true });

console.log(problems ? `\n${problems} problem(s)` : '\n✓ all references resolve and every file parses');
process.exit(problems ? 1 : 0);

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const out = mkdtempSync(join(tmpdir(), 'voice-input-dist-'));
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', out], { stdio: 'inherit' });
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const a = files(out).map((f) => relative(out, f)).sort();
const b = files('dist').map((f) => relative('dist', f)).sort();
const stale = a.filter((f) => !b.includes(f) || readFileSync(join(out, f), 'utf8') !== readFileSync(join('dist', f), 'utf8')).concat(b.filter((f) => !a.includes(f)));
rmSync(out, { recursive: true, force: true });
if (stale.length) {
  console.error(`dist is stale; run pnpm build:\n${stale.join('\n')}`);
  process.exit(1);
}
console.log('dist is current');

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.cwd(), 'scripts/patch-production-slate.cjs');
let source = fs.readFileSync(file, 'utf8');

for (const name of ['ALLSPORTS_URL', 'home', 'away', 'targetDate']) {
  const re = new RegExp(`(?<!\\\\)\\$\\{${name}\\}`, 'g');
  source = source.replace(re, `\\\\$\\{${name}\\}`);
}

fs.writeFileSync(file, source, 'utf8');
console.log('[production-patch] normalized nested template interpolation');

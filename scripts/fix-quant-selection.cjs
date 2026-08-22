import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('server/agent/subagents/quant-synthesis.ts');
const source = fs.readFileSync(file, 'utf8');
const bad = 'const { primaryBet, alternativePicks } = parseSelectionPayload(finalAnswer, fallbackPrimary);';
const good = 'const { primary: primaryBet, alternatives: alternativePicks } = parseSelectionPayload(finalAnswer, fallbackPrimary);';

if (source.includes(bad)) {
  fs.writeFileSync(file, source.replace(bad, good), 'utf8');
  console.log('[build-fix] normalized quant selection property names');
} else if (source.includes(good)) {
  console.log('[build-fix] quant selection names already normalized');
} else {
  throw new Error('[build-fix] expected QuantSynthesis selection destructuring was not found');
}

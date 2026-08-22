const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve('server/agent/airtable-logger.ts');
let source = fs.readFileSync(file, 'utf8');

const checkbox = "type: 'checkbox', options: CHECKBOX_OPTIONS";
const dateTime = "type: 'dateTime', options: DATE_TIME_OPTIONS";

source = source.replace(/type:\s*'checkbox'(?!\s*,\s*options)/g, checkbox);
source = source.replace(/type:\s*'dateTime'(?!\s*,\s*options)/g, dateTime);

if (!source.includes('const CHECKBOX_OPTIONS')) {
  source = source.replace(
    /const DATE_TIME_OPTIONS = ([^;]+);/,
    "const DATE_TIME_OPTIONS = { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' };\nconst CHECKBOX_OPTIONS = { color: 'greenBright', icon: 'check' };"
  );
}

fs.writeFileSync(file, source, 'utf8');
console.log('[build-fix] Airtable schema normalized: checkbox/dateTime options ensured');

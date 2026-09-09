// 用法：npm run import-prototype --workspace=server -- backup.json [YYYY-MM-DD] [--wipe]
import fs from 'node:fs';
import { importPrototype } from './import-prototype.js';
import { seed } from './seed.js';

const [file, maybeDate, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('用法: import-prototype <backup.json> [YYYY-MM-DD] [--wipe]');
  process.exit(1);
}
seed();
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const baseDate = maybeDate && /^\d{4}-\d{2}-\d{2}$/.test(maybeDate) ? maybeDate : undefined;
const wipe = flags.includes('--wipe') || maybeDate === '--wipe';
importPrototype(data, { baseDate, wipe }).then((r) => {
  console.log(JSON.stringify(r, null, 2));
});

const fs = require('fs');
const p = require('path').join(__dirname, 'comp1.js');
const s = fs.readFileSync(p, 'utf8');
const tokens = process.argv.slice(2);
for (const t of tokens) {
  let idx = 0, n = 0;
  while ((idx = s.indexOf(t, idx)) !== -1 && n < 12) {
    console.log('==== ' + t + ' @ ' + idx + ' ====');
    console.log(s.slice(Math.max(0, idx - 280), idx + 280).replace(/\s+/g, ' '));
    console.log('');
    idx += t.length; n++;
  }
  if (n === 0) console.log('==== ' + t + ' : 未找到 ====\n');
}

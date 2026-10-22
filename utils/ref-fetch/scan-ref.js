const fs = require('fs');
const path = require('path');
const dir = __dirname;
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['comp1.js','chunk1.js','chunk2.js','chunk3.js','extra.js','preview.html','page1.css','page2.css','anybody.css'];
const TOKENS = ['00ffea','a6ffff','b6ffff','f2d9ff','9bf6ff','ffd1ff','00a2ff','00ffff','0055ff','ff1a40','ff002c','ff4d6d','ff3355','ff8093','9d4edd','c77dff','e0aaff','f0ebdd','ff007f','ff80df','7b2cbf','ff5c8a','00ffd1','00aaff','00a390','00ffc8','062d30','1a0003','10001a','ff0000','21000','15000','12000','14000'];
for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.log('== ' + f + ': not found'); continue; }
  const s = fs.readFileSync(p, 'utf8');
  console.log('\n===== ' + f + ' (' + s.length + ' bytes) =====');
  const hits = TOKENS.map(t => { const c = (s.match(new RegExp(t, 'gi')) || []).length; return c ? (t + ':' + c) : null; }).filter(Boolean);
  console.log('色值/数字命中: ' + (hits.join('  ') || '无'));
  const nums = {};
  for (const m of s.matchAll(/(?:^|[^\d.eE])(\d{1,3})e3(?![\d.eE])/g)) nums[m[1] + 'e3'] = (nums[m[1] + 'e3'] || 0) + 1;
  console.log('ne3 次数: ' + JSON.stringify(nums));
  const f32s = [...new Set([...s.matchAll(/Float32Array\(\s*([^)]{0,40})\s*\)/g)].map(m => m[1].trim()))];
  console.log('Float32Array 尺寸: ' + (f32s.join(' | ') || '无'));
  const sizeLt = [...new Set([...s.matchAll(/size\s*<\s*(\d+)/g)].map(m => m[1]))];
  const distLt = [...new Set([...s.matchAll(/dist\s*<\s*([\d.]+)/g)].map(m => m[1]))];
  console.log('size<: ' + (sizeLt.join(',') || '无') + ' | dist<: ' + (distLt.join(',') || '无'));
  const tempNames = [...new Set([...s.matchAll(/temp[A-Z][A-Za-z]{2,30}/g)].map(m => m[0]))];
  console.log('temp* 变量: ' + (tempNames.join(' | ') || '无'));
  const keywords = ['figure','Figure','Body','body','Human','human','Synthesis','synthesis','skull','Skull','bone','Bone','cranium','Cranium','skeleton','Skeleton'];
  const kw = keywords.map(k => { const c = (s.match(new RegExp(k, 'g')) || []).length; return c ? (k + ':' + c) : null; }).filter(Boolean);
  console.log('关键字: ' + (kw.join('  ') || '无'));
}

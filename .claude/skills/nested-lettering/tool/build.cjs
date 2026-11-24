// Inline engine/nest.js into the tool page: node tool/build.js [out.html]
const fs = require('fs'), path = require('path');
const dir = __dirname;
const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const nest = fs.readFileSync(path.join(dir, '..', 'engine', 'nest.js'), 'utf8');
const out = process.argv[2] || path.join(dir, 'inlay-lettering.html');
fs.writeFileSync(out, tpl.replace('/*__NEST__*/', () => nest.replace(/<\/script/gi, '<\\/script')));
console.log('wrote', out);

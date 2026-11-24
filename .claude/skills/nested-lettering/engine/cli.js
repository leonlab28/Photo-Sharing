#!/usr/bin/env node
// usage:
//   node cli.js plan WORD                    -> suggested host/guest pairs
//   node cli.js render SPEC.json OUT.svg     -> SVG + JSON report on stdout
//   node cli.js render '{"text":"DEZEMBER"}' OUT.svg   (inline JSON works too)
const fs = require('fs');
const Nest = require('./nest.js');
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'plan') {
  console.log(JSON.stringify(Nest.plan(a || ''), null, 1));
} else if (cmd === 'render') {
  const spec = a.trim().startsWith('{') ? JSON.parse(a) : JSON.parse(fs.readFileSync(a, 'utf8'));
  const res = Nest.layout(spec);
  fs.writeFileSync(b || 'out.svg', Nest.toSVG(res, spec.colors || {}));
  console.log(JSON.stringify({
    width: +res.width.toFixed(1), height: +res.height.toFixed(1), ratio: +(res.width / res.height).toFixed(3),
    units: res.units.map((u) => ({ pair: u.host + (u.guest || ''), x: +u.x.toFixed(1), w: +u.w.toFixed(1), S: u.S, T: u.T })),
    warnings: res.warnings,
  }, null, 1));
} else {
  console.log('usage: node cli.js plan WORD | node cli.js render SPEC.json OUT.svg');
  process.exit(1);
}

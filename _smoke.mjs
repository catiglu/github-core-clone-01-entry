
import { createApp } from './app.ts';
const s = createApp();
await new Promise(r => s.listen(0, r));
const port = s.address().port;
console.log('PORT', port);
async function j(p, opts) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, opts);
  const t = await r.text();
  return [r.status, t.slice(0, 300)];
}
console.log('health', await j('/healthz'));
console.log('root', await j('/api/v3'));
console.log('repo404', await j('/api/v3/repos/a/b'));
console.log('create', await j('/api/v3/user/repos', {method:'POST', headers:{'content-type':'application/json','authorization':'Bearer tok_adaiversen'}, body: JSON.stringify({name:'alpha'})}));
console.log('get', await j('/api/v3/repos/adaiversen/alpha'));
console.log('gql', await j('/api/graphql', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({query:'{ viewer { login } repository(owner:"adaiversen", name:"alpha") { nameWithOwner } }'})}));
console.log('mcp', await j('/mcp', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list'})}));
console.log('gitadv', await j('/adaiversen/alpha.git/info/refs?service=git-upload-pack'));
s.close();

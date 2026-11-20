import { createApp } from './app.ts';

const s = createApp();
await new Promise(r => s.listen(0, r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
const H = { 'content-type': 'application/json', authorization: 'Bearer tok' };

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  console.log(`\n=== ${method} ${path} -> ${res.status}`);
  console.log(typeof json === 'string' ? json : JSON.stringify(json, null, 1).slice(0, 800));
  return { status: res.status, json };
}

// 1. create repo
await call('POST', '/api/v3/user/repos', { name: 'itest', auto_init: true });
// 2. create label
await call('POST', '/api/v3/repos/adaiversen/itest/labels', { name: 'bug', color: 'ededed' });
// 3. create issue
await call('POST', '/api/v3/repos/adaiversen/itest/issues', { title: 'Test Issue', body: 'Hello', labels: ['bug'] });
// 4. list issues
await call('GET', '/api/v3/repos/adaiversen/itest/issues?state=open&sort=created&direction=asc&per_page=2&page=1');

s.close();
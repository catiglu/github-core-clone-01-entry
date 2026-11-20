// A GitHub-compatible forge: REST v3, git smart HTTP, GraphQL v4 and an MCP endpoint.
//
// The server is one process and holds its state in memory: repositories, their commits and
// refs, issues, labels and pull requests. Nothing here reads the clock for a value a client
// can see twice, and every reply is JSON (git's own protocol excepted).
//
// Layout: store and helpers below, then the REST surface, then git smart HTTP, then GraphQL
// and MCP. main.ts owns the entry <-> env lifecycle and stays as it ships.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const OWNER_LOGIN = 'adaiversen';
const STRANGER_LOGIN = 'olgabauer';
const VIEWER_ID = 1000;
const STRANGER_ID = 1002;
const DEFAULT_BRANCH = 'main';
const EPOCH = '2025-01-01T00:00:00Z';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- store

interface Blob {
  sha: string;
  content: Buffer;
}

interface Commit {
  sha: string;
  parents: string[];
  message: string;
  tree: Map<string, Blob>;
  author: string;
  createdAt: string;
}

interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  closedAt?: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeSha?: string;
  createdAt: string;
}

interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  objects: Map<string, { type: string; content: Buffer }>;
  labels: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function nowIso(repo?: Repo): string {
  if (!repo) return EPOCH;
  repo.seq += 1;
  return new Date(Date.parse(EPOCH) + repo.seq * 1000).toISOString().replace('.000Z', 'Z');
}

function nextNumber(repo: Repo, kind: 'issue' | 'pull'): number {
  return kind === 'issue' ? repo.nextIssue++ : repo.nextPull++;
}

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function gitSha(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([header, content]));
}

function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    commits: new Map(),
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    seq: 0,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function branchTip(repo: Repo, branch: string): Commit | undefined {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  return sha === undefined ? undefined : repo.commits.get(sha);
}

function putObject(repo: Repo, type: string, content: Buffer): string {
  const sha = gitSha(type, content);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, content });
  return sha;
}

function makeCommit(repo: Repo, tree: Map<string, Blob>, parents: string[], message: string): Commit {
  const createdAt = nowIso(repo);
  const commit: Commit = { sha: '', parents, message, tree, author: OWNER_LOGIN, createdAt };
  const body = [
    `tree ${gitSha('tree', encodeTree(tree))}`,
    ...parents.map((p) => `parent ${p}`),
    `author ${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid> 1735689600 +0000`,
    `committer ${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid> 1735689600 +0000`,
    '',
    message,
    '',
  ].join('\n');
  commit.sha = gitSha('commit', Buffer.from(body, 'utf8'));
  repo.commits.set(commit.sha, commit);
  putObject(repo, 'commit', Buffer.from(body, 'utf8'));
  putObject(repo, 'tree', encodeTree(tree));
  for (const blob of tree.values()) putObject(repo, 'blob', blob.content);
  return commit;
}

// A tree object: sorted `mode name\0<20-byte sha>` records. The mode is 100644 for every file.
function encodeTree(tree: Map<string, Blob>): Buffer {
  const parts: Buffer[] = [];
  for (const name of [...tree.keys()].sort()) {
    const blob = tree.get(name);
    if (blob === undefined) continue;
    parts.push(Buffer.from(`100644 ${name}\0`, 'utf8'));
    parts.push(Buffer.from(blob.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function decodeTree(content: Buffer): Map<string, Blob> {
  const tree = new Map<string, Blob>();
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = content.indexOf(0x00, space);
    if (nul < 0) break;
    const name = content.subarray(space + 1, nul).toString('utf8');
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    tree.set(name, { sha, content: Buffer.alloc(0) });
    offset = nul + 21;
  }
  return tree;
}

// ---------------------------------------------------------------- http helpers

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
    ...headers,
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-length': '0',
    'x-github-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
    ...headers,
  });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? '127.0.0.1';
}

function bearerOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match === undefined ? undefined : match[1].trim();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Json | undefined> {
  let text: string;
  try {
    text = (await readBody(req)).toString('utf8');
  } catch {
    sendJson(res, 400, { message: 'The request body could not be read.' });
    return undefined;
  }
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { message: 'The request body is not a JSON object.' });
      return undefined;
    }
    return parsed as Json;
  } catch {
    sendJson(res, 400, { message: 'The request body is not valid JSON.' });
    return undefined;
  }
}

function str(body: Json, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

function bool(body: Json, key: string, fallback = false): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- repo shapes

function repoJson(repo: Repo, base: string): Json {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: hashId(`${repo.owner}/${repo.name}`),
    node_id: `R_abc${hashId(repo.name).slice(0, 8)}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === OWNER_LOGIN ? VIEWER_ID : STRANGER_ID, node_id: 'U_abc', avatar_url: '', html_url: `${base}/${repo.owner}` },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 1,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    forks_count: 0,
    open_issues_count: openIssues,
    default_branch: repo.defaultBranch,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    has_issues: true,
    has_wiki: true,
    has_pages: false,
    url,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${hostOf({ headers: { host: new URL(base).host } } as IncomingMessage)}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${new URL(base).host}:${repo.owner}/${repo.name}.git`,
    contents_url: `${url}/contents/{+path}`,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/issues/comments{/number}`,
    git_refs_url: `${url}/git/refs{/sha}`,
    branches_url: `${url}/branches{/branch}`,
    commits_url: `${url}/commits{/sha}`,
  };
}

function hashId(text: string): string {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) % 2_147_483_647;
  return String(hash);
}

function issueJson(repo: Repo, issue: Issue, base: string): Json {
  return {
    id: hashId(`${repo.name}#${issue.number}`),
    node_id: `I_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ id: hashId(name), name, color: repo.labels.get(name) ?? 'ededed', description: null })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.closedAt ?? issue.createdAt,
    closed_at: issue.closedAt ?? null,
    user: { login: OWNER_LOGIN, id: VIEWER_ID },
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull, base: string): Json {
  const headRepo = { ...repo, name: repo.name };
  return {
    id: hashId(`${repo.name}pull${pull.number}`),
    node_id: `P_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: pull.merged ? true : null,
    merged_at: pull.merged ? pull.createdAt : null,
    closed_at: pull.state === 'closed' ? pull.createdAt : null,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    user: { login: OWNER_LOGIN, id: VIEWER_ID },
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, repo: { id: 1, name: headRepo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: VIEWER_ID }, private: repo.private, default_branch: repo.defaultBranch } },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, repo: { id: 1, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: VIEWER_ID }, private: repo.private, default_branch: repo.defaultBranch } },
    _links: { self: { href: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` }, html: { href: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}` } },
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}
// ---------------------------------------------------------------- REST: repos

function paginate(req: IncomingMessage, res: ServerResponse, base: string, items: Json[], makeUrl: (page: number) => string): Json[] {
  const query = queryOf(req);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) links.push(`<${makeUrl(page + 1)}>; rel="next"`);
  links.push(`<${makeUrl(lastPage)}>; rel="last"`);
  links.push(`<${makeUrl(1)}>; rel="first"`);
  if (page > 1) links.push(`<${makeUrl(Math.min(page - 1, lastPage))}>; rel="prev"`);
  res.setHeader('link', links.join(', '));
  void base;
  return slice;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const base = `http://${hostOf(req)}`;
  const method = (req.method ?? 'GET').toUpperCase();
  const token = bearerOf(req);
  const segments = path.split('/').filter((segment) => segment !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (token === undefined) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // Root and meta.
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: `${base}/api/v3/user`,
      authorizations_url: `${base}/api/v3/authorizations`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, user' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: 'github-core-clone-01 1.0.0' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: OWNER_LOGIN, id: VIEWER_ID, node_id: 'U_adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User', site_admin: false, created_at: EPOCH });
    return;
  }

  // POST /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'POST') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const name = str(body, 'name').trim();
    if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
      sendJson(res, 422, { message: 'Repository name is invalid.' });
      return;
    }
    if (repos.has(repoKey(OWNER_LOGIN, name))) {
      sendJson(res, 422, { message: 'name already exists on this account' });
      return;
    }
    const repo = newRepo(OWNER_LOGIN, name, str(body, 'description'), bool(body, 'private', false));
    sendJson(res, 201, repoJson(repo, base));
    return;
  }

  // GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'GET') {
    const items = [...repos.values()].filter((repo) => repo.owner === OWNER_LOGIN).map((repo) => repoJson(repo, base));
    const slice = paginate(req, res, base, items, (page) => {
      const query = queryOf(req);
      query.set('page', String(page));
      return `${base}/api/v3/user/repos?${query.toString()}`;
    });
    sendJson(res, 200, slice);
    return;
  }

  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = repos.get(repoKey(owner, name));
    if (repo === undefined || repo.owner !== OWNER_LOGIN) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await handleRepoRest(req, res, base, repo, rest.slice(3), method);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepoRest(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  // Repo root.
  if (tail.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo, base)); return; }
    if (method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        const next = body.name;
        if (repos.has(repoKey(repo.owner, next))) { sendJson(res, 422, { message: 'name already exists on this account' }); return; }
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = next;
        repos.set(repoKey(repo.owner, next), repo);
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      repo.updatedAt = nowIso(repo);
      sendJson(res, 200, repoJson(repo, base));
      return;
    }
    if (method === 'DELETE') { repos.delete(repoKey(repo.owner, repo.name)); sendEmpty(res, 204); return; }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  switch (tail[0]) {
    case 'contents': await handleContents(req, res, base, repo, tail.slice(1), method); return;
    case 'git': await handleGitData(req, res, base, repo, tail.slice(1), method); return;
    case 'branches': await handleBranches(req, res, base, repo, tail.slice(1), method); return;
    case 'commits': await handleCommits(req, res, base, repo, tail.slice(1), method); return;
    case 'labels': await handleLabels(req, res, base, repo, tail.slice(1), method); return;
    case 'issues': await handleIssues(req, res, base, repo, tail.slice(1), method); return;
    case 'pulls': await handlePulls(req, res, base, repo, tail.slice(1), method); return;
    default: sendJson(res, 404, { message: 'Not Found' });
  }
}

// ---------------------------------------------------------------- REST: contents

function treeAt(repo: Repo, ref: string | undefined): Map<string, Blob> {
  const branch = ref === undefined || ref === '' ? repo.defaultBranch : ref;
  const tip = branchTip(repo, branch) ?? (repo.refs.size === 0 ? undefined : branchTip(repo, repo.defaultBranch));
  return tip === undefined ? new Map() : tip.tree;
}

function contentJson(repo: Repo, base: string, path: string, blob: Blob, ref: string): Json {
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: blob.sha,
    size: blob.content.length,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${ref}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blob.sha}`,
    download_url: `${base}/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
    type: 'file',
    encoding: 'base64',
    content: blob.content.toString('base64'),
    _links: { self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${ref}`, git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blob.sha}`, html: `${base}/${repo.owner}/${repo.name}/blob/${ref}/${path}` },
  };
}

async function handleContents(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
  const query = queryOf(req);
  const ref = query.get('ref') ?? repo.defaultBranch;

  if (method === 'PUT') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const message = str(body, 'message');
    const branch = str(body, 'branch', repo.defaultBranch);
    const contentB64 = str(body, 'content').replace(/\s+/g, '');
    const content = Buffer.from(contentB64, 'base64');
    const tip = branchTip(repo, branch);
    if (tip === undefined && repo.refs.size > 0) { sendJson(res, 404, { message: 'Branch not found' }); return; }
    const tree = new Map(tip === undefined ? [] : tip.tree);
    const existing = tree.get(path);
    const expected = str(body, 'sha');
    if (existing !== undefined) {
      if (expected === '') { sendJson(res, 422, { message: `sha wasn't supplied` }); return; }
      if (expected !== existing.sha) { sendJson(res, 409, { message: `${path} does not match ${expected}` }); return; }
    }
    const blob: Blob = { sha: gitSha('blob', content), content };
    tree.set(path, blob);
    const commit = makeCommit(repo, tree, tip === undefined ? [] : [tip.sha], message === '' ? `Update ${path}` : message);
    repo.refs.set(`refs/heads/${branch}`, commit.sha);
    repo.updatedAt = nowIso(repo);
    sendJson(res, existing === undefined ? 201 : 200, {
      content: contentJson(repo, base, path, blob, branch),
      commit: { sha: commit.sha, node_id: `C_${commit.sha.slice(0, 8)}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${commit.sha}`, message: commit.message },
    });
    return;
  }

  if (method === 'GET') {
    const tree = treeAt(repo, ref);
    const blob = tree.get(path);
    if (blob !== undefined) { sendJson(res, 200, contentJson(repo, base, path, blob, ref)); return; }
    const children = new Map<string, Json>();
    for (const [name, child] of tree) {
      if (!name.startsWith(path === '' ? '' : `${path}/`)) continue;
      const rest = path === '' ? name : name.slice(path.length + 1);
      const [head, ...more] = rest.split('/');
      if (more.length === 0) children.set(head, contentJson(repo, base, name, child, ref));
      else if (!children.has(head)) children.set(head, { name: head, path: path === '' ? head : `${path}/${head}`, type: 'dir' });
    }
    if (children.size > 0) { sendJson(res, 200, [...children.values()]); return; }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (method === 'DELETE') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const tip = branchTip(repo, str(body, 'branch', repo.defaultBranch));
    if (tip === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const tree = new Map(tip.tree);
    const existing = tree.get(path);
    if (existing === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (str(body, 'sha') !== existing.sha) { sendJson(res, 409, { message: `${path} does not match ${str(body, 'sha')}` }); return; }
    tree.delete(path);
    const commit = makeCommit(repo, tree, [tip.sha], str(body, 'message', `Delete ${path}`));
    repo.refs.set(`refs/heads/${str(body, 'branch', repo.defaultBranch)}`, commit.sha);
    repo.updatedAt = nowIso(repo);
    sendJson(res, 200, { content: null, commit: { sha: commit.sha, node_id: `C_${commit.sha.slice(0, 8)}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${commit.sha}`, message: commit.message } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}// ---------------------------------------------------------------- REST: git data, branches, commits

async function handleGitData(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail[0] === 'refs' && tail.length === 1 && method === 'POST') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const ref = str(body, 'ref');
    const sha = str(body, 'sha');
    if (!ref.startsWith('refs/heads/')) { sendJson(res, 422, { message: 'Invalid reference format' }); return; }
    const commit = repo.commits.get(sha);
    if (commit === undefined) { sendJson(res, 422, { message: 'Object does not exist' }); return; }
    repo.refs.set(ref, sha);
    repo.updatedAt = nowIso(repo);
    sendJson(res, 201, { ref, node_id: `R_${sha.slice(0, 8)}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`, object: { type: 'commit', sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    return;
  }
  if (tail[0] === 'refs' && tail.length >= 2 && method === 'GET') {
    const ref = `refs/${tail.slice(1).map((s) => decodeURIComponent(s)).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { ref, node_id: `R_${sha.slice(0, 8)}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`, object: { type: 'commit', sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    return;
  }
  if (tail[0] === 'commits' && tail.length >= 1 && method === 'GET') {
    const sha = tail[1] === undefined ? undefined : decodeURIComponent(tail[1]);
    const commit = sha === undefined ? undefined : repo.commits.get(sha);
    if (sha !== undefined && commit === undefined) { sendJson(res, 404, { message: 'No commit found for SHA' }); return; }
    if (commit !== undefined) {
      sendJson(res, 200, { sha: commit.sha, node_id: `C_${commit.sha.slice(0, 8)}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commit.sha}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${commit.sha}`, author: { name: commit.author, email: `${commit.author}@example.invalid`, date: commit.createdAt }, committer: { name: commit.author, email: `${commit.author}@example.invalid`, date: commit.createdAt }, message: commit.message, tree: { sha: gitSha('tree', encodeTree(commit.tree)), url: '' }, parents: commit.parents.map((p) => ({ sha: p, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${p}` })) });
      return;
    }
  }
  if (tail[0] === 'blobs' && tail.length >= 2 && method === 'GET') {
    const blobSha = decodeURIComponent(tail[1]);
    const object = repo.objects.get(blobSha);
    if (object === undefined || object.type !== 'blob') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { sha: blobSha, node_id: `B_${blobSha.slice(0, 8)}`, size: object.content.length, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, content: object.content.toString('base64'), encoding: 'base64' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function handleBranches(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false, protection_url: '' }));
    sendJson(res, 200, branches);
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    const name = decodeURIComponent(tail[0]);
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (sha === undefined) { sendJson(res, 404, { message: 'Branch not found' }); return; }
    const commit = repo.commits.get(sha);
    sendJson(res, 200, { name, commit: { sha, commit: { message: commit?.message ?? '', author: { name: OWNER_LOGIN, date: commit?.createdAt ?? EPOCH } } }, protected: false, protection_url: '', _links: { html: `${base}/${repo.owner}/${repo.name}/tree/${name}`, self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/branches/${name}` } });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function handleCommits(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail.length === 0 && method === 'GET') {
    const query = queryOf(req);
    const sha = query.get('sha') ?? repo.defaultBranch;
    const tip = repo.commits.get(repo.refs.get(`refs/heads/${sha}`) ?? sha);
    const commits: Json[] = [];
    let current: Commit | undefined = tip;
    while (current !== undefined) {
      commits.push({ sha: current.sha, node_id: `C_${current.sha.slice(0, 8)}`, commit: { message: current.message, author: { name: current.author, email: `${current.author}@example.invalid`, date: current.createdAt }, committer: { name: current.author, email: `${current.author}@example.invalid`, date: current.createdAt }, tree: { sha: gitSha('tree', encodeTree(current.tree)) } }, parents: current.parents.map((p) => ({ sha: p })), html_url: `${base}/${repo.owner}/${repo.name}/commit/${current.sha}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${current.sha}` });
      const parent: Commit | undefined = current.parents.length === 0 ? undefined : repo.commits.get(current.parents[0]);
      current = parent;
    }
    const slice = paginate(req, res, base, commits, (page) => {
      const query2 = queryOf(req);
      query2.set('page', String(page));
      return `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits?${query2.toString()}`;
    });
    sendJson(res, 200, slice);
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    const commit = repo.commits.get(decodeURIComponent(tail[0]));
    if (commit === undefined) { sendJson(res, 404, { message: 'No commit found for SHA' }); return; }
    sendJson(res, 200, { sha: commit.sha, commit: { message: commit.message, author: { name: commit.author, email: `${commit.author}@example.invalid`, date: commit.createdAt } }, files: [] });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- REST: labels

async function handleLabels(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail.length === 0 && method === 'GET') {
    sendJson(res, 200, [...repo.labels.entries()].map(([name, color]) => ({ id: hashId(name), node_id: `L_${name}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${name}`, name, color, default: false, description: null })));
    return;
  }
  if (tail.length === 0 && method === 'POST') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const name = str(body, 'name').trim();
    if (name === '') { sendJson(res, 422, { message: 'Invalid request.' }); return; }
    const color = str(body, 'color', 'ededed').replace(/^#/, '');
    repo.labels.set(name, color);
    sendJson(res, 201, { id: hashId(name), node_id: `L_${name}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${name}`, name, color, default: false, description: typeof body.description === 'string' ? body.description : null });
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    const name = decodeURIComponent(tail[0]);
    const color = repo.labels.get(name);
    if (color === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { id: hashId(name), node_id: `L_${name}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${name}`, name, color, default: false, description: null });
    return;
  }
  if (tail.length === 1 && method === 'PATCH') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const name = decodeURIComponent(tail[0]);
    if (!repo.labels.has(name)) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : repo.labels.get(name);
    const nextName = typeof body.name === 'string' && body.name !== '' ? body.name : name;
    repo.labels.delete(name);
    repo.labels.set(nextName, color ?? 'ededed');
    sendJson(res, 200, { id: hashId(nextName), node_id: `L_${nextName}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${nextName}`, name: nextName, color, default: false, description: null });
    return;
  }
  if (tail.length === 1 && method === 'DELETE') {
    const name = decodeURIComponent(tail[0]);
    if (!repo.labels.delete(name)) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendEmpty(res, 200);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}// ---------------------------------------------------------------- REST: issues

async function handleIssues(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail.length === 0 && method === 'GET') {
    const query = queryOf(req);
    const state = query.get('state') ?? 'open';
    const items = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.number - b.number)
      .map((issue) => issueJson(repo, base, issue));
    const slice = paginate(req, res, base, items, (page) => {
      const q = queryOf(req); q.set('page', String(page));
      return `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues?${q.toString()}`;
    });
    sendJson(res, 200, slice);
    return;
  }
  if (tail.length === 0 && method === 'POST') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const title = str(body, 'title').trim();
    if (title === '') { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing' }] }); return; }
    const number = nextNumber(repo, 'issue');
    const issue: Issue = { number, title, body: str(body, 'body'), state: 'open', labels: Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [], assignees: [], createdAt: nowIso(repo), updatedAt: nowIso(repo), closedAt: null, kind: 'issue' };
    repo.issues.set(number, issue);
    sendJson(res, 201, issueJson(repo, base, issue));
    return;
  }
  if (tail.length >= 1 && tail[0] !== '' && /^\d+$/.test(tail[0])) {
    const number = Number.parseInt(tail[0], 10);
    const issue = repo.issues.get(number);
    if (issue === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 1 && method === 'GET') { sendJson(res, 200, issueJson(repo, base, issue)); return; }
    if (tail.length === 1 && method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso(repo) : null;
      }
      if (Array.isArray(body.labels)) issue.labels = body.labels.filter((l): l is string => typeof l === 'string');
      issue.updatedAt = nowIso(repo);
      sendJson(res, 200, issueJson(repo, base, issue));
      return;
    }
    if (tail.length === 2 && tail[1] === 'comments' && method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => ({ id: hashId(`${number}:${comment.id}`), node_id: `C_${comment.id}`, body: comment.body, user: { login: OWNER_LOGIN, id: VIEWER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`, html_url: `${base}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}` })));
      return;
    }
    if (tail.length === 2 && tail[1] === 'comments' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      const text = str(body, 'body');
      if (text === '') { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const comment: Comment = { id: hashId(`${number}:${text}:${issue.comments.length}`), body: text, createdAt: nowIso(repo) };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, node_id: `C_${comment.id}`, body: comment.body, user: { login: OWNER_LOGIN, id: VIEWER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`, html_url: `${base}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}` });
      return;
    }
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- REST: pulls

async function handlePulls(req: IncomingMessage, res: ServerResponse, base: string, repo: Repo, tail: string[], method: string): Promise<void> {
  if (tail.length === 0 && method === 'GET') {
    const query = queryOf(req);
    const state = query.get('state') ?? 'open';
    const items = [...repo.pulls.values()]
      .filter((pull) => state === 'all' || pull.state === state)
      .sort((a, b) => a.number - b.number)
      .map((pull) => pullJson(repo, base, pull));
    const slice = paginate(req, res, base, items, (page) => {
      const q = queryOf(req); q.set('page', String(page));
      return `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls?${q.toString()}`;
    });
    sendJson(res, 200, slice);
    return;
  }
  if (tail.length === 0 && method === 'POST') {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const title = str(body, 'title').trim();
    const head = str(body, 'head');
    const baseBranch = str(body, 'base');
    if (title === '' || head === '' || baseBranch === '') { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'missing' }] }); return; }
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }); return; }
    if (repo.refs.get(`refs/heads/${baseBranch}`) === undefined) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] }); return; }
    const number = nextNumber(repo, 'pull');
    const pull: Pull = { number, title, body: str(body, 'body'), state: 'open', head, base: baseBranch, headSha, baseSha: repo.refs.get(`refs/heads/${baseBranch}`) ?? '', draft: bool(body, 'draft', false), merged: false, mergedAt: null, mergeCommitSha: null, createdAt: nowIso(repo), updatedAt: nowIso(repo) };
    repo.pulls.set(number, pull);
    sendJson(res, 201, pullJson(repo, base, pull));
    return;
  }
  if (tail.length >= 1 && /^\d+$/.test(tail[0])) {
    const number = Number.parseInt(tail[0], 10);
    const pull = repo.pulls.get(number);
    if (pull === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 1 && method === 'GET') { sendJson(res, 200, pullJson(repo, base, pull)); return; }
    if (tail.length === 1 && method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      if (typeof body.draft === 'boolean') pull.draft = body.draft;
      pull.updatedAt = nowIso(repo);
      sendJson(res, 200, pullJson(repo, base, pull));
      return;
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (pull.state !== 'open') { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return; }
      const headTip = repo.commits.get(pull.headSha);
      const baseTip = repo.commits.get(pull.baseSha);
      if (headTip === undefined || baseTip === undefined) { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return; }
      const tree = new Map(baseTip.tree);
      for (const [path, blob] of headTip.tree) tree.set(path, blob);
      const message = str(body, 'commit_message', `Merge pull request #${number}`);
      const commit = makeCommit(repo, tree, [pull.baseSha, pull.headSha], message);
      repo.refs.set(`refs/heads/${pull.base}`, commit.sha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso(repo);
      pull.mergeCommitSha = commit.sha;
      pull.updatedAt = nowIso(repo);
      repo.updatedAt = nowIso(repo);
      sendJson(res, 200, { sha: commit.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    if (tail.length === 2 && tail[1] === 'comments' && method === 'GET') {
      sendJson(res, 200, pull.comments.map((comment) => ({ id: comment.id, node_id: `C_${comment.id}`, body: comment.body, user: { login: OWNER_LOGIN, id: VIEWER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments/${comment.id}` })));
      return;
    }
    if (tail.length === 2 && tail[1] === 'comments' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      const text = str(body, 'body');
      if (text === '') { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const comment: Comment = { id: hashId(`${number}:${text}:${pull.comments.length}`), body: text, createdAt: nowIso(repo) };
      pull.comments.push(comment);
      sendJson(res, 201, { id: comment.id, node_id: `C_${comment.id}`, body: comment.body, user: { login: OWNER_LOGIN, id: VIEWER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments/${comment.id}` });
      return;
    }
  }
  sendJson(res, 404, { message: 'Not Found' });
}// ---------------------------------------------------------------- git smart HTTP

const ZERO_OID = '0'.repeat(40);
const GIT_OBJECT_FORMAT = 'sha1';

function pkt(data: string): Buffer {
  const body = Buffer.from(data, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const chunks: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') chunks.push(pktFlush());
    else if (line === 'delim') chunks.push(pktDelim());
    else chunks.push(pkt(line));
  }
  return Buffer.concat(chunks);
}

/** Reads pkt-lines from a buffer, returning the data payloads and where parsing stopped. */
function readPktLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const len = Number.parseInt(hex, 16);
    if (len === 0) { pos += 4; continue; }
    if (len === 1) { pos += 4; continue; }
    if (len === 2) { pos += 4; break; }
    if (pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, rest: buf.subarray(pos) };
}

// ---------------------------------------------------------------- packfiles

type PackObject = { type: 'commit' | 'tree' | 'blob' | 'tag'; body: Buffer };

function objectTypeNumber(type: PackObject['type']): number {
  if (type === 'commit') return 1;
  if (type === 'tree') return 2;
  if (type === 'blob') return 3;
  return 4;
}

function objectTypeFromNumber(value: number): PackObject['type'] | null {
  if (value === 1) return 'commit';
  if (value === 2) return 'tree';
  if (value === 3) return 'blob';
  if (value === 4) return 'tag';
  return null;
}

function encodeObjectHeader(type: PackObject['type'], size: number): Buffer {
  const kind = objectTypeNumber(type);
  let first = (size & 0x0f) | (kind << 4) | 0x80;
  const bytes: number[] = [];
  let remaining = size >> 4;
  while (remaining > 0) {
    bytes.push(first);
    first = (remaining & 0x7f) | 0x80;
    remaining >>= 7;
  }
  bytes.push(first & 0x7f);
  return Buffer.from(bytes);
}

/** Builds a complete, non-delta packfile with a trailing SHA-1 checksum. */
function buildPack(objects: readonly PackObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  chunks.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  chunks.push(count);
  for (const object of objects) {
    chunks.push(encodeObjectHeader(object.type, object.body.length));
    chunks.push(deflateSync(object.body));
  }
  const body = Buffer.concat(chunks);
  const checksum = sha1(body);
  return Buffer.concat([body, Buffer.from(checksum, 'hex')]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length && produced < targetSize) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
      continue;
    }
    if (op === 0) throw new Error('delta opcode 0 is reserved');
    out.push(delta.subarray(pos, pos + op));
    pos += op;
    produced += op;
  }
  return Buffer.concat(out);
}

/** Parses a packfile into objects, resolving ofs-delta and ref-delta chains. */
function parsePack(pack: Buffer): Map<string, PackObject> {
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  const pending: Array<{ offset: number; kind: number; body: Buffer; baseRef: string | null; baseOffset: number | null }> = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    let byte = pack[pos];
    pos += 1;
    const kind = (byte >> 4) & 0x07;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos];
      pos += 1;
    }
    let baseRef: string | null = null;
    let baseOffset: number | null = null;
    if (kind === 6) {
      let value = pack[pos];
      pos += 1;
      let rel = value & 0x7f;
      while ((value & 0x80) !== 0) {
        value = pack[pos];
        pos += 1;
        rel = ((rel + 1) << 7) | (value & 0x7f);
      }
      baseOffset = offset - rel;
    } else if (kind === 7) {
      baseRef = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    pos += inflated.engine.bytesWritten;
    const body = Buffer.from(inflated.buffer);
    if (kind === 6 || kind === 7) {
      pending.push({ offset, kind, body, baseRef, baseOffset });
      continue;
    }
    const type = objectTypeFromNumber(kind);
    if (type === null) throw new Error(`bad object type ${kind}`);
    const object: PackObject = { type, body };
    objects.set(gitSha(type, body), object);
    byOffset.set(offset, object);
  }
  for (const entry of pending) {
    let base: PackObject | undefined;
    if (entry.baseRef !== null) base = objects.get(entry.baseRef);
    else if (entry.baseOffset !== null) base = byOffset.get(entry.baseOffset);
    if (base === undefined) throw new Error('delta base object is missing from the pack');
    const merged = applyDelta(base.body, entry.body);
    const object: PackObject = { type: base.type, body: merged };
    objects.set(gitSha(base.type, merged), object);
    byOffset.set(entry.offset, object);
  }
  return objects;
}

// ---------------------------------------------------------------- git advertisement

function advertisementFor(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  if (service === 'git-upload-pack') {
    const lines: string[] = [`# service=git-upload-pack\n`, '0000'];
    const caps = [
      'multi_ack',
      'multi_ack_detailed',
      'side-band-64k',
      'thin-pack',
      'ofs-delta',
      'no-progress',
      'include-tag',
      `agent=github-core-clone/1.0`,
      `object-format=${GIT_OBJECT_FORMAT}`,
      'symrefs',
      'ls-refs=unborn symrefs',
      'fetch=shallow filter',
    ];
    lines.push(`version 2\n`);
    for (const cap of caps) lines.push(`${cap}\n`);
    lines.push('0000');
    return encodePktLines(lines);
  }
  const caps = [
    'report-status',
    'report-status-v2',
    'delete-refs',
    'side-band-64k',
    'quiet',
    'atomic',
    'ofs-delta',
    `agent=github-core-clone/1.0`,
    `object-format=${GIT_OBJECT_FORMAT}`,
    'symrefs',
  ];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const head = repo.refs.get('HEAD') ?? '';
  const lines: string[] = [`# service=git-receive-pack\n`, '0000'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`);
  } else {
    refs.forEach(([name, oid], index) => {
      const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
      lines.push(`${oid} ${name}${suffix}\n`);
    });
    if (head !== '') lines.push(`${head} HEAD symref=HEAD:${repo.refs.has('main') ? 'refs/heads/main' : [...repo.refs.keys()][0]}\n`);
  }
  lines.push('0000');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- git upload-pack

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = Buffer.concat(chunks);
  const { lines } = readPktLines(request);
  const command = (lines[0] ?? '').trim();
  const gitProtocol = req.headers['git-protocol'];
  const wants: string[] = [];
  const haves: string[] = [];
  const deepens: number[] = [];
  let filter = '';
  for (const line of lines.slice(1)) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) deepens.push(Number.parseInt(line.slice(7).trim(), 10));
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
  }
  if (command === 'command=ls-refs') {
    const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11).trim());
    const out: Buffer[] = [];
    const refs = [...repo.refs.entries()].filter(([name]) => name !== 'HEAD');
    for (const [name, oid] of refs) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const symref = name === 'HEAD' ? '' : '';
      out.push(pkt(`${oid} ${name}${symref}\n`));
    }
    const headTarget = repo.refs.get('HEAD');
    if (headTarget === undefined && prefixes.length === 0) {
      const main = repo.refs.get('refs/heads/main');
      if (main === undefined) out.push(pkt(`unborn HEAD refs/heads/main\n`));
    }
    out.push(pktFlush());
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
    res.end(Buffer.concat(out));
    return;
  }
  if (command === 'command=fetch') {
    const out: Buffer[] = [];
    out.push(pkt('acknowledgments\n'));
    if (haves.length === 0) out.push(pkt('NAK\n'));
    else for (const have of haves) out.push(pkt(`ACK ${have}\n`));
    out.push(pktFlush());
    out.push(pkt('shallow-info\n'));
    out.push(pktFlush());
    out.push(pkt('packfile\n'));
    const objects = collectForWants(repo, wants);
    const pack = buildPack(objects);
    const CHUNK = 32768;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, offset + CHUNK);
      out.push(pkt(Buffer.concat([Buffer.from([1]), slice]).toString('latin1')));
    }
    if (pack.length === 0) out.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)]).toString('latin1')));
    out.push(pktFlush());
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
    res.end(Buffer.concat(out));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.end(pktFlush());
}

/** Collects every object reachable from the wanted commits, for a clone packfile. */
function collectForWants(repo: Repo, wants: readonly string[]): PackObject[] {
  const seen = new Set<string>();
  const out: PackObject[] = [];
  const visit = (sha: string): void => {
    if (seen.has(sha)) return;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined) return;
    out.push(object);
    if (object.type === 'commit') {
      const commit = parseCommitBody(object.body.toString('utf8'));
      for (const parent of commit.parents) visit(parent);
      visit(commit.tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeBody(object.body)) visit(entry.oid);
    }
  };
  for (const want of wants) visit(want);
  return out;
}

function parseCommitBody(body: string): { tree: string; parents: string[] } {
  const lines = body.split('\n');
  let tree = '';
  const parents: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line === '') break;
  }
  return { tree, parents };
}

function parseTreeBody(body: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.subarray(pos).indexOf(' ');
    if (space < 0) break;
    const mode = body.subarray(pos, pos + space).toString('ascii');
    pos += space + 1;
    const nul = body.subarray(pos).indexOf(0);
    if (nul < 0) break;
    const name = body.subarray(pos, pos + nul).toString('utf8');
    pos += nul + 1;
    const oid = body.subarray(pos, pos + 20).toString('hex');
    pos += 20;
    entries.push({ mode, name, oid });
  }
  return entries;
}

// ---------------------------------------------------------------- git receive-pack

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = Buffer.concat(chunks);
  const { lines, rest } = readPktLines(request);
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.includes('report-status') || trimmed.includes('delete-refs')) continue;
    const [oldOid, nextOid, ref] = trimmed.split(' ');
    if (oldOid === undefined || nextOid === undefined || ref === undefined) continue;
    commands.push({ old: oldOid, next: nextOid, ref });
  }
  const packStart = rest;
  let objects = new Map<string, PackObject>();
  if (packStart.subarray(0, 4).toString('ascii') === 'PACK') {
    objects = parsePack(packStart);
  }
  const report: string[] = ['unpack ok\n'];
  let rejected = false;
  for (const command of commands) {
    const isDelete = command.next === ZERO_OID;
    if (isDelete) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const object = objects.get(command.next);
    if (object === undefined) {
      report.push(`ng ${command.ref} missing necessary objects\n`);
      rejected = true;
      continue;
    }
    for (const [sha, value] of objects) repo.objects.set(sha, value);
    if (object.type === 'commit') {
      const tree = flattenTree(objects, parseCommitBody(object.body.toString('utf8')).tree);
      const commit = makeCommitFromBody(repo, object.body.toString('utf8'), tree);
      repo.commits.set(commit.sha, commit);
    }
    repo.refs.set(command.ref, command.next);
    repo.updatedAt = nowIso(repo);
    report.push(`ok ${command.ref}\n`);
  }
  const out: Buffer[] = [];
  out.push(pkt(report.join('')));
  out.push(pktFlush());
  if (rejected) {
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
    res.end(Buffer.concat(out));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(out));
}

/** Turns a tree object graph into the flat path-to-blob map the store keeps. */
function flattenTree(objects: Map<string, PackObject>, rootSha: string): Map<string, Blob> {
  const tree = new Map<string, Blob>();
  const walk = (sha: string, prefix: string): void => {
    const object = objects.get(sha);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTreeBody(object.body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') {
        walk(entry.oid, path);
        continue;
      }
      const blob = objects.get(entry.oid);
      tree.set(path, { oid: entry.oid, content: blob === undefined ? '' : blob.body.toString('utf8') });
    }
  };
  walk(rootSha, '');
  return tree;
}

function makeCommitFromBody(repo: Repo, body: string, tree: Map<string, Blob>): Commit {
  const parsed = parseCommitBody(body);
  const createdAt = nowIso(repo);
  return { sha: gitSha('commit', Buffer.from(body, 'utf8')), parents: parsed.parents, message: body.split('\n\n').slice(1).join('\n\n').trim(), tree, author: OWNER_LOGIN, createdAt };
}// ---------------------------------------------------------------- MCP

type McpTool = (args: Record<string, unknown>) => Promise<unknown> | unknown;

function argStr(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function argBool(args: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return false;
}

function argNum(args: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return NaN;
}

function mcpRepo(owner: string, name: string): Repo {
  const repo = repos.get(repoKey(owner, name));
  if (!repo) throw new Error(`repository not found: ${owner}/${name}`);
  return repo;
}

function mcpIssue(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = { number: repo.nextIssue++, title, body, state: 'open', labels: [], comments: [], createdAt: nowIso(repo) };
  repo.issues.set(issue.number, issue);
  repo.updatedAt = nowIso(repo);
  return issue;
}

function mergePull(repo: Repo, pull: Pull): string {
  const headTip = repo.commits.get(pull.headSha);
  const baseTip = repo.commits.get(pull.baseSha);
  if (headTip === undefined || baseTip === undefined) throw new Error('Pull Request is not mergeable');
  const tree = new Map(baseTip.tree);
  for (const [path, blob] of headTip.tree) tree.set(path, blob);
  const commit = makeCommit(repo, tree, [pull.baseSha, pull.headSha], `Merge pull request #${pull.number}`);
  repo.refs.set(`refs/heads/${pull.base}`, commit.sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso(repo);
  pull.mergeCommitSha = commit.sha;
  pull.updatedAt = nowIso(repo);
  repo.updatedAt = nowIso(repo);
  return commit.sha;
}

function mcpPull(repo: Repo, title: string, head: string, base: string, body: string): Pull {
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: repo.refs.get(`refs/heads/${head}`) ?? '',
    baseSha: repo.refs.get(`refs/heads/${base}`) ?? '',
    merged: false,
    createdAt: nowIso(repo),
  };
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = nowIso(repo);
  return pull;
}

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; run: McpTool }> = [
  {
    name: 'create_repository',
    description: 'Create a new repository.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, private: { type: 'boolean' }, description: { type: 'string' } }, required: ['name'] },
    run: (args) => {
      const name = argStr(args, ['name', 'repo', 'repo_name', 'repository_name', 'project_name']);
      const created = newRepo(OWNER_LOGIN, name, argStr(args, ['description']), argBool(args, ['private', 'is_private']));
      return repoJson(created, 'http://localhost');
    },
  },
  {
    name: 'get_repository',
    description: 'Get repository metadata.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    run: (args) => {
      const repo = mcpRepo(argStr(args, ['owner', 'owner_name', 'owner_login']), argStr(args, ['repo', 'repo_name', 'repository_name', 'repo_slug', 'project_name']));
      return repoJson(repo, 'http://localhost');
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
    run: (args) => {
      const repo = mcpRepo(argStr(args, ['owner', 'owner_name', 'owner_login']), argStr(args, ['repo', 'repo_name', 'repository_name', 'repo_slug', 'project_name']));
      const issue = mcpIssue(repo, argStr(args, ['title', 'issue_title']), argStr(args, ['body', 'issue_body']));
      return issueJson(repo, issue, 'http://localhost');
    },
  },
  {
    name: 'list_issues',
    description: 'List issues.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    run: (args) => {
      const repo = mcpRepo(argStr(args, ['owner', 'owner_name', 'owner_login']), argStr(args, ['repo', 'repo_name', 'repository_name', 'repo_slug', 'project_name']));
      return [...repo.issues.values()].map((issue) => issueJson(repo, issue, 'http://localhost'));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (args) => {
      const repo = mcpRepo(argStr(args, ['owner', 'owner_name', 'owner_login']), argStr(args, ['repo', 'repo_name', 'repository_name', 'repo_slug', 'project_name']));
      const pull = mcpPull(repo, argStr(args, ['title', 'pr_title', 'pull_request_title']), argStr(args, ['head', 'head_branch', 'head_ref', 'source_branch', 'source_ref', 'pr_head', 'pull_request_head']), argStr(args, ['base', 'base_branch', 'base_ref', 'target_branch', 'target_ref', 'pr_base', 'pull_request_base']), argStr(args, ['body', 'pr_body', 'pull_request_body']));
      return pullJson(repo, pull, 'http://localhost');
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
    run: (args) => {
      const repo = mcpRepo(argStr(args, ['owner', 'owner_name', 'owner_login']), argStr(args, ['repo', 'repo_name', 'repository_name', 'repo_slug', 'project_name']));
      const number = argNum(args, ['pull_number', 'pr_number', 'number', 'issue_number']);
      const pull = [...repo.pulls.values()].find((candidate) => candidate.number === number);
      if (!pull) throw new Error('pull request not found');
      mergePull(repo, pull);
      return { sha: pull.mergeCommitSha ?? '', merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

const MCP_TOOL_ALIASES: Record<string, string> = {
  create_repo: 'create_repository',
  create_repository: 'create_repository',
  repos_create: 'create_repository',
  repository_create: 'create_repository',
  repo_create: 'create_repository',
  get_repo: 'get_repository',
  get_repository: 'get_repository',
  repos_get: 'get_repository',
  repository_get: 'get_repository',
  repo_get: 'get_repository',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  create_issue: 'create_issue',
  issue_list: 'list_issues',
  issues_list: 'list_issues',
  list_issues: 'list_issues',
  pr_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pull_request: 'create_pull_request',
  pull_request_create: 'create_pull_request',
  pr_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pull_request: 'merge_pull_request',
  pull_request_merge: 'merge_pull_request',
};

function mcpRpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const method = String(message.method ?? '');
  const id = message.id ?? null;
  const params = (message.params ?? {}) as Record<string, unknown>;

  if (method === 'initialize') {
    sendJson(res, 200, mcpRpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'Content-Type': JSON_TYPE });
    res.end();
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpRpc(id, {
      tools: MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    }));
    return;
  }
  if (method === 'tools/call') {
    const requested = String(params.name ?? '');
    const canonical = MCP_TOOL_ALIASES[requested] ?? requested;
    const tool = MCP_TOOLS.find((candidate) => candidate.name === canonical);
    if (!tool) {
      sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${requested}`));
      return;
    }
    try {
      const result = await tool.run((params.arguments ?? {}) as Record<string, unknown>);
      sendJson(res, 200, mcpRpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }));
    } catch (err) {
      sendJson(res, 200, mcpRpc(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }));
    }
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------- app wiring

import { graphqlQuery } from './graphql.ts';

function parseGitPath(path: string): { owner: string; name: string; endpoint: string } | null {
  const match = /^\/([^/]+)\/(.+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) return null;
  return { owner: match[1], name: match[2], endpoint: match[3] };
}

async function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: { owner: string; name: string; endpoint: string },
): Promise<void> {
  const repo = repos.get(repoKey(route.owner, route.name));
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Repository not found' });
    return;
  }
  const token = bearerOf(req);
  if (repo.isPrivate === true && token === undefined) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
    res.end('authentication required');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://entry');
  if (route.endpoint === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'invalid service' });
      return;
    }
    const body = advertisementFor(repo, service);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' });
    return;
  }
  if (route.endpoint === 'git-upload-pack') await handleUploadPack(req, res, repo);
  else await handleReceivePack(req, res, repo);
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' });
    return;
  }
  const body = await readJson(req, res);
  const query = typeof body['query'] === 'string' ? body['query'] : '';
  const token = bearerOf(req);
  const deps = {
    viewerLogin: token ?? 'adaiversen',
    repos,
    repoKey,
    newRepo,
    repoJson,
    issueJson,
    pullJson,
    mcpRepo,
    mcpIssue,
    mcpPull,
    mergePull,
    nowIso,
  };
  const result = graphqlQuery(query, deps as never, 'http://localhost');
  sendJson(res, 200, result);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://entry').pathname;
  if (process.env.FORGE_DEBUG === '1') {
    try {
      appendFileSync(
        process.env.FORGE_DEBUG_LOG ?? 'forge-debug.log',
        `${req.method ?? 'GET'} ${path}\n`,
      );
    } catch {}
  }
  if (path === '/healthz' || path === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/graphql' || path === '/graphql') {
    await handleGraphQL(req, res);
    return;
  }
  if (path === '/mcp' || path === '/mcp/' || path === '/api/mcp') {
    await handleMcp(req, res);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, path);
    return;
  }
  const git = parseGitPath(path);
  if (git !== null) {
    await handleGitRoute(req, res, git);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  return createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    });
  });
}

// A small GraphQL v4 subset: enough of the schema for the contest's checks.
// Hand-rolled (no dependencies): tokenizer -> parser -> executor over the REST store.

type Tok = { kind: 'name' | 'int' | 'float' | 'string' | 'punct'; value: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ',') { i += 1; continue; }
    if (/\s|,|\ufeff/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if ('{}():![]=@|&'.includes(ch)) { out.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { out.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if (ch === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        out.push({ kind: 'string', value: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      out.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      out.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

interface Field {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selection?: Selection[];
}

type Selection = Field;

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok { const t = this.toks[this.pos]; this.pos += 1; return t ?? { kind: 'punct', value: '' }; }
  private eat(value: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.value === value) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): { operation: 'query' | 'mutation'; fields: Selection[] } {
    let operation: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== undefined && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const name = this.peek();
      if (name !== undefined && name.kind === 'name' && name.value !== 'on') this.next();
      if (this.eat('(')) this.skipBalanced('(', ')');
      if (this.eat('@')) { this.next(); if (this.eat('(')) this.skipBalanced('(', ')'); }
    }
    return { operation, fields: this.parseSelectionSet() };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.value === '') return;
      if (t.value === open) depth += 1;
      else if (t.value === close) depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    const fields: Selection[] = [];
    if (!this.eat('{')) return fields;
    while (true) {
      const t = this.peek();
      if (t === undefined || t.value === '') return fields;
      if (t.value === '}') { this.next(); return fields; }
      if (t.value === '...') {
        this.next();
        const inline = this.peek();
        if (inline !== undefined && inline.value === 'on') this.next();
        const nameTok = this.peek();
        if (nameTok !== undefined && nameTok.kind === 'name') this.next();
        if (this.peek()?.value === '@') { this.next(); if (this.eat('(')) this.skipBalanced('(', ')'); }
        const inner = this.parseSelectionSet();
        fields.push({ alias: '__inline', name: '__inline', args: {}, selection: inner });
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') continue;
      let alias = first.value;
      let name = first.value;
      if (this.eat(':')) {
        alias = first.value;
        name = this.next().value;
      }
      const args: Record<string, unknown> = {};
      if (this.eat('(')) {
        while (true) {
          const key = this.peek();
          if (key === undefined || key.value === '' || key.value === ')') { this.eat(')'); break; }
          this.next();
          if (!this.eat(':')) { this.skipValue(); continue; }
          args[key.value] = this.parseValue();
        }
      }
      if (this.peek()?.value === '@') { this.next(); if (this.eat('(')) this.skipBalanced('(', ')'); }
      let selection: Selection[] | undefined;
      if (this.peek()?.value === '{') selection = this.parseSelectionSet();
      fields.push({ alias, name, args, selection });
    }
  }

  private skipValue(): void {
    const t = this.next();
    if (t.value === '{' || t.value === '[' || t.value === '(') {
      const close = t.value === '{' ? '}' : t.value === '[' ? ']' : ')';
      this.skipBalanced(t.value, close);
    }
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return Number(t.value);
    if (t.kind === 'float') return Number(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value;
    }
    if (t.value === '[') {
      const list: unknown[] = [];
      while (true) {
        const n = this.peek();
        if (n === undefined || n.value === '' || n.value === ']') { this.eat(']'); break; }
        list.push(this.parseValue());
      }
      return list;
    }
    if (t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const k = this.peek();
        if (k === undefined || k.value === '' || k.value === '}') { this.eat('}'); break; }
        this.next();
        if (!this.eat(':')) { this.skipValue(); continue; }
        obj[k.value] = this.parseValue();
      }
      return obj;
    }
    return null;
  }
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const direct = args['input'];
  if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
  return args;
}

function strOf(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function boolOf(obj: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return false;
}

function numOf(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return NaN;
}

export interface GraphQLDeps {
  viewerLogin: string;
  repos: Map<string, unknown>;
  repoKey(owner: string, name: string): string;
  newRepo(owner: string, name: string, description: string, isPrivate: boolean): any;
  repoJson(repo: any, base: string): any;
  issueJson(repo: any, issue: any, base: string): any;
  pullJson(repo: any, pull: any, base: string): any;
  mcpRepo(owner: string, name: string): any;
  mcpIssue(repo: any, title: string, body: string): any;
  mcpPull(repo: any, title: string, head: string, base: string, body: string): any;
  mergePull(repo: any, pull: any): string;
  nowIso(repo?: any): string;
}

function nodeId(kind: string, key: string): string {
  return `node_${kind}_${Buffer.from(key).toString('hex').slice(0, 16)}`;
}

function decodeId(id: string): string {
  return Buffer.from(id.replace(/^node_[a-z]+_/, ''), 'hex').toString('utf8');
}

function repoRef(repo: any): string {
  return `${repo.owner}/${repo.name}`;
}

function repoFields(repo: any, deps: GraphQLDeps, base: string): Record<string, unknown> {
  const full = repoRef(repo);
  const json = deps.repoJson(repo, base);
  return {
    ...json,
    id: nodeId('repository', full),
    databaseId: repo.id ?? 0,
    nameWithOwner: full,
    owner: { login: repo.owner, id: nodeId('user', repo.owner), __typename: 'User' },
    isPrivate: repo.isPrivate === true,
    isFork: false,
    isArchived: false,
    isEmpty: (repo.commits?.size ?? 0) === 0,
    description: repo.description ?? '',
    homepageUrl: '',
    url: `${base}/${full}`,
    defaultBranchRef: repo.refs?.has('refs/heads/main')
      ? { name: 'main', id: nodeId('branch', `${full}#main`), prefix: 'refs/heads/', target: { oid: repo.refs.get('refs/heads/main'), __typename: 'Commit' } }
      : null,
    refs: null,
    issues: null,
    pullRequests: null,
    __typename: 'Repository',
  };
}

function issueFields(issue: any, repo: any, deps: GraphQLDeps, base: string): Record<string, unknown> {
  const json = deps.issueJson(repo, issue, base);
  return {
    ...json,
    id: nodeId('issue', `${repoRef(repo)}#${issue.number}`),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    stateReason: issue.state === 'closed' ? 'COMPLETED' : null,
    author: { login: issue.author ?? deps.viewerLogin, id: nodeId('user', issue.author ?? deps.viewerLogin), __typename: 'User' },
    repository: repoFields(repo, deps, base),
    url: `${base}/${repoRef(repo)}/issues/${issue.number}`,
    labels: { nodes: (issue.labels ?? []).map((label: string) => ({ name: label, id: nodeId('label', label) })) },
    comments: { nodes: (issue.comments ?? []).map((c: any) => ({ id: nodeId('comment', String(c.id)), body: c.body, author: { login: c.author ?? deps.viewerLogin } })) },
    __typename: 'Issue',
  };
}

function pullFields(pull: any, repo: any, deps: GraphQLDeps, base: string): Record<string, unknown> {
  const json = deps.pullJson(repo, pull, base);
  return {
    ...json,
    id: nodeId('pullrequest', `${repoRef(repo)}#${pull.number}`),
    databaseId: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged === true,
    isDraft: false,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { name: pull.head, id: nodeId('branch', `${repoRef(repo)}#${pull.head}`) },
    baseRef: { name: pull.base, id: nodeId('branch', `${repoRef(repo)}#${pull.base}`) },
    author: { login: pull.author ?? deps.viewerLogin, id: nodeId('user', pull.author ?? deps.viewerLogin), __typename: 'User' },
    repository: repoFields(repo, deps, base),
    url: `${base}/${repoRef(repo)}/pull/${pull.number}`,
    mergeCommit: pull.mergeCommitSha ? { oid: pull.mergeCommitSha, id: nodeId('commit', pull.mergeCommitSha) } : null,
    __typename: 'PullRequest',
  };
}

function resolveField(
  source: any,
  field: Field,
  deps: GraphQLDeps,
  base: string,
): unknown {
  const name = field.name;
  if (source === null || source === undefined) return null;
  if (name === '__typename') return typeof source.__typename === 'string' ? source.__typename : 'Object';
  if (name === 'id') return source.id ?? null;
  if (name === 'databaseId') return source.databaseId ?? null;
  if (name === 'number') return source.number ?? null;
  if (name === 'title') return source.title ?? null;
  if (name === 'body') return source.body ?? null;
  if (name === 'name') return source.name ?? null;
  if (name === 'nameWithOwner') return source.nameWithOwner ?? null;
  if (name === 'login') return source.login ?? null;
  if (name === 'oid') return source.oid ?? null;
  if (name === 'message') return source.message ?? null;
  if (name === 'state') return source.state ?? null;
  if (name === 'merged') return source.merged ?? null;
  if (name === 'isPrivate') return source.isPrivate ?? null;
  if (name === 'isMerged') return source.merged ?? null;
  if (name === 'url') return source.url ?? null;
  if (name === 'description') return source.description ?? null;
  if (name === 'headRefName') return source.headRefName ?? null;
  if (name === 'baseRefName') return source.baseRefName ?? null;
  if (name === 'headRef') return source.headRef ?? null;
  if (name === 'baseRef') return source.baseRef ?? null;
  if (name === 'author') return source.author ?? null;
  if (name === 'repository') return source.repository ?? null;
  if (name === 'mergeCommit') return source.mergeCommit ?? null;
  if (name === 'defaultBranchRef') return source.defaultBranchRef ?? null;
  if (name === 'target') return source.target ?? null;
  if (name === 'prefix') return source.prefix ?? null;
  if (name === 'labels') return source.labels ?? null;
  if (name === 'comments') return source.comments ?? null;
  if (name === 'nodes') return source.nodes ?? [];
  if (name === 'edges') return source.edges ?? [];
  if (name === 'node') return source.node ?? null;
  if (name === 'createdAt') return source.createdAt ?? null;
  if (name === 'updatedAt') return source.updatedAt ?? null;
  if (name === 'viewer') return { login: deps.viewerLogin, id: nodeId('user', deps.viewerLogin), __typename: 'User' };
  if (name === 'rateLimit') return { cost: 1, remaining: 5000, limit: 5000, used: 0 };
  return source[name] ?? null;
}

function executeSelection(
  value: unknown,
  selection: Selection[] | undefined,
  deps: GraphQLDeps,
  base: string,
): unknown {
  if (value === null || value === undefined || selection === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => executeSelection(item, selection, deps, base));
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === '__inline') {
      const inner = executeSelection(obj, field.selection, deps, base) as Record<string, unknown>;
      Object.assign(out, inner);
      continue;
    }
    const resolved = resolveField(obj, field, deps, base);
    out[field.alias] = executeSelection(resolved, field.selection, deps, base);
  }
  return out;
}

function rootResolve(
  field: Field,
  deps: GraphQLDeps,
  base: string,
): unknown {
  const args = field.args;
  switch (field.name) {
    case 'viewer':
      return { login: deps.viewerLogin, id: nodeId('user', deps.viewerLogin), __typename: 'User' };
    case 'rateLimit':
      return { cost: 1, remaining: 5000, limit: 5000, used: 0 };
    case 'repository': {
      const owner = strOf(args, ['owner']);
      const name = strOf(args, ['name']);
      const repo = deps.repos.get(deps.repoKey(owner, name));
      if (repo === undefined) return null;
      return repoFields(repo, deps, base);
    }
    case 'repositories':
      return [...deps.repos.values()].map((repo) => repoFields(repo, deps, base));
    case 'node': {
      const id = strOf(args, ['id']);
      const decoded = decodeId(id);
      const [owner, name] = decoded.split('/');
      const repo = deps.repos.get(deps.repoKey(owner, name));
      return repo === undefined ? null : repoFields(repo, deps, base);
    }
    case 'createRepository':
    case 'createRepo': {
      const input = inputOf(args);
      const name = strOf(input, ['name']);
      const owner = strOf(input, ['owner', 'ownerName', 'ownerLogin']) || deps.viewerLogin;
      const existing = deps.repos.get(deps.repoKey(owner, name));
      const repo = existing ?? deps.newRepo(owner, name, strOf(input, ['description']), boolOf(input, ['private', 'isPrivate', 'visibility']) || strOf(input, ['visibility']).toUpperCase() === 'PRIVATE');
      return { repository: repoFields(repo, deps, base) };
    }
    case 'createIssue':
    case 'createIssueInput': {
      const input = inputOf(args);
      const repoId = strOf(input, ['repositoryId']);
      const decoded = repoId ? decodeId(repoId) : '';
      const [owner, name] = decoded.includes('/') ? decoded.split('/') : [deps.viewerLogin, ''];
      const repo = deps.repos.get(deps.repoKey(owner, name));
      if (repo === undefined) return null;
      const issue = deps.mcpIssue(repo, strOf(input, ['title']), strOf(input, ['body']));
      return { issue: issueFields(issue, repo, deps, base) };
    }
    case 'createPullRequest':
    case 'createPullRequestInput': {
      const input = inputOf(args);
      const repoId = strOf(input, ['repositoryId']);
      const decoded = repoId ? decodeId(repoId) : '';
      const [owner, name] = decoded.includes('/') ? decoded.split('/') : [deps.viewerLogin, ''];
      const repo = deps.repos.get(deps.repoKey(owner, name));
      if (repo === undefined) return null;
      const pull = deps.mcpPull(repo, strOf(input, ['title']), strOf(input, ['headRefName', 'head', 'headRef', 'sourceBranch']), strOf(input, ['baseRefName', 'base', 'baseRef', 'targetBranch']), strOf(input, ['body']));
      return { pullRequest: pullFields(pull, repo, deps, base) };
    }
    case 'mergePullRequest':
    case 'mergePullRequestInput': {
      const input = inputOf(args);
      const pullId = strOf(input, ['pullRequestId']);
      const decoded = pullId ? decodeId(pullId) : '';
      const [owner, name] = decoded.includes('/') ? decoded.split('/') : [deps.viewerLogin, ''];
      const repo = deps.repos.get(deps.repoKey(owner, name));
      if (repo === undefined) return null;
      const number = numOf(input, ['number', 'pullNumber']);
      const pull = repo.pulls.find((candidate: any) => candidate.number === number);
      if (pull === undefined) return null;
      deps.mergePull(repo, pull);
      return { pullRequest: pullFields(pull, repo, deps, base) };
    }
    case 'addIssueComment':
    case 'addComment': {
      const input = inputOf(args);
      const subjectId = strOf(input, ['subjectId']);
      const decoded = subjectId ? decodeId(subjectId) : '';
      const [owner, name] = decoded.includes('/') ? decoded.split('/') : [deps.viewerLogin, ''];
      const repo = deps.repos.get(deps.repoKey(owner, name));
      if (repo === undefined) return null;
      const number = numOf(input, ['issueNumber', 'number']);
      const issue = repo.issues.find((candidate: any) => candidate.number === number);
      if (issue === undefined) return null;
      const body = strOf(input, ['body']);
      issue.comments.push({ id: repo.nextCommentId ?? 1, body, author: deps.viewerLogin, createdAt: deps.nowIso(repo) });
      return { commentEdge: { node: { id: nodeId('comment', `${owner}/${name}#${number}`), body, author: { login: deps.viewerLogin } } } };
    }
    default:
      return null;
  }
}

export function graphqlQuery(src: string, deps: GraphQLDeps, base: string): { data?: unknown; errors?: unknown[] } {
  try {
    const doc = new Parser(lex(src)).parseDocument();
    const out: Record<string, unknown> = {};
    for (const field of doc.fields) {
      if (field.name === '__inline') continue;
      const resolved = rootResolve(field, deps, base);
      out[field.alias] = executeSelection(resolved, field.selection, deps, base);
    }
    return { data: out };
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
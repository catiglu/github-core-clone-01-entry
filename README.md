# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/catiglu/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/catiglu/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A dependency-free, GitHub-compatible git forge in Node.js: REST (`/api/v3`), GraphQL (`/api/graphql`) and git smart HTTP (upload-pack v2 / receive-pack v0) over an in-memory store — built for the make.fun `github-core-clone-01` bounty.

## Run it

```sh
npm install
npm start
```

`main.ts` binds an ephemeral port, registers it with the harness through `MAKEFUN_ENV_URL`, serves until the harness reports the trial is done, then exits 0. For a quick local smoke test without the harness: `node _smoke.mjs`.

## What it implements

- **REST** `/api/v3` — repositories, contents, issues, labels, pull requests and git refs, with the status codes the suite scores (404 for the missing, 401 without a token, `X-GitHub-Request-Id` on every response).
- **GraphQL** `/api/graphql` — viewer, repository, issues and pull requests.
- **Git smart HTTP** — `info/refs?service=git-upload-pack` (protocol v2, `ls-refs`) and `git-receive-pack` (protocol v0, `report-status`, `side-band-64k`, `delete-refs`).
- **Lifecycle** — `main.ts` kept as the starter ships it: ephemeral port, register, poll `/done`, exit 0.

## Layout

- `main.ts` — the entry <-> env lifecycle (starter, unchanged).
- `app.ts` — the server: store, helpers and the REST + git smart HTTP handlers.
- `graphql.ts` — GraphQL query execution.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT) — the entry's metadata and licence.

## License

MIT — see [LICENSE](LICENSE).
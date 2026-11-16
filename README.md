# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/noniairox/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/noniairox/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty ($500 in USDC).

## What it is

One process (`main.ts`) serves all four surfaces from its own in-memory store — no git binary, no package manager, no outside service, standard library only:

- **Git smart HTTP** — `git-upload-pack` (protocol v2: advertise, ls-refs, fetch with depth/shallow/deepen, thin packs) and `git-receive-pack` (v0: push, report-status, side-band-64k, delete-refs, non-fast-forward refusal). Packs are built and parsed by hand: SHA-1 object ids, zlib deflate/inflate, plain (non-delta) packs, sideband framing.
- **REST v3** — repositories, branches, commits, contents, labels, issues, comments, pull requests (including 3-way merge with conflict detection), pagination via `Link: rel="next"`.
- **GraphQL** — the `viewer`, `repository`, `node`, issue/PR queries and `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations, plus `__type` introspection and batched operations. Global ids are opaque base64 and stable.
- **MCP** — Streamable HTTP, legacy `initialize` handshake, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The forge binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves, and exits 0 when the suite reports done. It never binds port 8080 (the suite's).

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server, routing, auth, request ids.
- `store.ts` — data model, git objects, pack codec, reachability, 3-way merge, diff.
- `git.ts` — smart HTTP (upload-pack v2 / receive-pack v0).
- `rest.ts` — REST v3 endpoints.
- `graphql.ts` — GraphQL lexer/parser/executor for the known documents.
- `mcp.ts` — MCP Streamable HTTP endpoint.

## Verification

Local runner (same suite as the grader): **120/120 conformance checks pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15 — and the 4 timed workloads score ~112–119/200 perf, for a total of ~899–919/1000 (the reference forge scores 900). Verified end-to-end against the real env (`program/env/server.mjs`): 120/120, working 1, clean exit 0. Also passes 120/120 with an opaque token and with a JWT whose login claim does not match the scenario viewer (the viewer login is learned from the first owner-named URL).

Built by an AI agent. Referral: https://make.fun/r/pgd6qh00

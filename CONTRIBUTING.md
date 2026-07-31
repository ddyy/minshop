# Contributing to minshop

Thanks for wanting to help. Small, focused PRs land fast here; big surprise PRs
usually stall. This page covers the mechanics. [AGENTS.md](AGENTS.md) is the
deeper map of the codebase: the architecture, the recipes, and the traps. Read
it before editing anything non-trivial.

## Setup

Node ≥ 22.12 and Git. Then:

```sh
nvm use 22
npm install
npm run provision:local -- --seed
npm run dev
```

That gives you a seeded local store at the printed URL, with Admin at `/admin`.

## The one command that matters

```sh
npm run verify
```

This is the green/red gate CI runs: unit tests, Astro diagnostics, the
production build, the clean-room D1 integration suite, and the MCP typecheck.
If it's green, your change holds together. Run it before you push, and ideally
after every meaningful edit.

Useful narrower loops: `npm test` (unit), `npm run check` (diagnostics),
`npm run preview` (wrangler dev, production mode, needed to test middleware
and auth), `npm run test:storefront-equivalence` (proves a template refactor
didn't change rendered output).

## What makes a PR easy to merge

- **One concern per PR.** A fix and a refactor are two PRs.
- **Keep the no-JS paths working.** The storefront works with JavaScript
  disabled; that's a feature, not an accident. Cart, search, and checkout all
  have plain-form fallbacks; don't break them.
- **New payment rails are adapters.** Implement `PaymentProvider`, wire the
  settings and webhook route, and leave checkout untouched. Same for storage:
  `StorageProvider`.
- **Match the customization ladder.** Runtime knobs go in Admin settings (D1),
  build-time knobs in `src/store.config.ts`, visual changes in theme tokens.
  Don't hardcode what belongs on the ladder.
- **Tests ride along.** A behavior change without a test that would have caught
  the old behavior is usually sent back.

## Before you build something big

Open an issue first and describe the change. This is a deliberately small
project: it stays within Cloudflare's free tier, ships near-zero client JS, and
avoids dependencies a merchant would have to operate. Proposals that add an
operational dependency (another service, another CLI, another daemon) need a
strong case. "No" often means "not in core". Forks and examples are welcome
and we're happy to link good ones.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened instead.
If it involves payments, say which rail (Stripe, Lightning, OpenNode, demo) and
whether you were in test mode. Never include real keys, tokens, or customer
data in an issue.

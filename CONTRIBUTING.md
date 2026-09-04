# Contributing

Thanks for considering it. This document is short and specific, because the project has a few conventions that are not obvious from the code.

## Before you start

For anything larger than a bug fix, open an issue first. The pricing logic has constraints that are not visible in the source — most of them come from how a marketplace actually behaves rather than from what its documentation claims — and it is cheaper to discuss those before you write the patch than after.

Good first contributions: translations, missing loading and empty states, accessibility fixes, JSDoc for the `db/` and `routes/` modules, response types to replace `any`. These are tracked as issues.

## Development setup

```bash
npm ci
cp .env.example .env         # set BETTER_AUTH_SECRET
ADMIN_PASSWORD='at-least-12-chars' npm run seed
npm run dev:all
```

See [docs/en/installation.md](docs/en/installation.md) for the full path, including connecting a store.

## Before you open a pull request

Run all four. CI runs the same commands, so a failure here is a failure there:

```bash
npm test              # 155 tests
npm run typecheck     # tsc --noEmit, must be clean
npm run lint          # must report 0 errors
npm run build
```

Lint warnings are tolerated — they are tracked debt, documented in `eslint.config.js`. Lint **errors** are not. Please do not add new `any` where a type is knowable, even though the rule is currently a warning.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): summary`, `fix(scope): summary`, `docs:`, `refactor:`, `test:`, `chore:`. The scope is the module — `repricer`, `strategies`, `governance`, `wb`, `ozon`, `ym`, `ui`.

**Language.** New code, comments and commit messages in English. Existing Russian comments are being migrated gradually; if you touch a file, translating its comments is welcome but never required. User-facing interface strings stay Russian — see below.

**Tests belong with the maths.** Anything that computes a price, a floor, a margin or a demand estimate needs a test. `lib/__tests__/` has the patterns to copy. Fetchers and routes are not currently tested, and a PR that adds coverage there is very welcome.

**Do not add a scraper.** Every outbound request must go to a documented API host. Ozon's rules prohibit scraping its storefront, and the consequence lands on the user's seller account, not on the project. Pull requests that parse marketplace HTML will be declined regardless of how well they work.

**Safety defaults stay on.** `dry_run`, `policy_require_floor`, the change limits, the snapshot before bulk writes. If a change makes one of these optional, say so explicitly in the PR description and explain what protects the user instead.

## Working on the frontend

The UI has no component library and no state manager — Context plus `useReducer`, CSS Modules. That is a deliberate constraint, not an oversight; please do not introduce a UI framework in a PR that is about something else.

Interface strings are Russian, because the users are sellers on Russian marketplaces. There is no i18n layer yet. If you want to add one, open an issue first — it touches roughly 900 strings across 58 files, and the sensible order is to extract the strings before translating them.

New colours come from the tokens in `src/index.css`, not from hex literals — hardcoded colours are why the light theme is currently uneven, and adding more makes that worse.

## Working on pricing logic

Three separate floor models exist on purpose: Ozon and Wildberries nest tax on net revenue, Yandex Market applies it to gross. Unifying them looks like cleanup and is a bug. `docs/en/architecture.md` explains why.

Constants calibrated against real data — the co-investment share, the Wildberries quarantine ratio, the boost cap — should not be changed without a settlement report or a platform document to justify the new value. Add the source in a comment.

The strategy engine (`lib/strategyEngine.cjs`, `lib/bayesPoisson.cjs`) is pure: no network, no database. Keep it that way; it is the reason it can be tested and simulated. `scripts/simStrategy.cjs` runs a Monte-Carlo check against a known optimum — run it if you change the search.

## Pull request checklist

- [ ] Tests, typecheck, lint and build pass locally
- [ ] New pricing behaviour has a test
- [ ] No secrets, real store names, real SKUs or personal data in the diff — including in test fixtures
- [ ] Commit messages follow the convention
- [ ] Documentation updated in the language you wrote it, at minimum

Translations of documentation into the other two languages are appreciated but not expected from you — say in the PR which files changed and someone can follow up.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under [MIT](LICENSE), the same as the project.

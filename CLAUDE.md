# CLAUDE.md - template-node-mock-server

Working agreement for this repository. `AGENTS.md` has the layout and the commands; `TEMPLATE.md`
says how a product uses the template.

## Conventions

- Branching: never commit to `main`. Branch as `<type>/<issue#>-<slug>` and open a PR; PRs merge
  by squash.
- Commits, issue titles and PR titles: Conventional Commits (`type(scope): description`). No
  attribution trailers, no emoji in source or commit messages (emoji are fine in Markdown docs and
  workflow files).
- Open every PR as a draft. CI skips drafts, so run the checks locally, push once they pass, and
  mark the PR ready when the work is finished.
- GitHub Actions: a job id must be a plain identifier (a letter or `_`, then alphanumerics/`-`/`_`);
  put emoji and display text in the job's `name:`. The Actionlint check
  (`.github/workflows/action-lint.yaml`) enforces this.
- Local notes live in the git-ignored `.local/` folder.
- No product's name, schema, data or rules in this repo. The sample in `src/product/` stays
  invented, with example.org addresses.

## Tests

- Every change to `src/core/` comes with a test in `src/core/server.test.ts` that fails without
  it. The tests run against a real server on a free port, the way a client calls it.
- `npm run lint`, `npm run typecheck` and `npm test` all pass before a push.

## Logging

- Log through `createLogger` in `src/core/log.ts`; levels and format come from `LOG_LEVEL` and
  `LOG_FORMAT`, never from code.
- Never log bodies, passwords, codes, cookies or tokens, even invented ones.

## What and why

<!-- What does this change, and why? Link the issue: Closes #123 -->

## How it was checked

- [ ] `pnpm build && pnpm typecheck && pnpm test` pass locally
- [ ] Tests added or updated (a bug fix has a test that fails without it)
- [ ] Dashboard changes looked at in a browser

## Notes for review

- [ ] No floating-point amounts; money stays `bigint`
- [ ] `packages/core` still does no I/O
- [ ] Schema changes are a new migration, not an edit to a shipped one
- [ ] No sample or invented data reachable by users
- [ ] README or docs updated if behaviour or limits changed

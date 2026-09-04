## What this changes

<!-- One or two sentences. If it fixes an issue, link it: Fixes #123 -->

## Why

<!-- What goes wrong without this change. For pricing logic, say which platform
     behaviour or settlement report motivated it. -->

## How it was verified

<!-- Tests added? Run against a real store in dry-run? Simulation? -->

## Checklist

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` pass
- [ ] New pricing behaviour has a test
- [ ] No secrets, real store names, real SKUs or personal data in the diff
- [ ] Safety defaults (`dry_run`, floor checks, change limits) still on by default
- [ ] Documentation updated

<!-- Keep PRs focused and atomic. -->

## What & why

<!-- What does this change, and what problem does it solve? -->

## How it was verified

<!-- Paste relevant test output. The suite must stay green: `bash tests/run-all.sh` -->

```
```

## Checklist

- [ ] `bash tests/run-all.sh` is green
- [ ] Added/updated a test for any decision-module change (`trade-journal/`)
- [ ] No credentials, no live/mainnet default, no secret logged
- [ ] Any threshold/edge change is backed by an out-of-sample result (or kept as observability only)

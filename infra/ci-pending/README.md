# Pending CI workflow

`ci.yml` belongs at `.github/workflows/ci.yml` but could not be pushed:
the GitHub token used lacked the `workflow` scope.

To install it, either:

1. **Locally:** `mkdir -p .github/workflows && git mv infra/ci-pending/ci.yml .github/workflows/`
   then push with a token that has the **Workflows: Read and write** permission; or
2. **Via the GitHub UI:** Actions → New workflow → paste the contents of `ci.yml`.

The workflow runs: typecheck, `money.spec`, `ledger.spec` (against a real
Postgres service), Flutter analyze/test, and a debug Android APK build.

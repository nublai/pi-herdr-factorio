# Update the Agents workflow tests

Root modifies `test/release-workflow.test.ts` in the target onboarding PR. This is a required target change, not a deletion of CI security assertions. The source used for this set is Agents `181728b29f4f4af40d9a5ed3b945421255fa0bf6`.

1. Retarget the three ordinary-CI tests to `.github/workflows/check.yml`:
   - `CI checks pushes and pull requests without release authority`
   - `CI runs the local gates with the release workflow's pinned tools`
   - `CI runs only unit tests on Windows without blocking`
2. Keep their assertions for push and PR events, manual dispatch, read-only permissions, no secrets or release authority, concurrency cancellation, timeouts, checkout credential persistence, package-manager cache, pinned actions and Node parity with publishing, exact command lists, and non-blocking Windows tests.
3. Scope command/action assertions to the `check` and `windows-unit` jobs separately. The old split at `windows-unit` now also captures `compatibility` in its first piece. Parse YAML jobs or split off `compatibility` explicitly before asserting Linux commands. Do not count its printf as an added local gate.
4. Assert job ID and required name `check`. Assert the compatibility job depends on `check` and emits `factory-compatibility` for both factory branch prefixes and the integration bot, and `factory-gates` only otherwise.
5. Add separate trusted-dispatch tests for `.github/workflows/ci.yml`. Assert main-only `workflow_dispatch`, exact dispatch title, full product SHA, distinct product/target checkouts, target `toolingRevision` equality, pinned gate image, candidate/gate/nonce/replacements/held-out transport, and product CLI invocation against the target directory.
6. Assert the reporter's separate job has no checkout or candidate/artifact-code execution, only receipt data reading, Actions read and checks write permissions, `github.token`, bot/triggering-actor and App 15368 checks, exact-head bindings, fail-closed required-check validation, and reporter-owned receipt upload. Do not apply the ordinary CI ban on `: write` to this trusted reporter.
7. Run `npm test`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run docs:tools:check`, and `npm pack --dry-run`. Record the exact tested head and output. Keep all existing test identities and assertions; add protocol tests rather than weakening the ordinary-CI tests.

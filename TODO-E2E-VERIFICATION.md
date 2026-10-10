# WARNING: REQUIRED END-TO-END VERIFICATION IS NOT GREEN

**COME BACK AND FIX THIS. THE SHORTCUT CHECKPOINT IS NOT FULLY VALIDATED.**

The implementation is committed, but required source-built Hub/Paseo E2E
verification fails. Do not remove, weaken, or skip the failing tests to make the
checks green. Do not describe the checkpoint as fully verified or release-ready.

## Known failure

- `npm run test:e2e:hub:source` fails during daemon connection setup, before
  Shortcut webhook processing or agent execution.
- Hub issues the enrollment token successfully (HTTP 201).
- Credential-safe diagnostics identify `Unexpected server response: 503` during
  a WebSocket upgrade. The failing connection and root cause are not
  established.
- The reproduction used the Pi-patched Paseo checkout at immutable commit
  `b70423c67d89818aca538c78e7a5babba47b7f96`, not the companion commit pinned in
  `.github/workflows/ci.yml`. Different source histories do not, by themselves,
  prove incompatibility.
- The command harness intentionally discards raw subprocess diagnostics to avoid
  leaking credentials. Preserve that protection when improving diagnostics.

## Required follow-up

- [ ] Run the source suite with the exact immutable Paseo commit pinned in CI
      and set `PASEO_E2E_WORKTREE` to that checkout, with its artifacts rebuilt.
- [ ] Reproduce against Hub before the Shortcut changes to distinguish a
      regression from an existing source-pairing or harness problem.
- [ ] Isolate whether the 503 occurs on CLI-to-daemon or daemon-to-Hub WebSocket
      setup; inspect readiness, upgrade handling, and compatibility.
- [ ] Add a focused regression test and fix the evidenced cause without
      bypassing authentication, changing permissions, or suppressing the
      failure.
- [ ] Rerun the complete source-built suite against the supported pairing and
      the Pi-patched pairing used for deployment.
- [ ] Finish the complete desktop/mobile browser suite. Passing subsets are not
      a passing full browser suite.
- [ ] Investigate the latest ordinary `npm test` rerun timeouts. The dashboard
      follow-up's full run exceeded 600 seconds; a parent rerun exceeded 180
      seconds during built-server/manual-run integration coverage. The cause is
      unestablished; the earlier 1,555-test pass is not a current full-suite
      pass.
- [ ] Run the required checks in `MAINTAINERS.md` and record the actual results.

## What is already verified

The implementation checkpoint's ordinary suite passed with 1,555 tests before
its later dashboard follow-up. Native Shortcut workflow integration coverage
proves signed delivery, story/thread-bound replies, same-agent continuation,
duplicate suppression, accepted-receipt recovery, and bot self-loop protection
with external HTTP and agent execution faked at their boundaries.

Typechecks, lint, formatting, migration checks, builds, and Docker smoke passed.
Those checks do not replace source-built E2E or authentic live webhook testing.

Implementation commits: `8cbb80f`, browser-fixture follow-up `c179f7b`, and
connection-dashboard follow-up `f57e915`. The dashboard follow-up passed 56
focused tests and 11 desktop connection browser cases, not a completed
full-suite rerun.

A configured deployment accepted authentic signed Shortcut mentions and produced
rooted replies and same-agent continuation. Live success does not resolve the
required E2E failure or substitute for the remaining complete test runs.

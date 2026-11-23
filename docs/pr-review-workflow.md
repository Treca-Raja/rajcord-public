# Reviewing and repairing Rajcord pull requests

Rajcord is usually developed by one person with coding agents. **AI reviews are
independent feedback, not human approvals or proof that production works.**
The human maintainer decides what to ship. Use the existing
`feature/* -> develop -> main` branch policy and verification workflow.

## One-time setup outside the repository

1. Install the [CodeRabbit GitHub App](https://app.coderabbit.ai/) for
   `Treca-Raja/rajcord-public` (only this repository if possible).
   The committed `.coderabbit.yaml` **does not install the app**. Confirm in its
   dashboard that reviews are enabled, and check that a non-draft PR into
   `develop` gets a review. The default branch (`main`) is included
   automatically. Do not give this review service production SSH secrets.
2. Optionally connect the repository in
   [Codex code-review settings](https://chatgpt.com/settings/code-review).
   Prefer **on-demand** `@codex review` for high-risk changes rather than two
   noisy automatic reviewers on every dependency update. Codex's GitHub review
   focuses on serious findings; use the same `AGENTS.md` rules.
3. Have an organization administrator inspect the existing rules for `develop`
   and `main`: preserve required Linux `Verify` and Windows build checks,
   require conversation resolution and up-to-date successful checks, and retain
   production approvals. **Do not turn on mandatory self-approval**: GitHub
   cannot count an author's own approval. A CodeRabbit comment is not a
   substitute for an approval that the ruleset already requires. Settings
   changes are separate from this PR and need administrator access.

## Workflow for each feature or fix

1. **Implement on a feature branch.** Use a draft PR while work is in
   progress. Supply acceptance criteria, a concise risk assessment, and local
   test evidence. Run targeted tests before requesting review; CI runs too.
2. **Request independent review.** Mark the PR ready only when its diff is
   coherent. CodeRabbit reviews automatically after its app is installed.
   For authentication, media, Electron privileges, migrations, deployment, or
   substantial architectural changes, also request a separate Codex review
   with `@codex review` (if connected).
3. **Triage findings instead of obeying blindly.** Investigate each actionable
   P0/P1/P2 concern. Reproduce the problem when practical. Add a regression
   test for behavior or security fixes. Reply with the fix commit/test, or
   explain evidence for a false positive. A deferred P2 needs a clear owner
   decision and follow-up; P0/P1 must not be merged outstanding.
4. **Repair and re-review.** Let the implementation agent fix validated
   findings in the same branch. Re-run affected local checks, push, and wait
   for the latest CI and incremental review. A new push is not itself proof
   that an old thread is fixed. CodeRabbit pauses after three reviewed
   commits; use `@coderabbitai resume` or `@coderabbitai review` when needed.
   After **two consecutive unsuccessful repair passes**, stop the autonomous
   loop and ask for human triage; don't let agents churn indefinitely.
5. **Close the loop.** Resolve each review thread only after inspecting its
   fix or documenting the maintainer's explicit disposition. Request a
   fresh review if the last change materially affects behavior. Confirm the
   latest head SHA, successful required checks, and reviewer feedback.
6. **Accept and merge manually.** Do a quick functional smoke test, especially
   for user-facing changes. Merge only to the designated target branch;
   `develop -> main` and production deployment retain their separate gates.

### Risk-appropriate verification

| Risk | Typical changes | Additional evidence |
| --- | --- | --- |
| Low | Docs, mechanical tooling, scoped dependency updates | Changed-file checks, relevant security/advisory review |
| Medium | UI state, chat behavior, API contracts | Unit/integration regressions, browser checks, both themes and mobile |
| High | Auth, permission checks, voice/screen streaming, Electron IPC, database schema, deployment | Adversarial/cleanup tests, service/browser/device testing and a second independent review; manual production-readiness decision |

For screen sharing, CI's synthetic/loopback tests do **not** establish
1080p60 smoothness under real WAN conditions. Test the publisher/viewer
workload and measure stalls/frame delivery before declaring it production
ready. Never run destructive data cleanup or production deploys as part of
a review or automated fix.

## Codex repair instruction

Use this in a **separate repair session** after a reviewer posts feedback:

> Review the current Rajcord PR diff, all review threads and the latest CI
> results. Act as the **repair agent**, not as the reviewer who wrote the code.
> For each actionable P0/P1/P2 issue, reproduce or verify it, make the smallest
> complete fix, add a regression test when suitable, and run affected local
> checks. Preserve `AGENTS.md`, branch policy, security invariants, unrelated
> work, and release approvals. Push only to this PR's feature branch after
> checking the diff. Reply to each thread with the specific commit and test
> evidence; do not resolve it without verification. Re-review against the
> **newest** head. Stop and report remaining problems after two failed repair
> passes. Never merge or deploy.

## Measure improvement

On each merged PR, record **review rounds**, **repair passes**, remaining
findings, and post-merge defects. A review round is a reviewer pass on a
specific head revision; a repair pass is a grouped set of corrective changes
in response to findings (not the number of commits). Count both manually in
the PR body until we have enough consistent data for automated reporting.
Compare median time-to-merge, P1/P2 findings caught before merge, and
regressions that escaped into production. Do **not** optimize for fewer
review comments at the expense of missed defects.

A clean automated review does not guarantee correctness, security, or
permission to publish to production.

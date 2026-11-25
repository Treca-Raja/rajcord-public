# Rajcord ticket template

Use this format for AI-created Trello cards and GitHub issues, and when drafting tickets for review. Follow [rajcord-ticket](../.agents/skills/rajcord-ticket/SKILL.md) before publishing.

## Writing rules

- Use one independently verifiable outcome per ticket. Split unrelated work and link dependencies.
- State the problem and expected result before suggesting implementation. Separate confirmed facts, constraints and proposed approaches.
- Keep requirements and acceptance criteria specific enough to test. Include limits or measurable thresholds only when known.
- Replace placeholders before publishing. Identify unresolved decisions and omit inapplicable fields. Leave an unclaimed ticket available for a contributor to pick up.
- Keep testing and completion items unchecked when drafting. Record evidence before marking them complete.
- For bugs, include reproducible steps, expected/actual behavior and the relevant version/environment. Keep sensitive reports private as described in [SECURITY.md](../SECURITY.md).
- For a Spike, define the question, agreed timebox if known, and expected decision/evidence instead of promising implementation.

## Title

`[TICKET TYPE] — Short, descriptive title`

Types: `Feature`, `Bug`, `Improvement`, `Task`, `Spike`, `Security`, `QA`, `Maintenance`, `Epic`. Prefer an action and outcome over a vague component name.

## Board workflow

Trello holds the team's ordering, claims, blockers and acceptance decisions. GitHub holds code, review, checks and release records. Keep durable technical decisions and reusable verification evidence in the repository. Link the relevant record once from Trello. Contributors without board access can use an issue or PR. A board member links it if the team takes on the work.

| List              | How to use it                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox / Triage    | Capture a request or link an existing report. Clarify the problem, impact and expected result.                                                                                |
| Backlog           | Keep worthwhile work here until its scope, priority or prerequisite is settled.                                                                                               |
| Ready             | Order vetted work by priority. A card can be unclaimed once its scope, acceptance check and dependencies are clear.                                                           |
| In Development    | Name one accountable human on the card as it enters this stage. Link the branch or PR when available and identify any shared contract or dependency.                          |
| Review & CI       | Use only when a specific reviewer has been explicitly asked to act. Link the PR and state what needs review. Routine checks stay on GitHub.                                   |
| QA / Acceptance   | Use when an agreed acceptance check is outstanding. Identify the build, environment, next check and who can perform it. Record the result or an explicit scope decision.      |
| Ready for Release | Use only when the outcome includes a specific delivery step. Link the integrated change and identify the remaining target, such as the hosted environment or desktop release. |
| Done              | Link evidence for the agreed integration, functional acceptance or delivery outcome. Research ends with its evidence and decision.                                            |
| Roadmap & Epics   | Optionally group independently verifiable outcomes when their sequence or shared direction needs coordination. Link the children.                                             |

Move a card when responsibility or the next action changes. Skip intermediate lists when their work is already complete. On a blocker, keep the card at its current step and record the condition, dependency link and next action. Check the board's migration record before acting on older setup instructions.

Before claiming, search active work and open PRs for the same outcome or shared interface. If two changes touch the same contract, agree on its shape and integration order so independent implementation can proceed in parallel. Keep the handoff to the next decision or check, its owner, and a link to the current work. Share public GitHub links from the private board. Keep private board links and content out of public issues, PRs and files.

Base verification on the risk and promised behavior. For media quality, identify the workload and distinguish local synthetic measurements from physical-device or WAN results. For distribution, link the applicable [hosted deployment](deployment.md#release-path) or [desktop release](desktop-distribution.md#authorized-release-process) evidence. A feature merge, a successful workflow, a published desktop version and a test on an installed client each answer a different question.

## Classification and priority

Use the title type to describe the outcome. Keep the next work the team wants pulled at the top of Ready. Update its order when impact or prerequisites change. Add an area, condition, parent, target release, estimate or label only when it helps someone choose, coordinate or verify the work. Record an urgent impact or dependency directly on the card. No estimate or label is required to start.

## Compact template (default for bounded work)

Remove inapplicable prompts and add handoff information as work progresses. Use the detailed template below for complex, risky, cross-component or multi-stage work. Preserve historical evidence in comments or linked verification records; do not remove it merely to shorten an existing card.

```markdown
## Outcome

[What should change and why?]

## Scope / context

[Relevant facts, boundaries and affected components. For a bug, include reproduction, actual/expected behavior and version/environment.]

## Acceptance criteria

- [ ] [Observable outcome.]
- [ ] [Relevant failure or regression check.]

## Coordination and evidence

- [Link an existing report, dependency or overlapping contract when relevant.]
- [At claim or handoff, record the human owner, current branch or PR, and next action.]
- [At acceptance, link the applicable result and identify any outstanding criterion.]
```

For security work, identify the finding, affected surface, demonstrated exposure, remediation and verification without publishing sensitive details. For a spike, state the question and required decision/evidence. For QA, identify the build, environment, scenarios and actual results. For an epic, link child outcomes and track progress through those children rather than accumulating a single oversized implementation PR.

## Detailed description body

Copy the following into the Trello card description or GitHub issue body. Keep the title in the platform's title field.

```markdown
## Description

[Explain what needs to change, why it matters and the expected outcome.]

## Background / Context

- Problem or user need: [Who is affected and how?]
- Current behavior and relevant business rules: [Facts and source references.]
- Previous decisions: [Relevant decisions, or Not applicable with a reason.]
- Bug reproduction, if applicable: [Steps, expected/actual results and environment.]

## Scope and Requirements

### In scope

- R1: [Required behavior or deliverable.]
- R2: [Another requirement, only if needed.]

### Out of scope

- [Explicit exclusions that keep this ticket bounded.]

## Acceptance Criteria

- [ ] AC1: Given [initial context], when [action occurs], then [observable expected result]. Covers R1.
- [ ] AC2: [Relevant failure, permission, compatibility or edge-case outcome.]

## Technical Notes

- Affected components, services, APIs or modules: [Confirmed impact or TBD.]
- Suggested implementation: [Optional proposal, not an unapproved design decision.]
- API / database / configuration changes: [Compatibility and migration implications.]
- Delivery / rollback considerations: [Pipeline impact and recovery, when applicable.]

## Design / References

- Design / Figma: [Link or Not applicable.]
- Documentation / source: [Relevant links, not copied private content.]
- Related tickets / PRs: [Links or None.]

## Testing Requirements

- [ ] Happy path and acceptance criteria covered.
- [ ] Relevant edge cases, authorization boundaries and error handling covered.
- [ ] Automated regression tests added or updated where behavior changes.
- [ ] Applicable local checks run; commands/results and unverified coverage recorded.

## Definition of Done

- [ ] Implementation or agreed research/deliverable completed.
- [ ] Acceptance criteria verified with evidence.
- [ ] Review completed and required approvals obtained.
- [ ] Applicable automated tests and CI checks pass, or an agreed exception is documented.
- [ ] User/developer documentation updated where behavior or commands change.
- [ ] Changes follow feature/* -> develop -> main; required PRs and remaining release work are identified.

## Delivery Metadata

- Accountable human: [At claim, use the existing native assignment when available.]
- Dependencies / blockers: [Linked work, shared contract and next action if applicable.]
- Target and evidence: [Agreed integration, acceptance or distribution target and its record.]
- Other planning details: [Include an area, parent, estimate or agreed date only when useful.]
```

Adapt checklists to the ticket type rather than leaving meaningless work items. Documentation-only tasks need formatting/link checks, not application runtime tests; research tickets need evidence and a decision. Completion of implementation is not evidence that a release was deployed.

## Trello field mapping

- On a new card, put the title in the card name and the complete body in its description. On an existing ticket, post status corrections, evidence and handoffs in comments. Preserve the original title and description unless an edit is requested.
- When requested and supported, reuse existing board labels, members and custom fields for the same metadata. Verify identifiers. A native assignment can carry the claim without a copy in the description.
- Record acceptance in one place. Use Markdown in the description or an authorized native checklist for work that needs individually tracked checks. Preserve existing evidence and check items only after verification. Existing tickets and checklists are migrated only under explicit authorization.
- An agreed detail without a native field can go in the description.

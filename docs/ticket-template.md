# Rajcord ticket template

Use this format for AI-created Trello cards and GitHub issues, and when drafting tickets for review. Follow [rajcord-ticket](../.agents/skills/rajcord-ticket/SKILL.md) before publishing.

## Writing rules

- Use one independently verifiable outcome per ticket. Split unrelated work and link dependencies.
- State the problem and expected result before suggesting implementation. Separate confirmed facts, constraints and proposed approaches.
- Keep requirements and acceptance criteria specific enough to test. Include limits or measurable thresholds only when known.
- Replace placeholders before publishing. Use `TBD` for unresolved decisions, `Unassigned` for an unknown owner and `Not applicable: <reason>` for irrelevant sections. Do not invent estimates, deadlines, people, designs or approvals.
- Keep testing and completion items unchecked when drafting. Record evidence before marking them complete.
- For bugs, include reproducible steps, expected/actual behavior and the relevant version/environment. Keep sensitive reports private as described in [SECURITY.md](../SECURITY.md).
- For a Spike, define the question, agreed timebox if known, and expected decision/evidence instead of promising implementation.

## Title

`[TICKET TYPE] — Short, descriptive title`

Types: `Feature`, `Bug`, `Improvement`, `Task`, `Spike`, `Security`, `QA`, `Maintenance`, `Epic`. Prefer an action and outcome over a vague component name.

## Board workflow

Use one shared project board. The lists describe workflow state, not ticket type or subsystem.

- **Roadmap & Epics:** track outcomes and linked child tickets, not day-to-day implementation.
- **Inbox / Triage:** capture new requests; clarify impact, scope and reproduction before accepting work.
- **Backlog:** accepted, prioritized work that is not ready to start.
- **Ready:** one bounded outcome, testable acceptance criteria, confirmed human owner, dependencies and overlapping work checked.
- **In Development:** active implementation with a work claim and a feature branch.
- **Review & CI:** an open, reviewable PR; resolve findings and obtain the required checks and approvals.
- **QA / Acceptance:** verify the expected behavior in the relevant environment, separating automated, synthetic, physical-device and WAN evidence.
- **Ready for Release:** accepted changes integrated and awaiting the applicable delivery step.
- **Done:** acceptance and applicable delivery are evidenced. For documentation/research work, record the agreed deliverable; an unrelated desktop release is not required.

Blocked is a condition, not a stage: retain the current workflow state and record the blocking dependency and next action. During a board migration, existing legacy lists and labels remain valid until explicitly reconciled. Do not migrate existing cards without authorization.

A human owner is accountable even when several AI agents contribute. Before starting, inspect active tickets/PRs and coordinate shared files, contracts, migrations, security-sensitive paths and release dependencies. Record a concise work claim (owner, branch, affected areas, dependency, intended outcome) and update it if scope changes. Prefer independent, reviewable outcomes over parallel edits to the same component.

Every implementation PR should link its associated ticket when appropriate and safe; record exact PR, check and release evidence on the ticket. Do not copy private board content into public GitHub descriptions. A draft or open PR does not prove integration, a merged feature PR does not prove deployment, and a successful build does not establish real-world acceptance. Preserve actual branch protections and approval policies.

## Classification and priority

- **Type:** use the title prefix. Types describe the deliverable, not the workflow state.
- **Primary area:** Chat & Messaging, Voice & Audio, Screen Sharing, Desktop, UI & Appearance, Accounts & Security, Infrastructure & DevOps, Mobile, or Developer Experience. Choose the affected subsystem; add a secondary area only when useful.
- **Priority:** P0 Critical (outage or confirmed critical exposure), P1 High (major broken functionality or release blocker), P2 Normal, P3 Low (optional polish or experiments). Use actual impact rather than scanner severity alone; retain TBD when priority has not been agreed.
- **Conditions:** Epic, Blocked, Needs Design, Needs Reproduction, Needs Hardware Testing as applicable.
- **Optional planning metadata:** target release, effort S/M/L/XL, parent epic and dependency links. Do not invent dates, estimates or owners.

Use native fields and labels only when they exist and are authorized. During transition, record unavailable metadata in the description; do not pretend a proposed board label or automation is already configured.

## Compact template (default for bounded work)

Keep small tasks short. Use the detailed template below for complex, risky, cross-component or multi-stage work. Preserve historical evidence in comments or linked verification records; do not remove it merely to shorten an existing card.

```markdown
## Outcome

[What should change and why?]

## Scope / context

[Relevant facts, boundaries and affected components. For a bug, include reproduction, actual/expected behavior and version/environment.]

## Acceptance criteria

- [ ] [Observable outcome.]
- [ ] [Relevant failure or regression check.]

## Coordination and evidence

- Owner: [Confirmed human owner / Unassigned]
- Area / priority: [Primary area / P0–P3 or TBD]
- Dependencies / affected files: [Links or TBD]
- Parent epic / target release: [As agreed or Unscheduled]
- Branch / PR / evidence: [Actual links when available]
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

- Priority: [P0 Critical / P1 High / P2 Normal / P3 Low / TBD]
- Effort: [S / M / L / XL / Unestimated]
- Assignee: [Owner / Unassigned]
- Reporter: [Actual requester / TBD]
- Target Release: [Agreed target / Unscheduled]
- Primary area / Parent epic: [Area / linked epic if applicable]
- Affected components / Work claim: [Confirmed scope and active branch, if started]
- Dependencies / Blockers: [Ticket links and blocking conditions / None / TBD]
```

Adapt checklists to the ticket type rather than leaving meaningless work items. Documentation-only tasks need formatting/link checks, not application runtime tests; research tickets need evidence and a decision. Completion of implementation is not evidence that a release was deployed.

## Trello field mapping

- Put the title in the card name and the complete body in its description. This works without paid custom fields.
- When requested and supported, reuse existing board labels, members and custom fields for the same metadata. Verify identifiers and keep the description consistent; do not create labels/fields, assign someone or set a date by guessing.
- Prefer native Trello acceptance checklists for new work when supported and authorized by the board workflow. In a draft or when unavailable, keep Markdown checkboxes in the description. Preserve existing evidence, avoid duplicate checklists, and never pre-complete an unverified item. Existing checklists and cards are migrated only under explicit authorization.
- If an estimate or field has no native equivalent, retain it in the description and report that limitation.

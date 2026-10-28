# Tricord ticket template

Use this format for AI-created Trello cards and GitHub issues, and when drafting tickets for review. Follow [tricord-ticket](../.agents/skills/tricord-ticket/SKILL.md) before publishing.

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

Types: `Feature`, `Bug`, `Improvement`, `Task`, `Spike`. Prefer an action and outcome over a vague component name.

## Description body

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

- Priority: [Critical / High / Medium / Low / TBD]
- Story Points / Estimate: [One agreed estimation unit and value, or Unestimated]
- Assignee: [Owner / Unassigned]
- Reporter: [Actual requester / TBD]
- Target Release / Sprint: [Agreed target / Unscheduled]
- Dependencies / Blockers: [Ticket links and blocking conditions / None / TBD]
```

Adapt checklists to the ticket type rather than leaving meaningless work items. Documentation-only tasks need formatting/link checks, not application runtime tests; research tickets need evidence and a decision. Completion of implementation is not evidence that a release was deployed.

## Trello field mapping

- Put the title in the card name and the complete body in its description. This works without paid custom fields.
- When requested and supported, reuse existing board labels, members and custom fields for the same metadata. Verify identifiers and keep the description consistent; do not create labels/fields, assign someone or set a date by guessing.
- Keep requirements and completion checklists in the description by default. Create native Trello checklists only when requested, without silently duplicating or pre-completing items.
- If an estimate or field has no native equivalent, retain it in the description and report that limitation.

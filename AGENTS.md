# Agent collaboration

Use subagents for substantial, independently testable work in this repository. Prefer GPT-5.6 Luna for delegated implementation and investigation unless the user requests another model.

## Delegation rules

- Give each subagent a concrete, bounded task with explicit file ownership.
- Split work so subagents do the majority of implementation when parallel work is useful.
- Avoid overlapping edits. Coordinate backend/client contracts before changing request or response shapes.
- Preserve unrelated and pre-existing changes. Never reset or discard another agent's work.
- Subagents must add or update focused tests and report files changed, assumptions, and verification results.
- The primary agent owns integration, security review, cross-cutting contracts, and the final full test/build pass.
- Do not weaken extension sender checks, trusted-context storage, device-key protections, or Chrome Store manifest restrictions.

## Repository checks

Run the crypto, clipboard, runtime, and direct test scripts, ESLint, and the Chrome Store build before handoff.

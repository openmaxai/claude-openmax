<!-- Please fill in every section. PRs that leave sections blank may be sent back. -->

## Summary

<!-- What does this PR do and why? One or two sentences of context. -->

## Changes

<!-- Bullet list of the notable changes in this PR. -->

-

## Testing

- [ ] `npm test` passes locally
- [ ] CI is green (test matrix, SAST, secret scan)

<!-- Note any manual verification performed. -->

## Security checklist

- [ ] No secrets, credentials, tokens, or keys are committed — Gitleaks secret scan is clean.
- [ ] Semgrep SAST is clean, **or** every finding is a justified false positive:
      annotated inline with `// nosemgrep: <rule-id>` (specific rule id, never a
      blanket `// nosemgrep`), with a one-line reason, and explicitly signed off
      by the reviewer. No blanket bypass of the scanner.

## Reviewer

- [ ] Approved by someone other than the last pusher (required by the branch
      ruleset — the author cannot self-approve their own final push).

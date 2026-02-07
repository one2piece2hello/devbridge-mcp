# Contributing to DevBridge MCP

Thanks for contributing.

## Ground rules

- By participating, you agree to follow [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- Keep changes focused and practical.
- Prefer backward-compatible tool behavior.

## Quick contribution flow

1. Fork this repo.
2. Create a branch from `main`.
3. Implement focused changes with tests/docs updates if needed.
4. Run:
   - `npm run build`
5. Open a Pull Request using the PR template.

## What to include in issues

- Your environment (macOS/Linux, Node version)
- MCP client (Claude Code / Codex)
- Remote server OS
- Exact prompt/tool call
- Actual output/error
- Expected behavior

Use:

- Bug report template: `.github/ISSUE_TEMPLATE/bug_report.md`
- Feature request template: `.github/ISSUE_TEMPLATE/feature_request.md`

## Scope we value most

- Remote workflow reliability
- Security hardening
- Sync performance (rsync/scp edge cases)
- Long-task observability and log UX
- Better docs and examples

## Coding notes

- Keep behavior deterministic.
- Prefer safe command construction.
- Avoid breaking existing tool interfaces unless clearly versioned.

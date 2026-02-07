# Contributing to DevBridge MCP

Thanks for contributing.

## How to contribute

1. Fork this repo and create a feature branch.
2. Make focused, testable changes.
3. Run local build/tests.
4. Open a PR with:
   - what problem it solves
   - reproduction steps
   - before/after behavior

## Good issue template

Please include:

- Your environment (macOS/Linux, Node version)
- MCP client (Claude Code / Codex)
- Remote server OS
- Exact prompt/tool call
- Actual output/error
- Expected behavior

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

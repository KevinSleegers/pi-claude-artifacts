# Changelog

## 0.1.0 — 2026-10-29

First public release.

- `claude_artifact_list`: lists your artifacts, artifacts shared with you and Designs shared in your organization, each marked `design` or `page`.
- `claude_artifact_fetch`: fetches a Design's files with size and SHA-256 verification and a versioned manifest, or a single page as one `index.html` with a locally computed SHA-256.
- `/claude-artifacts-login` and `/claude-artifacts-status` for a separate Claude Code login.
- Bundled `claude-design` skill for building from fetched artboards and tokens.
- Read-only on claude.ai; every operation runs your installed `claude -p` behind a deny-by-default tool guard.

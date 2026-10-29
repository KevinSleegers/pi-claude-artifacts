# Changelog

## 0.1.0 — 2026-10-29

First public release.

- `claude_artifact_list`: lists your artifacts, artifacts shared with you and Designs shared in your organization, each marked `design` or `page`.
- `claude_artifact_fetch`: fetches a Design's files with size and SHA-256 verification and a versioned manifest, or a single page as one `index.html` with a locally computed SHA-256.
- Accepts Cowork links that name an artifact (`claude.ai/cowork/…?artifact=<id>`) by converting them to `claude.ai/code/artifact/<id>`.
- Files Claude Code cannot read (a `__proto__`, `constructor` or `prototype` path segment, or `? # % : ;` in the path) are skipped and listed under `unreadable`, so they can be exported manually.
- A file Claude Code leaves unsaved is read once more; if it is still missing, the fetch fails and keeps a metadata-only run log.
- Every fetch removes the folder its Claude Code run left in the config directory.
- `/claude-artifacts-login` and `/claude-artifacts-status` for a separate Claude Code login.
- Bundled `claude-design` skill for building from fetched artboards and tokens.
- Read-only on claude.ai; every operation runs your installed `claude -p` behind a deny-by-default tool guard.

# Security Policy

## Reporting a vulnerability

Please report security issues via **GitHub private vulnerability reporting**
(Security tab → "Report a vulnerability"). Do not open a public issue.

You can also email **2705367723@qq.com**.

We aim to acknowledge reports within 7 days. While Weftcanvas is pre-1.0, only
the latest `main` is supported.

## What we consider in scope

- Anything that could leak another user's canvas data, sessions, or model keys.
- SSRF / injection paths in the Canvas API or generation worker.
- Privilege escalation between identity, wallet, or project boundaries.

## What is out of scope by design

- **BYOK keys are local-only by contract.** The browser stores the user's own
  key in that browser's `localStorage` and sends it directly to the provider the
  user configured. A threat model where an attacker already controls the user's
  browser is not a Weftcanvas vulnerability.
- Self-hosted deployments are only as secure as their configuration. The
  product refuses to start on ambiguous production provider settings
  (`CANVAS_API_PROVIDER` must be explicit); treat any bypass of that as a bug —
  report it.

## Hard rules for contributions

Never commit API keys, tokens, activation codes, or production endpoints — not
in code, not in fixtures, not in screenshots. CI runs gitleaks; a leak in
history requires rewriting it, so check your diffs.

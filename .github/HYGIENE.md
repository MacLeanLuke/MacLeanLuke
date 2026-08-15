# Repository hygiene

Issues are disabled on this repository, so the audit checklist lives here instead.

5 items on this repository need a decision or a change that should not be made automatically.

Everything here was deliberately *not* auto-applied — either it needs judgement about content, or applying it blindly could break a build. Detail under each item.

## Identity

- [ ] **At least three topics**
  Topics drive GitHub search and the explore surfaces. Three to five accurate ones beat a dozen aspirational.

- [ ] **LICENSE file present**
  Without one, default copyright applies and nobody may legally reuse anything — including snippets you want copied. Not auto-applied: choosing a licence is a legal decision.

- [ ] **Homepage URL set**
  A free, prominent sidebar link — to the deployed app, or to your site.

## Dependencies

- [ ] **dependabot.yml covers github-actions**
  The counterpart to SHA pinning: pinning freezes you, Dependabot proposes the bump. Add a `github-actions` ecosystem entry in `.github/dependabot.yml`.

## Policy

- [ ] **SECURITY.md present**
  Says how to report a vulnerability privately. Without it, the alternative is disclosure in public.

---

<sub>Opened and maintained by `scripts/repo-audit.mjs`. Re-running rewrites this issue in place rather than filing a new one, and closes it once everything passes. Ticking a box by hand will be overwritten — fix the underlying item instead.</sub>

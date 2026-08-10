<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MacLeanLuke/MacLeanLuke/main/assets/header-dark.svg">
  <img alt="Luke MacLean — Senior Full Stack & Platform Engineer — Dallas, TX" src="https://raw.githubusercontent.com/MacLeanLuke/MacLeanLuke/main/assets/header-light.svg" width="100%">
</picture>

I build the screens people stare at all day to make decisions that cost real money,
and the unglamorous plumbing underneath that keeps them up. Based in Dallas.

The work I'm proudest of is rarely a feature. It's the Friday-evening patch that
buys back the weekend, followed by the Tuesday fix that means it doesn't happen
again — and knowing which of those two you're being asked for.

**[luke-mac.com](https://www.luke-mac.com)** · **[LinkedIn](https://www.linkedin.com/in/luke-maclean/)**

---

### More detail, if you want it

<details>
<summary><b>Stack &amp; tooling</b></summary>

<br>

**Senior Full Stack / Platform Engineer** — Dallas, TX.

| | |
| --- | --- |
| **Focus** | Operator-critical systems — high volume, real consequences, no tolerance for a wrong number |
| **Front** | React · TypeScript · Next.js · Astro · AG Grid |
| **Back** | Node.js · GraphQL · REST · MCP · PostgreSQL · SQL Server |
| **Infra** | AWS · GCP · Vercel · Docker · Kubernetes · GitHub Actions |
| **Certs** | Apollo Graph Developer (Professional) · AWS Certified Cloud Practitioner |

The part that's hard to get across in a bullet list: being the person who can hold
the whole path in their head — local, staging, production, front to back — at 11pm, when
something is broken and the fix has to be small enough to be safe.

Work history is on [LinkedIn](https://www.linkedin.com/in/luke-maclean/). Most of
my recent work is in private repos; what's public is below, and each one has a
writeup explaining why it exists.

</details>

<details>
<summary><b>How I think about the work</b></summary>

<br>

**Numbers should be derived, not asserted.** The thing I keep building is the
model that shows its work. `page-load-anatomy` doesn't tell you a cold TLS 1.2
connection is slow — it counts the seven round trips and puts each one in a test.
If a README claims it, the test suite should be able to prove it.

**Prefer the boring mechanism.** My site rebuilds itself when its content
changes. WordPress's free plan can't install a webhook plugin, so rather than
storing state, a cron job compares the fingerprint WordPress reports *now*
against the one baked into the live deployment. Nothing to cache, nothing to go
stale, and a manual redeploy self-corrects. The deployed half is public — check
it yourself:

```bash
curl -s https://www.luke-mac.com/content-fingerprint.json
```

**The subtle bug is usually at a boundary.** That fingerprint gets computed
twice: once in TypeScript at build time, once in `bash` inside the Action. They
have to agree byte for byte, which means the shell sort needs `LC_ALL=C` to
match JavaScript's `.sort()`. Two implementations of "the same" hash that
silently disagree is exactly the sort of thing that pages you at 2am.

**Guard the repo, not just the code.** This profile is public, so it's set up to
refuse anything that isn't a README. `.gitignore` is deny-by-default,
[`scripts/guard.sh`](scripts/guard.sh) blocks credential shapes and a private
denylist — as a pre-commit hook *and* as required CI — and `main` takes no direct
pushes. The denylist itself is never committed: a public denylist is a public
index of precisely which words are sensitive.

</details>

<details>
<summary><b>Selected code</b></summary>

<br>

- **[page-load-anatomy](https://github.com/MacLeanLuke/page-load-anatomy)** — a
  deterministic model of a browser page load. Real protocol arithmetic, asserted
  in tests. Change the RTT and watch what moves downstream.
- **[rental-property-analyzer](https://github.com/MacLeanLuke/rental-property-analyzer)** —
  hold-vs-sell modelling in the browser. Exports an Excel workbook where every
  projection is a live formula, not a pasted value.
- **[mercy-networks](https://github.com/MacLeanLuke/mercy-networks)** —
  natural-language search connecting people experiencing homelessness, and the
  caseworkers serving them, to shelters and housing programs.
- **[neural-tools](https://github.com/MacLeanLuke/neural-tools)** — published npm
  toolkit for scaffolding MCP servers and AI agents, with evals by default.

</details>

---

### What I've been working on

<sub>Pulled from public push activity, newest first — not a hand-picked list.</sub>

<!-- BEGIN:work -->
| Project | What it is | Writeup |
| --- | --- | --- |
| **[page-load-anatomy](https://github.com/MacLeanLuke/page-load-anatomy)**<br><sub>TypeScript · today</sub> | A dissectible model of what actually happens when a browser loads a page. Real protocol arithmetic, not an animation. | [Read](https://techyschmecky.wordpress.com/2026/08/09/page-load-anatomy/) |
| **[rental-property-analyzer](https://github.com/MacLeanLuke/rental-property-analyzer)**<br><sub>TypeScript · yesterday</sub> | Decide whether to keep or sell a rental property. Live hold-vs-sell analysis in the browser, plus a downloadable Excel workbook where every projection is a live formula. | [Read](https://techyschmecky.wordpress.com/2026/08/09/rental-property-analyzer/) |
| **[neural-tools](https://github.com/MacLeanLuke/neural-tools)**<br><sub>TypeScript · yesterday</sub> | Complete AI productivity toolkit for building MCPs, Claude commands, and AI workflows | [Read](https://techyschmecky.wordpress.com/2026/08/09/neural-tools/) |
| **[mercy-networks](https://github.com/MacLeanLuke/mercy-networks)**<br><sub>TypeScript · 2d ago</sub> | Connects people experiencing homelessness and their caseworkers to shelters, meals, and housing programs via natural-language search. Next.js + Vercel AI SDK + Postgres. | [Read](https://techyschmecky.wordpress.com/2026/08/09/mercy-networks/) |
<!-- END:work -->

### Latest writing

<!-- BEGIN:writing -->
- **[Rescuing a Frozen Frontity Portfolio by Rebuilding It in Astro](https://techyschmecky.wordpress.com/2022/06/19/my-personal-website/)** <sub>2022-06-19</sub>

<sub>All posts at **[luke-mac.com](https://www.luke-mac.com)**.</sub>
<!-- END:writing -->

---

<!-- BEGIN:stamp -->
<sub>Regenerated 2026-08-10 by [`build-readme.mjs`](scripts/build-readme.mjs) · 4 active repos · 5 posts</sub>
<!-- END:stamp -->

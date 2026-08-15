#!/usr/bin/env node
/**
 * Audits every public repository against the hygiene checklist, fixes what is
 * safe to fix, and files one tracking issue per repo for what is not.
 *
 *   node scripts/repo-audit.mjs                    audit only, change nothing
 *   node scripts/repo-audit.mjs --apply            apply the safe fixes
 *   node scripts/repo-audit.mjs --issues           open/update tracking issues
 *   node scripts/repo-audit.mjs --apply --issues   both
 *
 *   --repo <name>     limit to one repository
 *   --include-forks   audit forks too (off by default, deliberately)
 *   --json            machine-readable output
 *
 * THE SPLIT BETWEEN "FIX" AND "FILE AN ISSUE"
 *
 * A check is only auto-fixable if applying it cannot break a build, cannot lose
 * data, and needs no judgement about content. That is a deliberately short list:
 * enabling scanners and tidying merge behaviour.
 *
 * Everything else is filed rather than applied, for one of two reasons:
 *
 *   It needs a decision that is not mine to make — which licence, what the
 *   description should say, which topics are honest.
 *
 *   Or applying it could break something. Restricting `allowed_actions` or
 *   forcing SHA pinning breaks any workflow currently using a third-party action
 *   or a tag. Setting the default token to read-only breaks any workflow that
 *   assumes write and never declared `permissions:`. A branch ruleset with the
 *   wrong approval count locks a solo maintainer out of their own repository.
 *   Those are all correct end states, and all of them need a human looking at
 *   the specific repo first.
 *
 * Issues are idempotent: one per repo, found by a marker in the body, rewritten
 * in place on later runs and closed automatically once the repo is clean.
 */

import { execFileSync } from 'node:child_process';

const OWNER = 'MacLeanLuke';
const MARKER = '<!-- repo-audit -->';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

const OPTS = {
  apply: has('--apply'),
  issues: has('--issues'),
  writeFiles: has('--write-files'),
  pinActions: has('--pin-actions'),
  json: has('--json'),
  forks: has('--include-forks'),
  only: val('--repo'),
};

// One branch per concern. They must not be shared: openFilePr force-resets its
// branch to the base commit, so two features pointed at one branch would have
// the second silently discard the first's work.
const BRANCH_FILES = 'chore/repo-hygiene';
const BRANCH_PINS = 'chore/pin-actions';
const BRANCH_TRACK = 'chore/hygiene-checklist';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
let TOKEN;
try {
  TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
} catch {
  console.error('repo-audit: could not read a token from `gh auth token`. Run `gh auth login`.');
  process.exit(1);
}

/** Returns {status, body}. Never throws on HTTP status — callers branch on it. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'repo-audit',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

const exists = async (path) => (await api(path)).status === 200;

// ---------------------------------------------------------------------------
// Checks
//
// passes() may return true, false, or null meaning "not applicable here".
// ---------------------------------------------------------------------------
const CHECKS = [
  // ---- Identity -----------------------------------------------------------
  {
    id: 'description',
    section: 'Identity',
    title: 'Repository has a description',
    auto: false,
    passes: (r) => Boolean(r.meta.description?.trim()),
    remedy: 'The only prose GitHub shows in search results and on profile cards. One sentence saying what a reader gets.',
  },
  {
    id: 'topics',
    section: 'Identity',
    title: 'At least three topics',
    auto: false,
    passes: (r) => (r.meta.topics?.length ?? 0) >= 3,
    remedy: 'Topics drive GitHub search and the explore surfaces. Three to five accurate ones beat a dozen aspirational.',
  },
  {
    id: 'license',
    section: 'Identity',
    title: 'LICENSE file present',
    auto: false,
    passes: (r) => Boolean(r.meta.license),
    remedy: 'Without one, default copyright applies and nobody may legally reuse anything — including snippets you want copied. Not auto-applied: choosing a licence is a legal decision.',
  },
  {
    id: 'readme',
    section: 'Identity',
    title: 'README present and substantive',
    auto: false,
    passes: (r) => r.readmeBytes > 500,
    remedy: 'Under 500 bytes reads as a placeholder. State what it is, why it exists, and how to run it.',
  },
  {
    id: 'homepage',
    section: 'Identity',
    title: 'Homepage URL set',
    auto: false,
    passes: (r) => Boolean(r.meta.homepage?.trim()),
    remedy: 'A free, prominent sidebar link — to the deployed app, or to your site.',
  },

  // ---- Disclosure ---------------------------------------------------------
  {
    id: 'secret-scanning',
    section: 'Disclosure',
    title: 'Secret scanning enabled',
    auto: true,
    passes: (r) => r.meta.security_and_analysis?.secret_scanning?.status === 'enabled',
    fix: (r) => api(`repos/${OWNER}/${r.name}`, {
      method: 'PATCH',
      body: { security_and_analysis: { secret_scanning: { status: 'enabled' } } },
    }),
    remedy: 'Free on public repos. Detects known credential formats already committed.',
  },
  {
    id: 'push-protection',
    section: 'Disclosure',
    title: 'Push protection enabled',
    auto: true,
    passes: (r) => r.meta.security_and_analysis?.secret_scanning_push_protection?.status === 'enabled',
    fix: (r) => api(`repos/${OWNER}/${r.name}`, {
      method: 'PATCH',
      body: { security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } } },
    }),
    remedy: 'Blocks the push instead of reporting afterwards — the difference between a near-miss and a credential rotation.',
  },

  {
    id: 'private-reporting',
    section: 'Disclosure',
    title: 'Private vulnerability reporting enabled',
    auto: true,
    passes: (r) => r.privateReporting,
    fix: (r) => api(`repos/${OWNER}/${r.name}/private-vulnerability-reporting`, { method: 'PUT' }),
    remedy: 'Gives a researcher a private channel. Without it their only option is a public issue that discloses the flaw to everyone before a fix exists.',
  },

  // ---- Branch protection --------------------------------------------------
  {
    id: 'ruleset',
    section: 'Branch protection',
    title: 'A ruleset protects the default branch',
    auto: false,
    passes: (r) => r.rulesets.some((s) => s.enforcement === 'active'),
    remedy: [
      'No active ruleset on the default branch, so force-pushes and deletion are unguarded.',
      '',
      'Not auto-applied: the right rules differ per repo, and one setting is a trap —',
      '`required_approving_review_count` must be **0** on a solo repo, because GitHub',
      'will not let you approve your own PR. Setting it to 1 is a permanent lockout.',
    ].join('\n'),
  },

  // ---- CI/CD --------------------------------------------------------------
  {
    id: 'ci',
    section: 'CI/CD',
    title: 'At least one workflow',
    auto: false,
    passes: (r) => r.workflows.length > 0,
    remedy: 'Nothing runs on a push. Even a single job that installs and builds catches the obvious breakage.',
  },
  {
    id: 'action-pinning',
    section: 'CI/CD',
    title: 'Actions pinned to commit SHAs',
    auto: false,
    passes: (r) => (r.workflows.length === 0 ? null : r.unpinnedActions.length === 0),
    detail: (r) => (r.unpinnedActions.length ? `Unpinned: ${r.unpinnedActions.join(', ')}` : ''),
    remedy: [
      'Tags are mutable — whoever controls an action repo can repoint `v4` at new code,',
      'which then runs with your token. Pin to a full commit SHA and let Dependabot',
      'propose bumps as reviewable PRs.',
      '',
      'Not auto-applied: rewriting workflow files needs a build to verify afterwards.',
    ].join('\n'),
  },
  {
    id: 'token-permissions',
    section: 'CI/CD',
    title: 'Default workflow token is read-only',
    auto: false,
    passes: (r) => (r.actionsPerms ? r.actionsPerms.default_workflow_permissions === 'read' : null),
    remedy: [
      'The default token has write access, so a new workflow gets write by accident.',
      '',
      'Not auto-applied: flipping this breaks any existing workflow that assumes write',
      'and never declared a `permissions:` block. Add those blocks first, then flip.',
    ].join('\n'),
  },

  // ---- Dependencies -------------------------------------------------------
  {
    id: 'dependabot-alerts',
    section: 'Dependencies',
    title: 'Dependabot alerts enabled',
    auto: true,
    passes: (r) => r.vulnAlerts,
    fix: (r) => api(`repos/${OWNER}/${r.name}/vulnerability-alerts`, { method: 'PUT' }),
    remedy: 'Free, and worth having even with no dependencies today.',
  },
  {
    id: 'dependabot-updates',
    section: 'Dependencies',
    title: 'Dependabot security updates enabled',
    auto: true,
    passes: (r) => r.meta.security_and_analysis?.dependabot_security_updates?.status === 'enabled',
    fix: (r) => api(`repos/${OWNER}/${r.name}/automated-security-fixes`, { method: 'PUT' }),
    remedy: 'Opens the patch PR for you once an alert fires.',
  },
  {
    id: 'dependabot-config',
    section: 'Dependencies',
    title: 'dependabot.yml covers github-actions',
    auto: false,
    passes: (r) => (r.workflows.length === 0 ? null : r.hasDependabotConfig),
    remedy: 'The counterpart to SHA pinning: pinning freezes you, Dependabot proposes the bump. Add a `github-actions` ecosystem entry in `.github/dependabot.yml`.',
  },

  // ---- Merge hygiene ------------------------------------------------------
  {
    id: 'delete-branch',
    section: 'Merge hygiene',
    title: 'Merged branches auto-delete',
    auto: true,
    passes: (r) => r.meta.delete_branch_on_merge === true,
    fix: (r) => api(`repos/${OWNER}/${r.name}`, {
      method: 'PATCH',
      body: { delete_branch_on_merge: true },
    }),
    remedy: 'Keeps the branch list meaningful so stale refs stand out.',
  },

  // ---- Policy -------------------------------------------------------------
  {
    id: 'security-md',
    section: 'Policy',
    title: 'SECURITY.md present',
    auto: false,
    passes: (r) => r.hasSecurityMd,
    remedy: 'Says how to report a vulnerability privately. Without it, the alternative is disclosure in public.',
  },
];

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------
async function inspect(name) {
  const { body: meta } = await api(`repos/${OWNER}/${name}`);

  const [readme, vuln, rulesets, actionsPerms, wfList, secMd, secMdGh, depCfg, pkg] = await Promise.all([
    api(`repos/${OWNER}/${name}/readme`),
    api(`repos/${OWNER}/${name}/vulnerability-alerts`),
    api(`repos/${OWNER}/${name}/rulesets`),
    api(`repos/${OWNER}/${name}/actions/permissions/workflow`),
    api(`repos/${OWNER}/${name}/contents/.github/workflows`),
    exists(`repos/${OWNER}/${name}/contents/SECURITY.md`),
    exists(`repos/${OWNER}/${name}/contents/.github/SECURITY.md`),
    exists(`repos/${OWNER}/${name}/contents/.github/dependabot.yml`),
    exists(`repos/${OWNER}/${name}/contents/package.json`),
  ]);

  const workflows = Array.isArray(wfList.body)
    ? wfList.body.filter((f) => /\.ya?ml$/.test(f.name))
    : [];

  // Scan workflow sources for `uses:` referencing a tag or branch rather than a
  // 40-char SHA. Actions in the same repo (./path) are exempt.
  const unpinned = new Set();
  const workflowSources = {};
  for (const wf of workflows) {
    const { body: file } = await api(`repos/${OWNER}/${name}/contents/${wf.path}`);
    if (!file?.content) continue;
    const src = Buffer.from(file.content, 'base64').toString('utf8');
    workflowSources[wf.path] = src;
    for (const m of src.matchAll(/^\s*-?\s*uses:\s*['"]?([^'"\s#]+)/gm)) {
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      const at = ref.lastIndexOf('@');
      if (at === -1) { unpinned.add(ref); continue; }
      if (!/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) unpinned.add(ref);
    }
  }

  return {
    name,
    meta,
    readmeBytes: readme.status === 200 ? (readme.body.size ?? 0) : 0,
    vulnAlerts: vuln.status === 204,
    privateReporting: meta.security_and_analysis?.private_vulnerability_reporting?.status === 'enabled',
    rulesets: Array.isArray(rulesets.body) ? rulesets.body : [],
    actionsPerms: actionsPerms.status === 200 ? actionsPerms.body : null,
    workflows,
    workflowSources,
    unpinnedActions: [...unpinned],
    hasSecurityMd: secMd || secMdGh,
    hasDependabotConfig: depCfg,
    hasPackageJson: pkg,
  };
}

// ---------------------------------------------------------------------------
// Writing files into another repository
//
// Everything goes through a pull request on a named branch. Never a direct
// push: each repo runs whatever CI it has against the change, and a human sees
// it before it lands. Contents-API commits are signed by GitHub, which also
// satisfies any repo that requires signatures.
// ---------------------------------------------------------------------------
async function openFilePr(repo, { branch, files, title, body }) {
  const base = repo.meta.default_branch;
  const { body: baseRef } = await api(`repos/${OWNER}/${repo.name}/git/ref/heads/${base}`);
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) return { action: 'failed', why: 'could not read the default branch' };

  const refPath = `repos/${OWNER}/${repo.name}/git/refs/heads/${branch}`;
  if ((await api(refPath)).status === 200) {
    await api(refPath, { method: 'PATCH', body: { sha: baseSha, force: true } });
  } else {
    const made = await api(`repos/${OWNER}/${repo.name}/git/refs`, {
      method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    if (!made.ok) return { action: 'failed', why: `branch: HTTP ${made.status}` };
  }

  let wrote = 0;
  for (const [path, content] of Object.entries(files)) {
    const current = await api(`repos/${OWNER}/${repo.name}/contents/${path}?ref=${branch}`);
    const existingSha = current.status === 200 ? current.body.sha : undefined;
    const res = await api(`repos/${OWNER}/${repo.name}/contents/${path}`, {
      method: 'PUT',
      body: {
        message: title,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      },
    });
    if (res.ok) wrote++;
  }

  if (wrote === 0) return { action: 'nothing-to-write' };

  const open = await api(
    `repos/${OWNER}/${repo.name}/pulls?head=${OWNER}:${branch}&base=${base}&state=open`,
  );
  if (Array.isArray(open.body) && open.body.length) {
    return { action: 'updated', number: open.body[0].number, files: wrote };
  }

  const pr = await api(`repos/${OWNER}/${repo.name}/pulls`, {
    method: 'POST', body: { title, head: branch, base, body },
  });
  return pr.ok
    ? { action: 'opened', number: pr.body.number, files: wrote }
    : { action: 'failed', why: `pr: HTTP ${pr.status}`, files: wrote };
}

const securityMd = (repo) => `# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. That discloses it
to everyone before there is a fix.

Use GitHub's private vulnerability reporting instead:

**[Report a vulnerability](https://github.com/${OWNER}/${repo.name}/security/advisories/new)**

That opens a channel visible only to the maintainer, so no contact address has
to be published here for scrapers to harvest.

## Scope

A personal project maintained by one person. There is no bug bounty and no
formal response SLA. Reports are still genuinely welcome — being told about a
problem is always better than not being told.

## Supported versions

The default branch is the only supported version. Fixes land there and are not
backported.
`;

/**
 * Ecosystems are detected, not assumed: npm only where a manifest exists,
 * github-actions only where workflows exist. A config listing an ecosystem the
 * repo does not use produces a permanent Dependabot error on the repo.
 */
function dependabotYml(repo) {
  const blocks = [];
  if (repo.hasPackageJson) blocks.push('npm');
  if (repo.workflows.length) blocks.push('github-actions');
  if (blocks.length === 0) return null;

  return `# Generated by scripts/repo-audit.mjs — ecosystems detected from repo contents.
version: 2
updates:
${blocks.map((e) => `  - package-ecosystem: ${e}
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
`).join('')}`;
}

// ---------------------------------------------------------------------------
// Pinning actions to commit SHAs
// ---------------------------------------------------------------------------
const shaCache = new Map();

/** Resolve owner/repo@ref to a commit SHA, dereferencing annotated tags. */
async function resolveSha(actionRef) {
  if (shaCache.has(actionRef)) return shaCache.get(actionRef);

  const at = actionRef.lastIndexOf('@');
  const [nameWithPath, ref] = [actionRef.slice(0, at), actionRef.slice(at + 1)];
  const [o, r] = nameWithPath.split('/');
  if (!o || !r) return null;

  let sha = null;
  for (const kind of ['tags', 'heads']) {
    const res = await api(`repos/${o}/${r}/git/ref/${kind}/${ref}`);
    if (res.status !== 200) continue;
    sha = res.body.object.sha;
    if (res.body.object.type === 'tag') {
      const deref = await api(`repos/${o}/${r}/git/tags/${sha}`);
      if (deref.status === 200) sha = deref.body.object.sha;
    }
    break;
  }
  shaCache.set(actionRef, sha);
  return sha;
}

async function pinWorkflows(repo) {
  const files = {};
  const changes = [];

  for (const [path, src] of Object.entries(repo.workflowSources)) {
    let out = src;
    for (const ref of new Set(repo.unpinnedActions)) {
      if (!src.includes(ref)) continue;
      const sha = await resolveSha(ref);
      if (!sha) continue;
      const tag = ref.slice(ref.lastIndexOf('@') + 1);
      // Keep the human-readable version in a trailing comment; Dependabot reads
      // it to know what the pin corresponds to when proposing a bump.
      out = out.replaceAll(
        new RegExp(`${ref.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?!\\\\S)`, 'g'),
        `${ref.slice(0, ref.lastIndexOf('@'))}@${sha} # ${tag}`,
      );
      changes.push(`${ref} → ${sha.slice(0, 10)}`);
    }
    if (out !== src) files[path] = out;
  }

  if (Object.keys(files).length === 0) return { action: 'nothing-to-write' };

  const res = await openFilePr(repo, {
    branch: BRANCH_PINS,
    files,
    title: 'Pin GitHub Actions to commit SHAs',
    body: [
      'Tags are mutable. Whoever controls an action repository can repoint `v4` at new code, which then runs in this repo with its token.',
      '',
      'Pinned to full commit SHAs, with the original tag kept as a trailing comment so Dependabot can still propose version bumps as reviewable pull requests.',
      '',
      '```',
      ...changes.map((c) => c),
      '```',
      '',
      'Generated by `scripts/repo-audit.mjs --pin-actions`. Check CI on this PR before merging — that is the point of routing it through a PR rather than a push.',
    ].join('\n'),
  });
  return { ...res, changes };
}

// ---------------------------------------------------------------------------
// Issue body
// ---------------------------------------------------------------------------
function issueBody(repo, failing) {
  const bySection = new Map();
  for (const c of failing) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section).push(c);
  }

  const out = [
    MARKER,
    '',
    `${failing.length} item${failing.length === 1 ? '' : 's'} on this repository need a decision or a change that should not be made automatically.`,
    '',
    'Everything here was deliberately *not* auto-applied — either it needs judgement about content, or applying it blindly could break a build. Detail under each item.',
    '',
  ];

  for (const [section, items] of bySection) {
    out.push(`## ${section}`, '');
    for (const c of items) {
      out.push(`- [ ] **${c.title}**`);
      const extra = c.detail?.(repo);
      if (extra) out.push(`  ${extra}`);
      for (const line of c.remedy.split('\n')) out.push(line ? `  ${line}` : '');
      out.push('');
    }
  }

  out.push(
    '---',
    '',
    '<sub>Opened and maintained by `scripts/repo-audit.mjs`. Re-running rewrites this issue in place rather than filing a new one, and closes it once everything passes. Ticking a box by hand will be overwritten — fix the underlying item instead.</sub>',
  );
  return out.join('\n');
}

/**
 * Where a repo has issues switched off there is nowhere to file, and silently
 * skipping means that repo is the one nobody tracks. Commit the same checklist
 * into the repo instead, as a file, via the same pull-request path.
 */
async function syncTrackingFile(repo, failing) {
  if (failing.length === 0) return { action: 'none' };

  const body = [
    '# Repository hygiene',
    '',
    `Issues are disabled on this repository, so the audit checklist lives here instead.`,
    '',
    issueBody(repo, failing).replace(`${MARKER}\n\n`, ''),
    '',
  ].join('\n');

  return openFilePr(repo, {
    branch: BRANCH_TRACK,
    files: { '.github/HYGIENE.md': body },
    title: `Repo hygiene: ${failing.length} item${failing.length === 1 ? '' : 's'} outstanding`,
    body: 'Issues are disabled here, so the audit checklist is committed as `.github/HYGIENE.md`. Regenerated in place on later runs.',
  });
}

async function syncIssue(repo, failing) {
  if (!repo.meta.has_issues) return syncTrackingFile(repo, failing);

  const search = await api(
    `search/issues?q=${encodeURIComponent(`repo:${OWNER}/${repo.name} is:issue is:open in:body "${MARKER}"`)}`,
  );
  const existing = search.body?.items?.[0] ?? null;

  if (failing.length === 0) {
    if (!existing) return { action: 'none' };
    await api(`repos/${OWNER}/${repo.name}/issues/${existing.number}`, {
      method: 'PATCH', body: { state: 'closed' },
    });
    return { action: 'closed', number: existing.number };
  }

  const title = `Repo hygiene: ${failing.length} item${failing.length === 1 ? '' : 's'} outstanding`;
  const body = issueBody(repo, failing);

  if (existing) {
    await api(`repos/${OWNER}/${repo.name}/issues/${existing.number}`, {
      method: 'PATCH', body: { title, body },
    });
    return { action: 'updated', number: existing.number };
  }

  const created = await api(`repos/${OWNER}/${repo.name}/issues`, {
    method: 'POST', body: { title, body },
  });
  return { action: 'created', number: created.body?.number };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const C = process.stdout.isTTY
  ? { b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', o: '\x1b[0m' }
  : { b: '', dim: '', g: '', r: '', y: '', c: '', o: '' };

async function main() {
  let repos = [];
  for (let page = 1; ; page++) {
    const { body } = await api(`users/${OWNER}/repos?per_page=100&type=owner&page=${page}`);
    if (!Array.isArray(body) || body.length === 0) break;
    repos.push(...body);
    if (body.length < 100) break;
  }

  repos = repos.filter((r) => !r.private && !r.archived);
  if (!OPTS.forks) repos = repos.filter((r) => !r.fork);
  if (OPTS.only) repos = repos.filter((r) => r.name === OPTS.only);

  if (repos.length === 0) {
    console.error('repo-audit: no repositories matched.');
    process.exit(1);
  }

  if (!OPTS.json) {
    const mode = OPTS.apply || OPTS.issues
      ? [OPTS.apply && 'applying fixes', OPTS.issues && 'syncing issues'].filter(Boolean).join(' + ')
      : `${C.y}dry run — nothing will change${C.o}`;
    console.log(`\n${C.b}repo-audit${C.o} · ${repos.length} public repo(s) · ${mode}\n`);
  }

  const report = [];

  for (const stub of repos) {
    const repo = await inspect(stub.name);
    const results = [];

    for (const check of CHECKS) {
      const state = check.passes(repo);
      if (state === null) { results.push({ check, state: 'n/a' }); continue; }
      if (state) { results.push({ check, state: 'pass' }); continue; }

      if (check.auto && OPTS.apply) {
        const res = await check.fix(repo);
        results.push({ check, state: res.ok ? 'fixed' : 'fix-failed', status: res.status });
      } else {
        results.push({ check, state: check.auto ? 'fixable' : 'fail' });
      }
    }

    // Boilerplate the repo is missing. Content is either identical everywhere
    // or derived from what is already in the repo, so nothing here is a guess.
    let filePr = { action: 'not-requested' };
    if (OPTS.writeFiles) {
      const files = {};
      if (!repo.hasSecurityMd) files['SECURITY.md'] = securityMd(repo);
      if (!repo.hasDependabotConfig) {
        const yml = dependabotYml(repo);
        if (yml) files['.github/dependabot.yml'] = yml;
      }
      filePr = Object.keys(files).length
        ? await openFilePr(repo, {
            branch: BRANCH_FILES,
            files,
            title: 'Add SECURITY.md and Dependabot config',
            body: [
              'Boilerplate this repo was missing. Neither file needs a judgement call:',
              '',
              '- `SECURITY.md` points at GitHub private vulnerability reporting, so no contact address is published for scrapers.',
              '- `.github/dependabot.yml` lists only the ecosystems actually detected in this repo — a config naming an unused ecosystem produces a permanent Dependabot error.',
              '',
              'Generated by `scripts/repo-audit.mjs --write-files`.',
            ].join('\n'),
          })
        : { action: 'nothing-to-write' };
    }

    let pins = { action: 'not-requested' };
    if (OPTS.pinActions && repo.unpinnedActions.length) pins = await pinWorkflows(repo);

    const needsIssue = results.filter((r) => r.state === 'fail').map((r) => r.check);
    let issue = { action: 'not-requested' };
    if (OPTS.issues) issue = await syncIssue(repo, needsIssue);

    report.push({ repo: repo.name, results, issue, filePr, pins });

    if (OPTS.json) continue;

    const counts = results.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
    console.log(`${C.b}${repo.name}${C.o} ${C.dim}— ${counts.pass ?? 0} pass · ${(counts.fail ?? 0) + (counts.fixable ?? 0)} outstanding${C.o}`);

    for (const { check, state, status } of results) {
      if (state === 'pass' || state === 'n/a') continue;
      const mark = {
        fixed: `${C.g}fixed  ${C.o}`,
        fixable: `${C.c}fixable${C.o}`,
        fail: `${C.y}needs you${C.o}`,
        'fix-failed': `${C.r}failed ${C.o}`,
      }[state];
      console.log(`  ${mark}  ${check.title}${status ? ` ${C.dim}(HTTP ${status})${C.o}` : ''}`);
    }

    for (const [label, r] of [['files', filePr], ['pins', pins], ['issue', issue]]) {
      if (r.action === 'not-requested' || r.action === 'none' || r.action === 'nothing-to-write') continue;
      const note = r.number ? `#${r.number}` : (r.why ?? '');
      console.log(`  ${C.dim}${label} ${r.action} ${note}${C.o}`);
    }
    console.log();
  }

  if (OPTS.json) {
    console.log(JSON.stringify(
      report.map((r) => ({
        repo: r.repo,
        issue: r.issue,
        checks: r.results.map(({ check, state }) => ({ id: check.id, state })),
      })),
      null, 2));
    return;
  }

  const tally = report.flatMap((r) => r.results).reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  console.log(`${C.b}Summary${C.o}  ${tally.pass ?? 0} passing · ${tally.fixed ?? 0} fixed · ${tally.fixable ?? 0} auto-fixable · ${tally.fail ?? 0} need a person\n`);

  if (!OPTS.apply && tally.fixable) {
    console.log(`${C.dim}Re-run with --apply to fix the ${tally.fixable} safe item(s), --issues to file the rest.${C.o}\n`);
  }
}

main().catch((e) => {
  console.error(`repo-audit: ${e.stack ?? e.message}`);
  process.exit(1);
});

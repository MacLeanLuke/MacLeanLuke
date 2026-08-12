#!/usr/bin/env node
/**
 * Rebuilds the generated regions of README.md.
 *
 * GitHub hands a visitor an unranked dump: six pinned repos and a grid of green
 * squares. It never says which repo is worth their four minutes or why any of it
 * exists. This fills that in — each public repo paired with the post that
 * explains why it was built.
 *
 * Only the regions between <!-- BEGIN:x --> and <!-- END:x --> are touched, so
 * the hand-written prose around them survives every run.
 *
 * Writes nothing when the rendered output is byte-identical to what is already
 * on disk, and reports that via exit code so the workflow can skip the commit.
 * Comparing against the artifact instead of storing a cache means there is no
 * state to go stale and a manual run always self-corrects.
 *
 *   node scripts/build-readme.mjs           rewrite README.md in place
 *   node scripts/build-readme.mjs --check   report drift, write nothing (exit 3)
 *
 * Exit codes: 0 written/updated, 1 error, 2 misuse, 3 unchanged (or drift in --check).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');

const USER = 'MacLeanLuke';
const WP = 'https://public-api.wordpress.com/wp/v2/sites/techyschmecky.wordpress.com';
const SITE = 'https://www.luke-mac.com';

const CHECK_ONLY = process.argv.includes('--check');

// GitHub's API is fine unauthenticated at this volume, but Actions passes a
// token so the job isn't sharing the runner's rate limit with the whole world.
const gh = async (path) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `${USER}-profile-builder`,
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${res.statusText}`);
  return res.json();
};

/**
 * WordPress is the CMS, not the destination.
 *
 * The API reports canonical links on the wordpress.com host, but the Astro site
 * serves those same posts on luke-mac.com under the identical `/YYYY/MM/DD/slug/`
 * path — the permalink structure was preserved precisely so these stay portable.
 * Readers should land on the site, not the backing CMS.
 *
 * Falls back to the original URL if WordPress ever reports a host we do not
 * recognise, so an unexpected link is left alone rather than silently pointed
 * somewhere that 404s.
 */
const onSite = (link) => {
  try {
    const u = new URL(link);
    if (!/(^|\.)wordpress\.com$/.test(u.hostname)) return link;
    return new URL(u.pathname + u.search + u.hash, SITE).href;
  } catch {
    return link;
  }
};

/** WordPress returns titles as rendered HTML, so entities arrive encoded. */
const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&#x2019;/g, '’')
    .replace(/&#8216;|&#x2018;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Escape the pipe so a title containing one can't blow apart a table row. */
const cell = (s) => s.replace(/\|/g, '\\|');

const ago = (iso) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

/**
 * Public push activity, newest first.
 *
 * /events/public is a 90-day, 300-event window — it answers "what has he
 * actually been doing lately", which is the question a visitor is asking and
 * the one a pinned-repo list answers badly.
 */
async function activeRepos() {
  const events = await gh(`users/${USER}/events/public?per_page=100`);
  const seen = new Map();
  for (const e of events) {
    if (e.type !== 'PushEvent' && e.type !== 'CreateEvent' && e.type !== 'ReleaseEvent') continue;
    const name = e.repo.name.split('/')[1];
    if (!seen.has(name)) seen.set(name, { name, last: e.created_at, pushes: 0 });
    if (e.type === 'PushEvent') seen.get(name).pushes += e.payload?.commits?.length ?? 1;
  }
  return [...seen.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

async function main() {
  const [active, wpPosts] = await Promise.all([
    activeRepos(),
    fetch(`${WP}/posts?per_page=20&status=publish&_fields=id,date,modified,link,title,slug`).then((r) => {
      if (!r.ok) throw new Error(`WordPress → ${r.status}`);
      return r.json();
    }),
  ]);

  // The blog slug and the repo name are the same string, which makes the join
  // trivial. Worth keeping that way when naming future posts.
  const postBySlug = new Map(wpPosts.map((p) => [p.slug, p]));

  const details = await Promise.all(
    active.map(async (r) => {
      try {
        const meta = await gh(`repos/${USER}/${r.name}`);
        return meta.private || meta.fork ? null : { ...r, meta };
      } catch {
        return null; // deleted or made private since the event fired
      }
    }),
  );

  const repos = details.filter(Boolean).filter((r) => r.name !== USER);

  // ---- Recent work -----------------------------------------------------------
  const work = [
    '| Project | What it is | Writeup |',
    '| --- | --- | --- |',
    ...repos.slice(0, 6).map((r) => {
      const post = postBySlug.get(r.name);
      const desc = r.meta.description ?? '—';
      const writeup = post ? `[Read](${onSite(post.link)})` : '—';
      return `| **[${r.name}](https://github.com/${USER}/${r.name})**<br><sub>${r.meta.language ?? '—'} · ${ago(r.last)}</sub> | ${cell(desc)} | ${writeup} |`;
    }),
  ].join('\n');

  // ---- Latest writing --------------------------------------------------------
  // Skip anything already linked as a writeup in the table above, so this stays
  // additive rather than repeating the same four links in a different order.
  const paired = new Set(repos.slice(0, 6).map((r) => r.name));
  const unpaired = wpPosts.filter((p) => !paired.has(p.slug));

  const writing = [
    ...unpaired.slice(0, 5).map((p) => {
      // WordPress returns site-local time with no timezone suffix, so `new Date()`
      // would read it as local and `toISOString()` would roll it into the next day.
      // The date is already the one to display — just take it.
      const date = p.date.slice(0, 10);
      return `- **[${cell(decode(p.title.rendered))}](${onSite(p.link)})** <sub>${date}</sub>`;
    }),
    `\n<sub>All posts at **[luke-mac.com](${SITE})**.</sub>`,
  ].join('\n');

  const sections = {
    work,
    writing,
    stamp: `<sub>Regenerated ${new Date().toISOString().slice(0, 10)} by [\`build-readme.mjs\`](scripts/build-readme.mjs) · ${repos.length} active repos · ${wpPosts.length} posts</sub>`,
  };

  // ---- Splice ----------------------------------------------------------------
  const before = await readFile(README, 'utf8');
  let after = before;

  for (const [key, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- BEGIN:${key} -->)[\\s\\S]*?(<!-- END:${key} -->)`);
    if (!re.test(after)) throw new Error(`README is missing the BEGIN/END:${key} markers`);
    after = after.replace(re, `$1\n${body}\n$2`);
  }

  // The date stamp changes every day, so compare everything except it — otherwise
  // this would commit a no-op diff every single run.
  const strip = (s) => s.replace(/<!-- BEGIN:stamp -->[\s\S]*?<!-- END:stamp -->/, '');
  const changed = strip(before) !== strip(after);

  if (!changed) {
    console.log(`No change — ${repos.length} repos, ${wpPosts.length} posts.`);
    process.exit(3);
  }

  if (CHECK_ONLY) {
    console.log('README is out of date. Run: node scripts/build-readme.mjs');
    process.exit(3);
  }

  await writeFile(README, after);
  console.log(`Updated README — ${repos.length} repos, ${wpPosts.length} posts.`);
}

main().catch((err) => {
  console.error(`build-readme: ${err.message}`);
  process.exit(1);
});

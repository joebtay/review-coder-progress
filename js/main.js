// The PI's progress page (PI, 15 October 2026): every review on the list, read live from GitHub in this tab.
// Counts and dates only (see count.js). Read only (see github.js). Nothing is stored in the browser: no web
// storage, cookies or databases, so the token is forgotten when the tab closes. The page never reads the
// review app's saved sign-in, though both sites share one browser origin.
import { ReadOnlyGitHub, apiBase } from './github.js';
import { reduceFile, kindOf, mergeById, teamRepos, projectModel, needsLook, parseList, parseListRef, openLink, deployOf } from './count.js';

const app = document.getElementById('app');
const API = apiBase(location.search);
let gh = null, who = null, listRef = null, gen = 0; // gen: a newer Refresh or a sign-out makes older reads stop drawing

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.setAttribute('style', v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const time = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const bar = (n, d) => h('div', { class: 'bar' }, h('div', { style: `width:${d ? Math.round((100 * n) / d) : 0}%` }));
const ago = (d) => (d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`);
const ghLink = (repo, extra = '') => `https://github.com/${repo}${extra}`;
const ext = (href, text, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls, text });

// ---------- sign-in ----------

function signIn(msg) {
  gh = null; who = null; gen++;
  const q = new URLSearchParams(location.search).get('list') || '';
  const token = h('input', { type: 'password', id: 'token', placeholder: 'GitHub token', autocomplete: 'off', spellcheck: 'false' });
  const list = h('input', { type: 'text', id: 'list', placeholder: 'owner/repo:path/to/list.json', value: q, autocomplete: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'warnline', id: 'err', text: msg || '' });
  const go = async () => {
    err.textContent = '';
    const ref = parseListRef(list.value);
    const t = token.value.trim();
    if (!t) { err.textContent = 'Paste your GitHub token.'; return; }
    if (!ref) { err.textContent = 'Give the project list as owner/repo:path/file.json.'; return; }
    token.value = '';
    const c = new ReadOnlyGitHub({ token: t, api: API });
    try { who = (await c.user()).login; } catch (e) {
      err.textContent = e.status === 401 ? 'GitHub did not accept that token.' : e.message; return;
    }
    gh = c; listRef = ref;
    show();
  };
  app.replaceChildren(h('div', { class: 'signin' },
    h('h1', { text: 'Review progress' }),
    h('p', { class: 'muted', text: 'How each coder and screener is getting on, across every review on your list. Counts and dates only.' }),
    h('label', null, 'Your GitHub token', token),
    h('label', null, 'Project list', list),
    err,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'go', onclick: go, text: 'Show progress' })),
    h('p', { class: 'small muted' }, 'Read only: this page never writes to a repo. Your token stays in this tab\'s memory and is forgotten when you close it or sign out. Nothing is saved in the browser.'),
    h('details', null, h('summary', { text: 'Which token' }),
      h('ol', { class: 'small' },
        h('li', { text: 'GitHub, Settings, Developer settings, Fine-grained tokens, Generate new token.' }),
        h('li', { text: 'Repository access: all repositories (so new team repos are covered).' }),
        h('li', { text: 'Permissions, all Read-only: Contents, Pages, Actions. Metadata is added by GitHub.' }),
        h('li', { text: 'Choose an expiry, generate, copy and paste it here.' })))));
  token.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  token.focus();
}

// ---------- reading ----------

async function readRepo(repo, master) {
  try {
    const { paths, truncated } = await gh.tree(repo);
    const one = async (p, kind) => reduceFile(kind, await gh.readJSON(repo, p)); // the parsed file is dropped here
    const review = paths.includes('review.json') ? await one('review.json', 'review') : null;
    const out = { repo, master, review, setup: null, samples: [], records: null, agreed: [], first: null, work: {}, truncated };
    await Promise.all(paths.map(async (p) => {
      const kind = kindOf(p, review);
      if (!kind || kind === 'review' || (kind === 'setup' && !master)) return;
      const v = await one(p, kind);
      if (kind === 'setup') out.setup = v;
      else if (kind === 'sample') { if (v) out.samples.push(v); }
      else if (kind === 'records') out.records = v;
      else if (kind === 'agreed') out.agreed = v;
      else if (kind === 'first') out.first = v;
      else if (kind === 'work') { const hd = p.split('/')[1]; out.work[hd] = mergeById(out.work[hd], v); }
    }));
    return out;
  } catch (e) {
    return { repo, master, error: e.status === 404 ? 'Not found, or this token cannot read it.' : e.message };
  }
}

async function readProject(entry, list, now) {
  const master = await readRepo(entry.repo, true);
  if (master.error) return { entry, error: master.error };
  const teams = await Promise.all(teamRepos(master.setup, entry).map((r) => readRepo(r, false)));
  const model = projectModel({ repos: [master, ...teams], now, staleDays: list.stale_days });
  const notes = [master, ...teams].filter((r) => r.error).map((r) => `${r.repo}: ${r.error}`)
    .concat([master, ...teams].filter((r) => r.truncated).map((r) => `${r.repo}: GitHub cut the file list short, so some counts may be low.`));
  return { entry, model, notes };
}

async function readSite(site) {
  const r = `/repos/${site.repo}`;
  try {
    const [pages, build] = await Promise.all([gh.maybe(`${r}/pages`, true), gh.maybe(`${r}/pages/builds/latest`, true)]);
    const runs = build ? null : await gh.maybe(`${r}/actions/runs?per_page=1`, true);
    return { site, address: pages && /^https:\/\//.test(pages.html_url || '') ? pages.html_url : null, deploy: deployOf(build, runs && runs.workflow_runs && runs.workflow_runs[0]) };
  } catch (e) { return { site, error: e.message }; }
}

// ---------- the page ----------

async function show() {
  const g = ++gen, live = () => g === gen;
  const main = h('main', { class: 'page', id: 'main' }, h('p', { class: 'muted', id: 'loading', text: 'Reading the project list' }));
  app.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('div', { class: 'logo', text: 'P' }), h('div', null, h('b', { text: 'Review progress' }), h('div', { class: 'small muted', text: 'Read only · counts and dates only · nothing saved' }))),
      h('div', { class: 'right' }, h('span', { class: 'small muted', id: 'who', text: `Signed in as ${who}` }),
        h('button', { type: 'button', class: 'btn small', id: 'refresh', onclick: show, text: 'Refresh' }),
        h('button', { type: 'button', class: 'btn small', id: 'signout', onclick: () => signIn(), text: 'Sign out' }))),
    main));
  let list;
  try { list = parseList(await gh.readJSON(listRef.repo, listRef.path)); } catch (e) {
    if (!live()) return;
    main.replaceChildren(h('div', { class: 'warnline', id: 'list-error', text: `The project list ${listRef.repo}:${listRef.path} could not be read. ${e.status === 404 ? 'Not found, or this token cannot read it.' : e.message}` }));
    return;
  }
  if (!live()) return;
  const now = Date.now();
  const attention = h('div', { class: 'card', id: 'attention' }, h('h2', { text: 'Needs a look' }), h('p', { class: 'muted small', text: 'Reading' }));
  const sites = h('div', { class: 'card', id: 'sites' }, h('h2', { text: 'Sites' }), h('p', { class: 'muted small', text: 'Reading' }));
  const cards = list.projects.map((p) => h('section', { class: 'card project', 'data-repo': p.repo }, h('h2', { text: p.repo }), h('p', { class: 'muted small', text: 'Reading' })));
  main.replaceChildren(h('div', { class: 'grid2' }, attention, sites), ...cards,
    h('p', { class: 'small muted foot', id: 'stamp', text: `Read ${day(new Date(now).toISOString())} at ${time(new Date(now).toISOString())}. Projects on the list: ${list.projects.length}.` }));

  const sitesP = Promise.all(list.sites.map(readSite)).then((rs) => live() && sites.replaceChildren(h('h2', { text: 'Sites' }), siteTable(rs)));
  const flagged = [];
  const projP = Promise.all(list.projects.map(async (entry, i) => {
    const res = await readProject(entry, list, now);
    if (!live()) return;
    cards[i].replaceChildren(...projectCard(res, list));
    if (res.model) for (const p of res.model.people) if (needsLook(p)) flagged.push({ project: res.model.title, p });
  })).then(() => live() && attention.replaceChildren(h('h2', { text: 'Needs a look' }), attentionList(flagged, list.stale_days)));
  await Promise.all([sitesP, projP]);
  if (live()) main.setAttribute('data-ready', '1');
}

function attentionList(flagged, staleDays) {
  if (!flagged.length) return h('p', { class: 'ok small', id: 'nobody', text: `Nobody with work outstanding has gone ${staleDays} days or more without activity.` });
  flagged.sort((a, b) => (b.p.days ?? Infinity) - (a.p.days ?? Infinity) || (a.project < b.project ? -1 : 1));
  return h('ul', { class: 'plain', id: 'flagged' }, flagged.map(({ project, p }) => h('li', { 'data-handle': p.handle },
    h('b', { text: p.name }), ` · ${project} · `,
    h('span', { class: 'warn-ink', text: p.days == null ? 'no activity yet' : `no activity for ${p.days} days (last ${day(p.last)})` }))));
}

function siteTable(rs) {
  if (!rs.length) return h('p', { class: 'muted small', text: 'No sites on the list.' });
  return h('div', { class: 'tw' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Site', 'Address', 'Last deploy', 'Result'].map((x) => h('th', { text: x })))),
    h('tbody', null, rs.map((r) => h('tr', { 'data-site': r.site.repo },
      h('td', { 'data-label': 'Site' }, h('b', { text: r.site.name })),
      h('td', { 'data-label': 'Address' }, r.address ? ext(r.address, r.address.replace(/^https:\/\//, '')) : h('span', { class: 'muted', text: '–' })),
      h('td', { 'data-label': 'Last deploy' }, r.deploy && r.deploy.at ? `${day(r.deploy.at)}, ${time(r.deploy.at)}` : h('span', { class: 'muted', text: '–' })),
      h('td', { class: 'result', 'data-label': 'Result' }, r.error ? h('span', { class: 'bad', text: r.error })
        : r.deploy ? h('span', { class: `pill ${r.deploy.result === 'Succeeded' ? 'good' : r.deploy.result === 'Failed' ? 'fail' : 'warn'}`, text: r.deploy.result })
          : h('span', { class: 'muted small' }, 'Can\'t read with this token. ', ext(ghLink(r.site.repo, '/actions'), 'See it on GitHub'))))))));
}

const STATE = { finished: ['Finished', 'good'], active: ['Active', ''], stale: ['No activity', 'warn'], 'none-yet': ['Not started', 'warn'], nothing: ['Nothing assigned', 'muted'] };

function projectCard(res, list) {
  const e = res.entry;
  const open = openLink(e, list);
  const head = [h('div', { class: 'ph' },
    h('h2', { text: res.model ? res.model.title : e.repo }),
    h('div', { class: 'small muted mono', text: e.repo }),
    h('div', { class: 'row' },
      open ? h('a', { class: 'btn small primary open', href: open, target: '_blank', rel: 'noopener noreferrer', text: 'Open in app' }) : null,
      h('a', { class: 'btn small github', href: ghLink(e.repo), target: '_blank', rel: 'noopener noreferrer', text: 'Open on GitHub' })))];
  if (res.error) return [...head, h('div', { class: 'warnline project-error', text: `This project could not be read: ${res.error}` })];
  const notes = res.notes.map((n) => h('div', { class: 'warnline note', text: n }));
  const people = res.model.people;
  if (!people.length) return [...head, ...notes, h('p', { class: 'muted', text: 'Nobody on this project yet.' })];
  return [...head, ...notes, h('div', { class: 'tw' }, h('table', { class: 't people' },
    h('thead', null, h('tr', null, ['Person', 'Samples: items done', 'Screening: records decided', 'Last activity', ''].map((x) => h('th', { text: x })))),
    h('tbody', null, people.map((p) => {
      const [label, cls] = STATE[p.state];
      return h('tr', { 'data-handle': p.handle, 'data-state': p.state },
        h('td', { class: 'who' }, h('b', { text: p.name }), h('div', { class: 'small muted', text: p.role || '' })),
        h('td', { class: p.samples.length ? 'samples' : 'samples none', 'data-label': 'Samples: items done' }, p.samples.length ? p.samples.map((s) => h('div', { class: 'sample', 'data-sample': s.id, 'data-done': s.done, 'data-assigned': s.assigned, 'data-submitted': s.submitted ? 'yes' : 'no' },
          h('div', { class: 'prl' }, h('span', { class: 'st', text: s.title }), h('span', null, h('b', { text: `${s.done} of ${s.assigned}` }), ' ',
            h('span', { class: `pill small ${s.submitted ? 'good' : ''}`, text: s.submitted ? 'Submitted' : 'Not submitted' }))),
          bar(s.done, s.assigned))) : h('span', { class: 'muted', text: '–' })),
        h('td', { class: p.screening ? 'screening' : 'screening none', 'data-label': 'Screening: records decided' }, p.screening ? h('div', { class: 'scr', 'data-decided': p.screening.decided, 'data-assigned': p.screening.assigned },
          h('div', { class: 'prl' }, h('span', null, h('b', { text: `${p.screening.decided} of ${p.screening.assigned}` }), ' decided')), bar(p.screening.decided, p.screening.assigned)) : h('span', { class: 'muted', text: '–' })),
        h('td', { class: 'last', 'data-label': 'Last activity', 'data-last': p.last ? day(p.last) : '' }, p.last ? [day(p.last), h('div', { class: 'small muted', text: ago(p.days) })] : h('span', { class: 'muted', text: 'None yet' })),
        h('td', { class: 'status' }, h('span', { class: `pill state ${cls}`, text: p.state === 'stale' ? `${label} for ${p.days} days` : label })));
    }))))];
}

signIn();

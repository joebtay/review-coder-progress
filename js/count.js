// Progress counts for the PI's dashboard (PI, 15 October 2026). Pure functions: no DOM, no network, no storage.
//
// Blinding: the PI codes in the same samples as the other coders, so this page keeps counts and dates only. Every
// file is cut down by reduceFile() the moment it is read: events keep only the fields below, samples keep only who
// is assigned which item, screening files keep only record ids. Codes, decisions, reasons, notes, quotes and comments
// never reach the model, and so can never reach the screen.
//
// The rules repeat app/js/events.js isDone and app/js/assign.js submitted on purpose, so the page stands alone
// (tests/progress.test.mjs checks they agree): an item is done when the latest done/reopen event for the coder,
// sample, item and frame is done; a sample is submitted when the coder's _samples.json has a submit for it; a record
// is decided when the person has any screen-decision on it (discuss included), as the screener's own count does.

export const EVENT_KEEP = ['id', 't', 'coder', 'type', 'sample', 'samples', 'unit', 'frame', 'record', 'items'];
const SAMPLE_KEEP = ['id', 'title', 'frame', 'mode', 'locked'];
const DAY = 86400000;
const str = (v) => (typeof v === 'string' ? v : null);

/** Events with only the fields a count needs. Everything else (action, value, text, decision, reason, ...) is dropped. */
export function strip(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object' || !str(e.id) || !str(e.type)) continue;
    const k = {};
    for (const f of EVENT_KEEP) {
      const v = e[f];
      if (f === 'samples') { if (Array.isArray(v)) k.samples = v.filter((x) => typeof x === 'string'); }
      else if (f === 'items') { if (typeof v === 'number') k.items = v; }
      else if (typeof v === 'string') k[f] = v;
    }
    out.push(k);
  }
  return out;
}

/** A sample cut to who has which item: {id, title, frame, mode, coders: [handles], units: [{unit, order: {handle: n}}]}. */
export function stripSample(s) {
  if (!s || typeof s !== 'object' || !str(s.id)) return null;
  const k = {};
  for (const f of SAMPLE_KEEP) if (typeof s[f] === 'string' || typeof s[f] === 'boolean') k[f] = s[f];
  if (s.coders && typeof s.coders === 'object') k.coders = Object.keys(s.coders);
  k.units = (Array.isArray(s.units) ? s.units : []).filter((u) => u && str(u.unit)).map((u) => {
    const order = {};
    if (u.order && typeof u.order === 'object') for (const [h, n] of Object.entries(u.order)) if (n != null) order[h] = 1;
    return { unit: u.unit, order };
  });
  return k;
}

/** review.json cut to the title, the team (handle, name, role label) and where screening keeps its files. */
export function stripReview(r) {
  if (!r || typeof r !== 'object') return null;
  const sc = r.screening && typeof r.screening === 'object' && r.screening.enabled !== false ? r.screening : null;
  return {
    id: str(r.id), title: str(r.title),
    team: (Array.isArray(r.team) ? r.team : []).filter((m) => m && str(m.handle)).map((m) => ({ handle: m.handle, name: str(m.name) || m.handle, role: str(m.role) || '' })),
    screening: sc ? { records: str(sc.records) || 'screening/records.json', first: str(sc.first), agreed: str(sc.agreed) } : null,
  };
}

/** setup.json cut to the people and their repos. */
export function stripSetup(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    team: s.repos && str(s.repos.team),
    coders: (Array.isArray(s.coders) ? s.coders : []).filter((c) => c && str(c.handle)).map((c) => ({ handle: c.handle, name: str(c.name) || c.handle, role: str(c.role) || '', repo: str(c.repo) })),
    never: (Array.isArray(s.never) ? s.never : []).filter((n) => n && str(n.handle)).map((n) => n.handle.toLowerCase()),
  };
}

/** The ids in a records file (an array of profiles) or in a {records: {id: ...}} file. */
export function recordIds(obj) {
  if (Array.isArray(obj)) return obj.filter((r) => r && str(r.id)).map((r) => r.id);
  if (obj && obj.records && typeof obj.records === 'object') return Object.keys(obj.records);
  return [];
}

/**
 * One file as read from a repo, cut down at once. kind: 'review' | 'setup' | 'sample' | 'records' | 'agreed' |
 * 'first' | 'work'. The caller drops the parsed file and keeps only this.
 */
export function reduceFile(kind, obj) {
  if (kind === 'review') return stripReview(obj);
  if (kind === 'setup') return stripSetup(obj);
  if (kind === 'sample') return stripSample(obj);
  if (kind === 'records' || kind === 'agreed') return recordIds(obj);
  if (kind === 'first') return { screener: obj && str(obj.screener), date: obj && str(obj.date), ids: recordIds(obj) };
  if (kind === 'work') return strip(obj && obj.events);
  return null;
}

/** Which kind of file a repo path is, given the cut-down review (for the screening paths); null for files not read. */
export function kindOf(path, review) {
  if (path === 'review.json') return 'review';
  if (path === 'setup.json') return 'setup';
  if (/^samples\/[^/]+\.json$/.test(path)) return 'sample';
  if (/^work\/[^/]+\/[^/]+\.json$/.test(path)) return 'work';
  const sc = review && review.screening;
  if (sc) {
    if (path === sc.records) return 'records';
    if (path === sc.agreed) return 'agreed';
    if (path === sc.first) return 'first';
  }
  return null;
}

/** Union of event lists by id, oldest first (as app/js/events.js mergeEvents). */
export function mergeById(...lists) {
  const m = new Map();
  for (const l of lists) for (const e of l || []) if (e && e.id && !m.has(e.id)) m.set(e.id, e);
  return [...m.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when the latest done/reopen event for this item is done. Events oldest first. */
export function isDone(events, { coder, sample, unit, frame }) {
  let done = false;
  for (const e of events) {
    if (e.coder !== coder || e.sample !== sample || e.unit !== unit || e.frame !== frame) continue;
    if (e.type === 'done') done = true;
    else if (e.type === 'reopen') done = false;
  }
  return done;
}

/** The handles who have submitted a sample. */
export function submittedBy(events, sampleId) {
  return new Set(events.filter((e) => e.type === 'submit' && e.sample === sampleId).map((e) => e.coder));
}

/** The items a person has in a sample: their ordered items in an assigned sample, every item otherwise. */
export function assignedUnits(sample, handle) {
  if (!sample.coders) return sample.units;
  return sample.units.filter((u) => u.order[handle]);
}

const roleOf = (label) => {
  const l = String(label || '').toLowerCase();
  if (l === 'pi') return 'PI';
  if (/screen|review/.test(l) && /cod/.test(l)) return 'Screener and coder';
  if (/screen|review/.test(l)) return 'Screener';
  return label ? 'Coder' : '';
};
const SETUP_ROLE = { pi: 'PI', coder: 'Coder', screener: 'Screener', both: 'Screener and coder' };

/** Team repos for a project: setup.json coders' repos (not the master) and any the list file names. */
export function teamRepos(setup, entry) {
  const out = new Set();
  for (const c of (setup && setup.coders) || []) if (c.repo && c.repo !== 'master' && /^[\w.-]+\/[\w.-]+$/.test(c.repo)) out.add(c.repo);
  for (const r of (entry && entry.team) || []) out.add(r);
  return [...out];
}

/**
 * The counts-only model of one project.
 * repos: [{repo, master: bool, review, setup, samples: [stripped], records: [ids] | null, agreed: [ids], first,
 *          work: {handle: [stripped events]}, error}]
 * Returns {title, people: [{handle, name, role, samples: [{id, title, assigned, done, submitted}],
 *          screening: {assigned, decided} | null, last, days, state}]}
 * state: 'finished' | 'active' | 'stale' | 'none-yet' | 'nothing'.
 */
export function projectModel({ repos, now = Date.now(), staleDays = 7 }) {
  const master = repos.find((r) => r.master) || repos[0];
  const ok = repos.filter((r) => !r.error);
  const never = new Set((master.setup && master.setup.never) || []);
  const people = new Map();
  const add = (handle, name, role) => {
    if (!handle || never.has(handle.toLowerCase())) return;
    const p = people.get(handle) || { handle, name: handle, role: '' };
    if (name && p.name === handle) p.name = name;
    if (role && !p.role) p.role = role;
    people.set(handle, p);
  };
  for (const c of (master.setup && master.setup.coders) || []) add(c.handle, c.name, SETUP_ROLE[c.role] || '');
  for (const r of ok) for (const m of (r.review && r.review.team) || []) add(m.handle, m.name, roleOf(m.role));
  for (const r of ok) for (const h of Object.keys(r.work || {})) add(h);

  // a person's team repo: the one whose work folder or team (as the one non-PI member) is theirs
  const teamOf = (h) => ok.filter((r) => !r.master && ((r.work && r.work[h]) || ((r.review && r.review.team) || []).some((m) => m.handle === h && roleOf(m.role) !== 'PI')));
  const out = [];
  for (const p of people.values()) {
    const h = p.handle;
    const events = mergeById(...ok.map((r) => ((r.work && r.work[h]) || []).filter((e) => e.coder === h)));
    const mine = teamOf(h);
    // samples: one copy per id, the master's first (it holds every coder's order), else the person's team repo's
    const byId = new Map();
    for (const r of [master, ...mine].filter((x) => !x.error)) for (const s of r.samples || []) {
      const has = s.coders ? s.coders.includes(h) || s.units.some((u) => u.order[h]) : events.some((e) => e.sample === s.id);
      if (has && !byId.has(s.id)) byId.set(s.id, s);
    }
    const samples = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => {
      const units = assignedUnits(s, h);
      const frame = s.frame;
      return { id: s.id, title: s.title || s.id, assigned: units.length, done: units.filter((u) => isDone(events, { coder: h, sample: s.id, unit: u.unit, frame })).length,
               submitted: submittedBy(events, s.id).has(h) };
    }).filter((s) => s.assigned > 0);
    // screening: the person's team repo records if it has any, else the master's (less records excluded by agreement)
    let screening = null, firstDate = null;
    const teamRec = mine.find((r) => r.records);
    const masterScreens = master.records && !master.error && (p.role === 'PI' || /Screener/.test(p.role) || (master.first && master.first.screener === h)
      || events.some((e) => e.type === 'screen-decision' && master.records.includes(e.record)));
    const ids = teamRec ? teamRec.records : masterScreens ? master.records.filter((id) => !(master.agreed || []).includes(id)) : null;
    if (ids) {
      const decided = new Set(events.filter((e) => e.type === 'screen-decision' && e.record).map((e) => e.record));
      if (master.first && master.first.screener === h && !master.error) { for (const id of master.first.ids) decided.add(id); firstDate = master.first.date; }
      screening = { assigned: ids.length, decided: ids.filter((id) => decided.has(id)).length };
    }
    let last = events.length ? events[events.length - 1].t : null;
    if (firstDate && (!last || firstDate > last)) last = firstDate;
    const lastMs = last ? Date.parse(last) : NaN;
    const days = Number.isFinite(lastMs) ? Math.floor((now - lastMs) / DAY) : null;
    const hasWork = samples.length > 0 || (screening && screening.assigned > 0);
    const finished = hasWork && samples.every((s) => s.submitted) && (!screening || screening.decided >= screening.assigned);
    const state = !hasWork ? 'nothing' : finished ? 'finished' : days == null ? 'none-yet' : days >= staleDays ? 'stale' : 'active';
    out.push({ handle: h, name: p.name, role: p.role, samples, screening, last: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null, days, state });
  }
  const order = { PI: 0 };
  out.sort((a, b) => (order[a.role] ?? 1) - (order[b.role] ?? 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { title: (master.review && master.review.title) || master.repo, people: out };
}

/** Whether a person needs a look: work outstanding and no activity for staleDays or more, or none at all. */
export const needsLook = (p) => p.state === 'stale' || p.state === 'none-yet';

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The list location from ?list=owner/repo:path, or null. */
export function parseListRef(s) {
  const m = /^([\w.-]+\/[\w.-]+):([\w./-]+\.json)$/.exec(String(s || '').trim());
  return m && !m[2].split('/').includes('..') ? { repo: m[1], path: m[2] } : null;
}

/** The list file checked: {stale_days, app, projects: [{repo, team, open}], sites: [{name, repo}]}. Throws with a plain message. */
export function parseList(obj) {
  if (!obj || typeof obj !== 'object' || obj.schema !== 1) throw new Error('The list file must be a JSON object with "schema": 1.');
  if (!Array.isArray(obj.projects) || !obj.projects.length) throw new Error('The list file names no projects ("projects": [{"repo": "owner/name"}]).');
  const url = (u, what) => { if (u == null) return null; if (typeof u !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(u)) throw new Error(`${what} must be an https:// address.`); return u; };
  const projects = obj.projects.map((p, i) => {
    if (!p || !REPO.test(p.repo || '')) throw new Error(`Project ${i + 1} needs "repo": "owner/name".`);
    const team = p.team == null ? [] : p.team;
    if (!Array.isArray(team) || !team.every((t) => REPO.test(t))) throw new Error(`Project ${p.repo}: "team" must be a list of "owner/name".`);
    return { repo: p.repo, team, open: url(p.open, `Project ${p.repo}: "open"`) };
  });
  const sites = (obj.sites == null ? [] : obj.sites).map((s, i) => {
    if (!s || !REPO.test(s.repo || '')) throw new Error(`Site ${i + 1} needs "repo": "owner/name".`);
    return { name: typeof s.name === 'string' && s.name ? s.name : s.repo, repo: s.repo };
  });
  const stale = obj.stale_days == null ? 7 : obj.stale_days;
  if (!Number.isInteger(stale) || stale < 1) throw new Error('"stale_days" must be a whole number of days, 1 or more.');
  return { stale_days: stale, app: url(obj.app, '"app"'), projects, sites };
}

/** The link that opens a project in its app, or null when no app address is set. */
export function openLink(entry, list) {
  const base = entry.open || list.app;
  if (!base) return null;
  return base + (base.includes('?') ? '&' : '?') + 'repo=' + entry.repo;
}

/** A Pages build (GET /pages/builds/latest) or, failing that, the latest Actions run, as {result, at}. */
export function deployOf(build, run) {
  if (build && build.status) {
    const result = build.status === 'built' ? 'Succeeded' : build.status === 'errored' ? 'Failed' : 'In progress';
    return { result, at: build.updated_at || build.created_at || null };
  }
  if (run && run.status) {
    const result = run.status !== 'completed' ? 'In progress' : run.conclusion === 'success' ? 'Succeeded' : 'Failed';
    return { result, at: run.updated_at || run.created_at || null };
  }
  return null;
}

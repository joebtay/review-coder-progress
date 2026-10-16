// A read-only GitHub client for the progress page (PI, 15 October 2026). It can only GET: guardFetch refuses any
// other method before a request leaves the page, so the page can never write to a repo. The token lives in this
// object only, never in storage, and goes only to the API address (api.github.com, or a localhost mock for tests).

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** fetch, refusing anything but GET. */
export function guardFetch(fetchImpl) {
  return (url, init = {}) => {
    const m = String(init.method || 'GET').toUpperCase();
    if (m !== 'GET') throw new Error(`The progress page is read only: ${m} refused.`);
    return fetchImpl(url, { ...init, method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  };
}

/** The API address: api.github.com, or ?api=http://localhost:PORT for the tests' mock GitHub. */
export function apiBase(search) {
  const q = new URLSearchParams(search || '').get('api');
  return q && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q) ? q : 'https://api.github.com';
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export class ReadOnlyGitHub {
  constructor({ token, api = 'https://api.github.com', fetchImpl = globalThis.fetch.bind(globalThis), limit = 8 }) {
    const t = token;
    this.api = api;
    this._fetch = guardFetch(fetchImpl);
    this._headers = (raw) => ({ Authorization: `Bearer ${t}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    this._limit = limit; this._active = 0; this._queue = [];
    this.requests = 0;
  }

  async _slot(fn) {
    if (this._active >= this._limit) await new Promise((r) => this._queue.push(r));
    this._active++;
    try { return await fn(); } finally { this._active--; const n = this._queue.shift(); if (n) n(); }
  }

  /** GET a path; JSON back, or text with raw. Throws HttpError (status 0 when the network is down). */
  get(path, { raw = false } = {}) {
    return this._slot(async () => {
      this.requests++;
      let res;
      try { res = await this._fetch(this.api + path, { headers: this._headers(raw) }); } catch (e) {
        if (/read only/.test(e.message)) throw e;
        throw new HttpError(0, 'GitHub could not be reached. Check the connection and try again.');
      }
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).message || msg; } catch {}
        if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
          const at = Number(res.headers.get('x-ratelimit-reset')) * 1000;
          msg = `GitHub's hourly limit is used up${at ? `; it resets at ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}.`;
        }
        throw new HttpError(res.status, msg);
      }
      return raw ? res.text() : res.json();
    });
  }

  user() { return this.get('/user'); }

  /** Every file path in a repo's default branch, and whether GitHub cut the list short. */
  async tree(repo) {
    const info = await this.get(`/repos/${repo}`);
    const t = await this.get(`/repos/${repo}/git/trees/${encodeURIComponent(info.default_branch || 'main')}?recursive=1`);
    return { paths: (t.tree || []).filter((x) => x.type === 'blob').map((x) => x.path), truncated: !!t.truncated };
  }

  async readJSON(repo, path) { return JSON.parse(await this.get(`/repos/${repo}/contents/${encPath(path)}`, { raw: true })); }

  /** GET that gives null on 404 (and on 403 when allowNoAccess), for optional endpoints such as Pages. */
  async maybe(path, allowNoAccess = false) {
    try { return await this.get(path); } catch (e) { if (e.status === 404 || (allowNoAccess && e.status === 403)) return null; throw e; }
  }
}

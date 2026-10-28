// Thin wrapper over the GitHub REST API, used straight from the browser.

const API = "https://api.github.com";
export const WORKFLOW = "build.yml";
const CONFIG_PATH = "config/apps.json";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  constructor(token, fullName) {
    this.token = token;
    this.fullName = fullName;
    this.branch = "main";
  }

  async request(path, { method = "GET", body, raw = false } = {}) {
    const headers = {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body), cache: "no-store" });
    } catch {
      throw new HttpError(0, "Can't reach GitHub. Check your connection.");
    }
    if (!res.ok) {
      let message = `GitHub returned ${res.status}`;
      try {
        message = (await res.json()).message || message;
      } catch {}
      if (res.status === 401) message = "Your token was rejected (expired or revoked).";
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") message = "GitHub rate limit reached, try again in a bit.";
      throw new HttpError(res.status, message);
    }
    if (res.status === 204 || res.status === 202) return null;
    return raw ? res.text() : res.json();
  }

  repoPath(suffix = "") {
    return `/repos/${this.fullName}${suffix}`;
  }

  // --- this source repo ---

  async verify() {
    const repo = await this.request(this.repoPath());
    if (!repo.permissions?.push) {
      throw new HttpError(403, `This token can read ${repo.full_name} but can't write to it. Give it Contents: read and write.`);
    }
    this.branch = repo.default_branch;
    return repo;
  }

  async readJSON(path) {
    try {
      const text = await this.request(this.repoPath(`/contents/${path}?ref=${this.branch}`), { raw: true });
      return JSON.parse(text);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async readConfig() {
    const file = await this.request(this.repoPath(`/contents/${CONFIG_PATH}?ref=${this.branch}`));
    return { config: JSON.parse(decodeBase64(file.content)), sha: file.sha };
  }

  // Apply `change` to the latest config and commit it, retrying if someone
  // else committed in between. Returns the new commit SHA.
  async updateConfig(message, change) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { config, sha } = await this.readConfig();
      change(config);
      try {
        const res = await this.request(this.repoPath(`/contents/${CONFIG_PATH}`), {
          method: "PUT",
          body: { message, content: encodeBase64(JSON.stringify(config, null, 2) + "\n"), sha, branch: this.branch },
        });
        return { sha: res.commit.sha, config };
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
    throw new HttpError(409, "The config kept changing while saving. Try again.");
  }

  async latestRun() {
    const res = await this.request(this.repoPath(`/actions/workflows/${WORKFLOW}/runs?per_page=1`));
    return res.workflow_runs[0] || null;
  }

  async runForCommit(sha) {
    const res = await this.request(this.repoPath(`/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=1`));
    return res.workflow_runs[0] || null;
  }

  async dispatch(inputs) {
    const startedAt = Date.now();
    await this.request(this.repoPath(`/actions/workflows/${WORKFLOW}/dispatches`), {
      method: "POST",
      body: { ref: this.branch, inputs },
    });
    return startedAt;
  }

  async runDispatchedAfter(time) {
    const res = await this.request(this.repoPath(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`));
    return res.workflow_runs.find((r) => Date.parse(r.created_at) >= time - 10_000) || null;
  }

  // --- other people's repos ---

  getRepo(fullName) {
    return this.request(`/repos/${fullName}`);
  }

  getReleases(fullName) {
    return this.request(`/repos/${fullName}/releases?per_page=15`);
  }
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Accepts github.com URLs (repo, releases, tag, asset download) or "owner/repo".
export function parseRepoInput(input) {
  const text = input.trim();
  let m = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!m) m = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const asset = text.match(/\/releases\/download\/[^/]+\/([^/?#]+)/i);
  return { fullName: `${m[1]}/${m[2]}`, assetName: asset ? decodeURIComponent(asset[1]) : null };
}

// Turn "Feather_v1.4.2-sideload.ipa" into a regex that also matches next
// release's "Feather_v1.5.0-sideload.ipa".
export function patternForAsset(name) {
  return (
    "^" +
    name
      .split(/\d+(?:\.\d+)*/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\d+(?:\\.\\d+)*") +
    "$"
  );
}

export const DEFAULT_PATTERN = "\\.ipa$";

export function isAppAsset(name) {
  return /\.(ipa|tipa)$/i.test(name);
}

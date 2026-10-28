"""Build docs/source.json (an AltStore source) from GitHub releases.

Reads config/apps.json, looks at each repo's releases, downloads any .ipa
it has not seen before (results are cached in state/cache.json by asset),
and writes:

  docs/source.json   the AltStore / SideStore / FlareStore source
  docs/status.json   per-app health shown by the admin web app
  docs/icons/*.png   app icons extracted from the .ipa files

Environment:
  GITHUB_TOKEN       optional, raises the API rate limit
  GITHUB_REPOSITORY  owner/repo of this source repo (set by Actions)
  ONLY_APP           owner/repo: refresh just this app, keep the rest as-is
  FORCE              "true": ignore the cache for the apps being refreshed
"""

import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import duo  # noqa: E402
import ipa  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "apps.json"
CACHE = ROOT / "state" / "cache.json"
DOCS = ROOT / "docs"
SOURCE = DOCS / "source.json"
STATUS = DOCS / "status.json"
ICONS = DOCS / "icons"

API = "https://api.github.com"
CATEGORIES = {"developer", "entertainment", "games", "lifestyle", "other", "photo-video", "social", "utilities"}
DEFAULT_PATTERN = r"\.ipa$"
RELEASES_TO_SCAN = 30
USER_AGENT = "altsource-generator"


# --- helpers ---------------------------------------------------------------

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")


def api(path):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    req = urllib.request.Request(API + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise AppError("repo not found (deleted, renamed or private?)", permanent=True)
        if e.code in (403, 429):
            raise AppError("GitHub API rate limit hit, will retry next run")
        raise AppError(f"GitHub API error {e.code} for {path}")
    except urllib.error.URLError as e:
        raise AppError(f"network error talking to GitHub: {e.reason}")


def download(url, dest):
    """Stream `url` to `dest`, returning its sha256. No auth header: release
    downloads redirect to a signed storage URL that rejects extra auth."""
    digest = hashlib.sha256()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dest, "wb") as out:
        while chunk := resp.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


class Releases:
    """Publishes patched .ipa files as release assets in this source repo."""

    PREFIX = "duo-"

    def __init__(self, repo, token):
        self.repo = repo
        self.token = token

    def request(self, method, url, body=None, data=None, content_type=None, length=None):
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        if length is not None:
            headers["Content-Length"] = str(length)
        req = urllib.request.Request(url if url.startswith("https://") else API + url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                text = resp.read()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise AppError(f"GitHub API error {e.code} publishing iPhone Duo build: {e.read()[:200]!r}")

    def publish(self, tag, title, notes, name, path):
        release = self.request("GET", f"/repos/{self.repo}/releases/tags/{tag}")
        if not release:
            release = self.request("POST", f"/repos/{self.repo}/releases", body={
                "tag_name": tag, "name": title, "body": notes, "make_latest": "false",
            })
        size = path.stat().st_size
        for existing in release.get("assets", []):
            if existing["name"] == name:
                if existing["size"] == size:
                    return existing["browser_download_url"]
                self.request("DELETE", f"/repos/{self.repo}/releases/assets/{existing['id']}")
        upload = f"https://uploads.github.com/repos/{self.repo}/releases/{release['id']}/assets?name={urllib.parse.quote(name)}"
        with open(path, "rb") as f:
            asset = self.request("POST", upload, data=f, content_type="application/octet-stream", length=size)
        return asset["browser_download_url"]

    def prune(self, keep_tags):
        """Delete iPhone Duo releases (and their tags) nothing uses any more."""
        page = 1
        while True:
            releases = self.request("GET", f"/repos/{self.repo}/releases?per_page=100&page={page}") or []
            for release in releases:
                tag = release["tag_name"]
                if tag.startswith(self.PREFIX) and tag not in keep_tags:
                    print(f"removing unused iPhone Duo release {tag}")
                    self.request("DELETE", f"/repos/{self.repo}/releases/{release['id']}")
                    self.request("DELETE", f"/repos/{self.repo}/git/refs/tags/{urllib.parse.quote(tag)}")
            if len(releases) < 100:
                break
            page += 1


PUBLISHER = None


def mark_used(cache, app):
    """Keep the cache entries (and iPhone Duo builds) behind an app entry we
    are re-serving without rebuilding it."""
    shas = {v.get("sha256") for v in app.get("versions", [])}
    for m in cache.values():
        if m.get("sha256") in shas:
            m["_used"] = True
        if (m.get("duo") or {}).get("sha256") in shas:
            m["_used"] = True
            m["_duoUsed"] = True


def clean_notes(text):
    text = re.sub(r"<!--.*?-->", "", text or "", flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)            # images
    text = re.sub(r"<img[^>]*>", "", text, flags=re.I)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)        # links -> text
    text = re.sub(r"^(>\s*)\[!(\w+)\]\s*$", lambda m: m.group(1) + m.group(2).capitalize() + ":", text, flags=re.M)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.M)          # headings
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:4000] + ("…" if len(text) > 4000 else "")


def pages_url(config):
    explicit = (config.get("source") or {}).get("pagesURL")
    if explicit:
        return explicit.rstrip("/") + "/"
    owner, _, repo = os.environ.get("GITHUB_REPOSITORY", "owner/altsource").partition("/")
    if repo.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner.lower()}.github.io/"
    return f"https://{owner.lower()}.github.io/{repo}/"


class AppError(Exception):
    def __init__(self, message, permanent=False):
        super().__init__(message)
        self.permanent = permanent


# --- per app ---------------------------------------------------------------

def asset_key(asset):
    return f"{asset['id']}:{asset['size']}:{asset['updated_at']}"


def build_app(entry, cache, force, base_url, warnings):
    repo_name = entry["repo"]
    pattern = re.compile(entry.get("assetPattern") or DEFAULT_PATTERN, re.I)
    max_versions = max(1, int(entry.get("maxVersions") or 5))
    overrides = entry.get("overrides") or {}

    repo = api(f"/repos/{repo_name}")
    releases = api(f"/repos/{repo_name}/releases?per_page={RELEASES_TO_SCAN}")
    # The API's order isn't strictly by date (rolling "nightly" tags), and
    # AltStore treats the first entry in `versions` as the latest.
    releases.sort(key=lambda r: r.get("published_at") or r.get("created_at") or "", reverse=True)

    candidates = []
    for release in releases:
        if release.get("draft") or (release.get("prerelease") and not entry.get("includePrereleases")):
            continue
        asset = next((a for a in release.get("assets", []) if pattern.search(a["name"])), None)
        if asset:
            candidates.append((release, asset))
        if len(candidates) >= max_versions:
            break
    if not releases:
        raise AppError("repo has no GitHub releases", permanent=True)
    if not candidates:
        raise AppError(f"no release asset matching /{pattern.pattern}/ in the last {len(releases)} releases", permanent=True)

    duo_mode = entry.get("duoPatch") or "auto"
    versions, icon_png = [], None
    bundle_id = None
    seen = set()
    for release, asset in candidates:
        key = asset_key(asset)
        meta = None if force else cache.get(key)
        if meta and "sdkVersion" not in meta:
            meta = None  # cached before SDK detection existed
        icon_path = ICONS / f"{meta['bundleIdentifier']}.png" if meta else None
        if meta and not versions and meta.get("hasIcon") and not icon_path.exists():
            meta = None  # need the icon back, so re-read the ipa

        with tempfile.TemporaryDirectory() as tmp:
            original = Path(tmp) / "app.ipa"
            downloaded = False

            def fetch():
                print(f"  downloading {asset['name']} ({asset['size'] // 1024 // 1024} MB)")
                try:
                    return download(asset["browser_download_url"], original)
                except Exception as e:
                    raise AppError(f"could not download {asset['name']}: {e}")

            if meta is None:
                sha = fetch()
                downloaded = True
                try:
                    info = ipa.read_ipa(original)
                except ipa.IPAError as e:
                    warnings.append(f"{release['tag_name']}: skipped, {e}")
                    continue
                icon = info.pop("icon")
                meta = {**info, "sha256": sha, "hasIcon": bool(icon)}
                cache[key] = meta
                if icon and not versions:
                    icon_png = icon
            meta["_used"] = True

            if bundle_id is None:
                bundle_id = meta["bundleIdentifier"]
            elif meta["bundleIdentifier"] != bundle_id:
                warnings.append(f"{release['tag_name']}: skipped, bundle ID {meta['bundleIdentifier']} differs from latest ({bundle_id})")
                continue
            version_key = (meta["version"], meta["buildVersion"])
            if version_key in seen:
                warnings.append(f"{release['tag_name']}: skipped, same version {meta['version']} ({meta['buildVersion']}) as a newer release; AltStore can't tell them apart")
                continue
            seen.add(version_key)

            # iPhone Duo: raise the SDK stamp of older builds, host the result.
            wants_duo = duo_mode == "auto" and duo.needs_patch(meta.get("sdkVersion"))
            if wants_duo and not meta.get("duo"):
                if not PUBLISHER:
                    if not versions:
                        warnings.append("can't publish iPhone Duo builds without GITHUB_TOKEN; serving the original")
                else:
                    if not downloaded:
                        fetch()
                    patched = Path(tmp) / "duo.ipa"
                    try:
                        changed = duo.patch_ipa(original, patched)
                    except Exception as e:
                        changed = 0
                        warnings.append(f"{release['tag_name']}: iPhone Duo patch failed ({e}); serving the original")
                    if changed:
                        name = duo.asset_name(asset["name"])
                        tag = duo.release_tag(meta["bundleIdentifier"], meta["version"], meta["buildVersion"])
                        print(f"  publishing iPhone Duo build {name} (SDK {meta['sdkVersion']} -> {duo.TARGET_SDK})")
                        url = PUBLISHER.publish(
                            tag,
                            f"{meta.get('name') or repo['name']} {meta['version']} (iPhone Duo)",
                            f"{repo['full_name']} {release['tag_name']} with its SDK stamp raised from "
                            f"{meta['sdkVersion']} to {duo.TARGET_SDK} so it fills the iPhone Duo inner display.\n\n"
                            f"Original: {asset['browser_download_url']}",
                            name,
                            patched,
                        )
                        meta["duo"] = {"tag": tag, "url": url, "size": patched.stat().st_size, "sha256": file_sha256(patched)}

        duo_build = meta.get("duo") if wants_duo else None
        if duo_build:
            meta["_duoUsed"] = True
        version = {
            "version": meta["version"],
            "buildVersion": meta["buildVersion"],
            "date": release.get("published_at") or release.get("created_at"),
            "localizedDescription": clean_notes(release.get("body")) or release.get("name") or release["tag_name"],
            "downloadURL": duo_build["url"] if duo_build else asset["browser_download_url"],
            "size": duo_build["size"] if duo_build else asset["size"],
            "sha256": duo_build["sha256"] if duo_build else meta["sha256"],
        }
        if meta.get("minOSVersion"):
            version["minOSVersion"] = str(meta["minOSVersion"])
        versions.append((version, meta))

    if not versions:
        raise AppError("every matching release was skipped (see warnings)", permanent=True)

    latest_version, latest_meta = versions[0]
    ICONS.mkdir(parents=True, exist_ok=True)
    icon_file = ICONS / f"{bundle_id}.png"
    if icon_png:
        icon_file.write_bytes(icon_png)

    icon_url = overrides.get("iconURL")
    if not icon_url and icon_file.exists():
        icon_url = f"{base_url}icons/{bundle_id}.png"
    if not icon_url:
        icon_url = f"https://github.com/{repo['owner']['login']}.png?size=256"

    tint = overrides.get("tintColor") or (ipa.tint_color(icon_file.read_bytes()) if icon_file.exists() else None) or "#5B6CFF"

    entitlements = sorted({e for _, m in versions for e in m["entitlements"]})
    privacy = {}
    for _, m in versions:
        for k, v in m["privacy"].items():
            privacy.setdefault(k, v)

    category = overrides.get("category") or "other"
    if category not in CATEGORIES:
        warnings.append(f"unknown category '{category}', using 'other'")
        category = "other"

    description = overrides.get("description") or repo.get("description") or ""
    description = (description + f"\n\nSource: {repo['html_url']}").strip()

    app = {
        "name": overrides.get("name") or latest_meta.get("name") or repo["name"],
        "bundleIdentifier": bundle_id,
        "developerName": overrides.get("developerName") or repo["owner"]["login"],
        "subtitle": (overrides.get("subtitle") or repo.get("description") or "")[:120],
        "localizedDescription": description,
        "iconURL": icon_url,
        "tintColor": tint,
        "category": category,
        "screenshots": overrides.get("screenshots") or [],
        "versions": [v for v, _ in versions],
        "appPermissions": {"entitlements": entitlements, "privacy": privacy},
        # Legacy single-version fields for older AltStore forks.
        "version": latest_version["version"],
        "versionDate": latest_version["date"],
        "versionDescription": latest_version["localizedDescription"],
        "downloadURL": latest_version["downloadURL"],
        "size": latest_version["size"],
    }
    status = {
        "name": app["name"],
        "bundleIdentifier": bundle_id,
        "version": latest_version["version"],
        "buildVersion": latest_version["buildVersion"],
        "updatedAt": latest_version["date"],
        "latestTag": candidates[0][0]["tag_name"],
        "iconURL": icon_url,
        "versions": len(versions),
        "sdkVersion": latest_meta.get("sdkVersion"),
        "duo": duo_state(duo_mode, latest_meta),
    }
    return app, status


def duo_state(mode, meta):
    """How the latest version runs on iPhone Duo, for the web app."""
    if not meta.get("sdkVersion"):
        return "unknown"
    if not duo.needs_patch(meta["sdkVersion"]):
        return "ready"
    if mode != "auto":
        return "off"
    return "patched" if meta.get("duo") else "original"


# --- main ------------------------------------------------------------------

def main():
    config = load_json(CONFIG, {"source": {}, "apps": []})
    cache = load_json(CACHE, {})
    previous_source = load_json(SOURCE, {})
    previous_status = load_json(STATUS, {}).get("apps", {})
    previous_apps = {}
    for app in previous_source.get("apps", []):
        repo = app.get("_repo")
        if repo:
            previous_apps[repo.lower()] = app

    global PUBLISHER
    if os.environ.get("GITHUB_TOKEN") and os.environ.get("GITHUB_REPOSITORY"):
        PUBLISHER = Releases(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_TOKEN"])

    only = (os.environ.get("ONLY_APP") or "").strip().lower()
    force = os.environ.get("FORCE", "").lower() == "true"
    base_url = pages_url(config)

    apps, statuses, bundle_owner = [], {}, {}
    for entry in config.get("apps", []):
        repo = entry["repo"]
        key = repo.lower()
        warnings = []
        if only and key != only and key in previous_apps:
            app = previous_apps[key]
            status = previous_status.get(repo) or {"state": "ok"}
            mark_used(cache, app)
        else:
            print(f"{repo}")
            try:
                app, status = build_app(entry, cache, force and (not only or key == only), base_url, warnings)
                app["_repo"] = repo
                status["state"] = "warning" if warnings else "ok"
            except AppError as e:
                print(f"  error: {e}")
                app = previous_apps.get(key)
                status = dict(previous_status.get(repo) or {})
                status["state"] = "error"
                warnings.insert(0, str(e) + (" (still serving the last good version)" if app else ""))
                if app:
                    mark_used(cache, app)
            status["messages"] = warnings
            for w in warnings:
                print(f"  {w}")

        if app:
            bundle_id = app["bundleIdentifier"]
            if bundle_id in bundle_owner:
                status = {**status, "state": "error", "messages": [
                    f"bundle ID {bundle_id} is already used by {bundle_owner[bundle_id]}; AltStore sources can't list it twice"
                ] + status.get("messages", [])}
                app = None
            else:
                bundle_owner[bundle_id] = repo
        if app:
            apps.append(app)
        statuses[repo] = status

    source_cfg = config.get("source") or {}
    owner, _, repo_name = os.environ.get("GITHUB_REPOSITORY", "owner/altsource").partition("/")
    source = {
        "name": source_cfg.get("name") or "My AltStore Source",
        "identifier": source_cfg.get("identifier") or f"io.github.{owner}.{repo_name}".lower(),
        "subtitle": source_cfg.get("subtitle") or "Apps from GitHub releases",
        "description": source_cfg.get("description") or "Apps tracked automatically from GitHub releases.",
        "iconURL": source_cfg.get("iconURL") or f"{base_url}admin/icon-512.png",
        "website": source_cfg.get("website") or base_url,
        "tintColor": source_cfg.get("tintColor") or "#5B6CFF",
        "featuredApps": [a["bundleIdentifier"] for a in apps[:5]],
        "apps": apps,
        "news": [],
    }

    write_json(SOURCE, source)
    write_json(STATUS, {"sourceURL": f"{base_url}source.json", "apps": statuses})

    # Prune cache entries and icons that nothing references any more.
    for k in [k for k, m in cache.items() if not m.pop("_used", False)]:
        del cache[k]
    for m in cache.values():
        if not m.pop("_duoUsed", False):
            m.pop("duo", None)
    if PUBLISHER:
        PUBLISHER.prune({m["duo"]["tag"] for m in cache.values() if m.get("duo")})
    write_json(CACHE, dict(sorted(cache.items())))
    keep = {f"{a['bundleIdentifier']}.png" for a in apps}
    if ICONS.exists():
        for icon in ICONS.glob("*.png"):
            if icon.name not in keep:
                icon.unlink()

    errors = sum(1 for s in statuses.values() if s.get("state") == "error")
    print(f"\n{len(apps)} app(s) in source, {errors} with errors")


if __name__ == "__main__":
    main()

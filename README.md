# altsource

A personal AltStore source (works with AltStore, SideStore, FlareStore and
other AltStore-compatible stores) built automatically from GitHub releases,
plus a phone web app to manage it.

- Add a GitHub repo → it shows up as an app in the source.
- When that repo publishes a new release with an `.ipa`, the source updates
  and your store shows an update.
- Everything runs on GitHub (Actions + Pages). No server, free.

```
phone web app ──(GitHub API, your token)──▶ config/apps.json
                                               │ push
                                               ▼
                        GitHub Action (on push + every 30 min)
                        reads each new .ipa: bundle ID, version, build,
                        permissions, icon → docs/source.json
                                               │
                                               ▼
           https://<you>.github.io/altsource/source.json   ← add to FlareStore
           https://<you>.github.io/altsource/admin/        ← manage from phone
```

## Setup (about 10 minutes)

> **Use your personal GitHub account for every step.** Before each step on
> github.com, check the avatar in the top-right corner is your personal
> account, not a work one.

### 1. Create the repo

On github.com, signed in to your **personal** account, create a new
**public** repository called `altsource`. Leave it empty (no README,
no .gitignore).

It has to be public: free GitHub Pages needs it, and your store app must
be able to download `source.json` without signing in.

### 2. Push this folder

This folder is already a git repo, and its commit email is set (for this repo
only) to your personal address. Set your name too, then commit and push.
Replace `YOUR-USERNAME` with your personal GitHub username:

```bash
git config user.name "Your Name"
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://YOUR-USERNAME@github.com/YOUR-USERNAME/altsource.git
git push -u origin main
```

Putting `YOUR-USERNAME@` in the remote URL makes Git Credential Manager use
your personal login instead of any work login it has saved. If a browser
window pops up to sign in, sign in with the personal account.

Check the identity before pushing with `git config user.email`. It should
print your personal address.

### 3. Turn on GitHub Pages

Repo → **Settings → Pages** → Source: **Deploy from a branch** →
Branch: `main`, folder: `/docs` → Save.

### 4. Run the first build

Repo → **Actions** → **Build source** → **Run workflow**. After it finishes
(under a minute), `https://YOUR-USERNAME.github.io/altsource/source.json`
exists. Pages can take a few minutes to go live the first time.

If the workflow fails with a permission error on `git push`, go to
**Settings → Actions → General → Workflow permissions** and choose
**Read and write permissions**.

### 5. Make a token for the phone app

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**
([direct link](https://github.com/settings/personal-access-tokens/new)):

| Setting | Value |
|---|---|
| Resource owner | your personal account |
| Expiration | 90 days (the app tells you when it's rejected) |
| Repository access | Only select repositories → `altsource` |
| Permissions → Contents | Read and write |
| Permissions → Actions | Read and write |

Copy the token.

### 6. Set up your phone

1. In Safari, open `https://YOUR-USERNAME.github.io/altsource/admin/`.
2. Share → **Add to Home Screen**.
3. Open it from the home screen, paste the token, tap **Connect**.
4. Settings (⚙︎) → **Copy source URL**, then add it as a source in
   FlareStore (or use **Open in AltStore / SideStore**).

### 7. Optional: add apps from the share sheet

iOS doesn't let web apps appear in the share sheet, but a Shortcut can:

1. Shortcuts → new shortcut → enable **Show in Share Sheet**, input type **URLs**.
2. Add action **Copy to Clipboard** with **Shortcut Input**.
3. Add action **URL**: `https://YOUR-USERNAME.github.io/altsource/admin/#add=` then
   insert the **Shortcut Input** variable at the end.
4. Add action **Open URLs**.
5. Name it "Add to My Source".

Now on any GitHub repo page in Safari: Share → Add to My Source. The
admin page opens on **Add app** with that repo looked up.

- **It shows Connect:** the link opened in Safari, which keeps its own storage
  separate from the home-screen app. Connect once there; the repo you shared is
  kept and opens straight after.
- **It just brings the home-screen app to the front:** iOS passed no link. Tap
  **+ Add app → Paste**. Step 2 already put the link on the clipboard.

The page also accepts `?add=<url-encoded link>` in place of `#add=`.

### 8. Serve the source without caching (Cloudflare Worker)

GitHub Pages always tells apps they may cache files for 10 minutes, and
FlareStore keeps old copies of a source much longer than that, even after you
remove and re-add it. `cloudflare/worker.js` fixes this. It serves the current
`source.json` on every request with headers telling apps not to store it, and
logs each request so you can see when FlareStore re-downloads.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (free).
2. **Workers & Pages → Create → Create Worker**, name it `altsource`,
   **Deploy**.
3. **Edit code**, replace everything with `cloudflare/worker.js`, **Deploy**.
4. Your source URL is now
   `https://altsource.<your-subdomain>.workers.dev/source.json`.
5. In the web app → Settings → **Source URL to share**, paste that URL and
   save, so the copy/open buttons use it.
6. In FlareStore, remove the old source and add the Worker URL.

To see FlareStore's requests: Cloudflare dashboard → `altsource` Worker →
**Logs** → Begin log stream, then refresh the source in FlareStore.

## Using it

- **Add:** paste one or more GitHub links (repo, releases page, tag, or a
  direct `.ipa` download link). You'll see a preview, and the app warns you
  about private repos, repos without `.ipa` releases, duplicates and forks.
  If a release has several `.ipa` files, pick the one you want.
- **Update:** automatic. The Action checks every 30 minutes. Expect new releases
  to show up within roughly 10–45 minutes (GitHub's schedule plus Pages caching).
  Use **Refresh now** on an app to check it straight away.
- **Remove:** app → **Remove from source**. It stays installed on your
  devices but stops getting updates from this source.
- **Old versions:** each app keeps its newest 5 versions by default
  (change **Versions to keep**). Older versions can be installed from the
  store's version history.

## How it works

`scripts/generate.py` (standard-library Python, no dependencies):

1. Reads `config/apps.json`.
2. For each repo, lists recent releases and picks the asset matching the
   app's file pattern (default `\.ipa$`), skipping drafts and, unless
   enabled, pre-releases.
3. Downloads each `.ipa` it hasn't seen before and reads:
   - `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`,
     `MinimumOSVersion` from `Info.plist`
   - entitlements from the code signature of the app and its extensions
   - `NS…UsageDescription` privacy keys
   - the app icon (converted from Apple's CgBI PNG format)
   - SHA-256 of the file

   AltStore 2.x refuses to install apps whose version, build or
   permissions don't match the source, so these come from the file itself,
   not from release tags.
4. Caches results per release asset in `state/cache.json`, so each `.ipa`
   is downloaded only once.
5. Writes `docs/source.json`, `docs/status.json` and `docs/icons/`. The
   Action commits only when something changed.

If an app fails (repo deleted, network error, bad `.ipa`), the source keeps
serving that app's last good entry and the web app shows the error.

### iPhone Duo patch

iPhone Duo only lets apps fill its inner display if they were built with the
iOS 27.1 SDK or newer. Older builds are letterboxed. The SDK version is
recorded in the app's binary (`LC_BUILD_VERSION`), so instead of rebuilding
from source, `scripts/duo.py`:

1. reads the SDK version of every release (`sdkVersion` in `status.json`)
2. if it's older than 27.1, raises the SDK version in the main app and its
   extensions to 27.1, and updates `DTSDKName` / `DTPlatformVersion` in
   `Info.plist`
3. uploads the patched file as a release in this repo (tag
   `duo-<bundle id>-<version>-<build>`, file `<name>-duo.ipa`) and points the
   source at it

Patching breaks the original code signature. That doesn't matter, because
AltStore, SideStore and FlareStore re-sign apps before installing them.
Apps built with a new enough SDK are served unchanged.

It's on by default. Turn it off per app in the web app (app → iPhone Duo →
Use the original release) or with `"duoPatch": "off"` in `config/apps.json`.
Duo releases that nothing uses any more are deleted automatically.

Patched apps fill the screen only as well as their layout can stretch. Apps
with fixed-size screens may look stretched or misplaced, and rebuilding
unchanged source code with the newer SDK would look the same.

### Files

| Path | What |
|---|---|
| `config/apps.json` | Your list of repos and per-app settings (edited by the web app) |
| `scripts/generate.py`, `scripts/ipa.py` | Source generator |
| `.github/workflows/build.yml` | Runs the generator on push, every 30 min, or on demand |
| `state/cache.json` | Parsed `.ipa` metadata, keyed by release asset |
| `docs/source.json` | The AltStore source (generated) |
| `docs/status.json` | Per-app health for the web app (generated) |
| `docs/admin/` | The phone web app |
| `docs/index.html` | Public landing page with "Add to AltStore" buttons |

### Per-app settings (`config/apps.json`)

```json
{
  "repo": "owner/name",
  "assetPattern": "\\.ipa$",
  "includePrereleases": false,
  "maxVersions": 5,
  "overrides": {
    "name": "Display name",
    "subtitle": "One line",
    "description": "Longer text",
    "iconURL": "https://…",
    "tintColor": "#FF2E51",
    "category": "utilities",
    "screenshots": ["https://…"]
  }
}
```

Source-level settings live under `"source"`: `name`, `subtitle`,
`description`, `iconURL`, `tintColor`, `website`, and `identifier`.
The identifier defaults to `io.github.<owner>.<repo>`. **Don't change it
after adding the source to your phone**, or the store treats it as a new
source.

## Limits

- Only public repos. Release files of private repos need a login to download.
- Builds published only as Actions artifacts (not releases) aren't supported.
- If an upstream release or repo is deleted, its download link breaks.
- GitHub pauses scheduled workflows in repos with no commits for 60 days.
  The workflow makes an empty commit after 45 quiet days to prevent this.
- Two repos that produce the same bundle ID (e.g. a fork and the original)
  can't both be in one source. The first one added wins, and the other shows
  an error.

## Security

The admin page is public, but it can't do anything without your token. Every
change goes through the GitHub API, which requires write access to this repo.
The token is stored only in your phone's browser storage and is only ever sent
to `api.github.com`. If your phone is lost, revoke the token on GitHub.

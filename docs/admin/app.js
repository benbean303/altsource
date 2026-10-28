import { GitHub, HttpError, parseRepoInput, patternForAsset, DEFAULT_PATTERN, isAppAsset } from "./github.js";

const CATEGORIES = ["other", "developer", "entertainment", "games", "lifestyle", "photo-video", "social", "utilities"];
const store = {
  get(key) {
    try {
      return localStorage.getItem(`altsource.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`altsource.${key}`);
      else localStorage.setItem(`altsource.${key}`, value);
    } catch {}
  },
};

const state = {
  gh: null,
  config: null,
  status: null,
  source: null,
  run: null, // latest build run
  watching: false,
  loadError: null,
};

const root = document.getElementById("app");

// --- tiny DOM helper (always textContent, never innerHTML) -----------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function render(...nodes) {
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function toast(message, kind = "info") {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function ago(date) {
  if (!date) return "never";
  const s = Math.round((Date.now() - Date.parse(date)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

function bytes(n) {
  if (!n) return "";
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function icon(src, alt = "") {
  const img = h("img", { class: "icon", src: src || "icon-180.png", alt, loading: "lazy" });
  img.addEventListener("error", () => (img.src = "icon-180.png"), { once: true });
  return img;
}

function header(title, { back, actions } = {}) {
  return h(
    "header",
    { class: "bar" },
    back ? h("a", { class: "back", href: back }, "‹ Back") : h("span"),
    h("h1", {}, title),
    h("div", { class: "actions" }, actions || [])
  );
}

function errorBox(message) {
  return h("div", { class: "notice error" }, message);
}

// --- data ------------------------------------------------------------------

function detectRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return "";
  const first = location.pathname.split("/").filter(Boolean)[0];
  return !first || first === "admin" ? `${m[1]}/${m[1]}.github.io` : `${m[1]}/${first}`;
}

async function loadAll() {
  const gh = state.gh;
  const [cfg, status, source, run] = await Promise.all([
    gh.readConfig(),
    gh.readJSON("docs/status.json"),
    gh.readJSON("docs/source.json"),
    gh.latestRun().catch(() => null),
  ]);
  state.config = cfg.config;
  state.status = status || { apps: {} };
  state.source = source || { apps: [] };
  state.run = run;
  state.loadError = null;
  if (run && run.status !== "completed") watchRun(() => gh.latestRun());
}

function sourceURL() {
  return state.status?.sourceURL || new URL("../source.json", location.href).href;
}

function appStatus(repo) {
  return state.status?.apps?.[repo] || null;
}

function sourceApp(repo) {
  return state.source?.apps?.find((a) => a._repo?.toLowerCase() === repo.toLowerCase()) || null;
}

function building() {
  return state.run && state.run.status !== "completed";
}

// Poll a workflow run until it finishes, then reload everything.
async function watchRun(findRun) {
  if (state.watching) return;
  state.watching = true;
  refreshBuildBar();
  try {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, i < 3 ? 3000 : 5000));
      const run = await findRun().catch(() => null);
      if (run) state.run = run;
      refreshBuildBar();
      if (run && run.status === "completed") {
        await loadAll();
        if (run.conclusion === "success") toast("Source updated", "ok");
        else toast("Build failed, tap the status bar for the log", "error");
        break;
      }
    }
  } finally {
    state.watching = false;
    // Don't wipe a form the user is filling in; only redraw the home list.
    if (["", "#/"].includes(location.hash)) route();
    else refreshBuildBar();
  }
}

function buildBar() {
  const run = state.run;
  let text, cls = "build", href = run?.html_url;
  if (state.watching && (!run || run.status !== "completed")) {
    text = run?.status === "in_progress" ? "Building source…" : "Waiting for build to start…";
    cls += " busy";
  } else if (!run) {
    text = "No builds yet";
  } else if (run.status !== "completed") {
    text = "Building source…";
    cls += " busy";
  } else if (run.conclusion === "success") {
    text = `Source built ${ago(run.updated_at)}`;
    cls += " ok";
  } else {
    text = `Last build ${run.conclusion} ${ago(run.updated_at)}`;
    cls += " bad";
  }
  return h("a", { class: cls, id: "build-bar", href, target: "_blank", rel: "noopener" }, h("span", { class: "dot" }), text);
}

function refreshBuildBar() {
  document.getElementById("build-bar")?.replaceWith(buildBar());
}

async function save(message, change) {
  const { sha, config } = await state.gh.updateConfig(message, change);
  state.config = config;
  state.run = null;
  watchRun(() => state.gh.runForCommit(sha));
}

// --- screens ---------------------------------------------------------------

function setupScreen(message) {
  const repoInput = h("input", { value: store.get("repo") || detectRepo(), placeholder: "your-username/altsource", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const tokenInput = h("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off", autocapitalize: "off" });
  const error = h("div");
  const button = h("button", { class: "primary", type: "submit" }, "Connect");

  const form = h(
    "form",
    {
      class: "card stack",
      async onSubmit(e) {
        e.preventDefault();
        button.disabled = true;
        button.textContent = "Checking…";
        error.replaceChildren();
        const gh = new GitHub(tokenInput.value.trim(), repoInput.value.trim().replace(/^https?:\/\/github\.com\//i, ""));
        try {
          await gh.verify();
          store.set("repo", gh.fullName);
          store.set("token", gh.token);
          state.gh = gh;
          location.hash = "#/";
          await start();
        } catch (err) {
          error.replaceChildren(errorBox(err.message));
          button.disabled = false;
          button.textContent = "Connect";
        }
      },
    },
    h("label", {}, "Source repo", repoInput),
    h("label", {}, "GitHub token", tokenInput),
    error,
    button
  );

  render(
    header("Connect"),
    h(
      "main",
      {},
      message ? errorBox(message) : null,
      form,
      h(
        "div",
        { class: "card help" },
        h("h2", {}, "Making a token"),
        h(
          "ol",
          {},
          h("li", {}, "Sign in to GitHub with your personal account."),
          h("li", {}, "Open ", h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "Fine-grained tokens → Generate new token"), "."),
          h("li", {}, "Repository access: Only select repositories → your source repo."),
          h("li", {}, "Permissions: Contents read and write, Actions read and write."),
          h("li", {}, "Copy the token and paste it above. It's only stored on this device.")
        )
      )
    )
  );
}

function homeScreen() {
  const apps = state.config.apps || [];
  const list = apps.length
    ? h(
        "ul",
        { class: "list" },
        apps.map((entry) => {
          const st = appStatus(entry.repo);
          const busy = building() || state.watching;
          const badge = !st
            ? busy ? ["busy", "Building"] : ["warn", "Not built"]
            : st.state === "error" ? ["bad", "Error"] : st.state === "warning" ? ["warn", "Warning"] : ["ok", ""];
          return h(
            "li",
            {},
            h(
              "a",
              { href: `#/app/${entry.repo}`, class: "row" },
              icon(entry.overrides?.iconURL || st?.iconURL),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "title" }, entry.overrides?.name || st?.name || entry.repo.split("/")[1]),
                h("div", { class: "sub" }, st?.version ? `${st.version} · ${ago(st.updatedAt)}` : entry.repo)
              ),
              badge[1] ? h("span", { class: `badge ${badge[0]}` }, badge[1]) : null,
              h("span", { class: "chev" }, "›")
            )
          );
        })
      )
    : h("div", { class: "card empty" }, h("p", {}, "No apps yet."), h("a", { class: "button primary", href: "#/add" }, "Add your first app"));

  render(
    header(state.source?.name || "Source", { actions: [h("a", { class: "icon-button", href: "#/settings", "aria-label": "Settings" }, "⚙︎")] }),
    h(
      "main",
      {},
      buildBar(),
      state.loadError ? errorBox(state.loadError) : null,
      h("a", { class: "button primary wide", href: "#/add" }, "+ Add app"),
      list,
      apps.length ? h("p", { class: "footnote" }, `${apps.length} app${apps.length === 1 ? "" : "s"} · checks GitHub every 30 minutes`) : null
    )
  );
}

function addScreen(prefill = "") {
  const input = h("textarea", {
    rows: 2,
    placeholder: "Paste GitHub links, one per line\ngithub.com/owner/repo",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  input.value = prefill;
  const results = h("div", { class: "stack" });
  const lookup = h("button", { class: "primary", type: "submit" }, "Look up");

  async function run() {
    const lines = input.value.split(/\s+/).filter(Boolean);
    if (!lines.length) return;
    lookup.disabled = true;
    lookup.textContent = "Looking up…";
    results.replaceChildren();
    const previews = await Promise.all(lines.map((line) => preview(line)));
    results.replaceChildren(...previews.map((p) => p.node));
    const addable = previews.filter((p) => p.entry);
    if (addable.length) {
      const addButton = h(
        "button",
        {
          class: "primary wide",
          async onClick() {
            addButton.disabled = true;
            addButton.textContent = "Saving…";
            const entries = addable.map((p) => p.entry());
            try {
              const names = entries.map((e) => e.repo).join(", ");
              await save(`Add ${names}`, (config) => {
                config.apps ||= [];
                for (const entry of entries) {
                  if (!config.apps.some((a) => a.repo.toLowerCase() === entry.repo.toLowerCase())) config.apps.push(entry);
                }
              });
              toast(`Added ${entries.length} app${entries.length === 1 ? "" : "s"}, building…`, "ok");
              location.hash = "#/";
            } catch (e) {
              toast(e.message, "error");
              addButton.disabled = false;
              addButton.textContent = "Add";
            }
          },
        },
        addable.length === 1 ? "Add to source" : `Add ${addable.length} apps`
      );
      results.append(addButton);
    }
    lookup.disabled = false;
    lookup.textContent = "Look up";
  }

  render(
    header("Add app", { back: "#/" }),
    h(
      "main",
      {},
      h(
        "form",
        {
          class: "card stack",
          onSubmit(e) {
            e.preventDefault();
            run();
          },
        },
        input,
        lookup
      ),
      results
    )
  );
  if (prefill) run();
  else input.focus();
}

// Look up one pasted link. Returns { node, entry?() }.
async function preview(line) {
  const parsed = parseRepoInput(line);
  if (!parsed) return { node: h("div", { class: "card" }, h("div", { class: "title" }, line), errorBox("That doesn't look like a GitHub repo link.")) };

  let repo, releases;
  try {
    [repo, releases] = await Promise.all([state.gh.getRepo(parsed.fullName), state.gh.getReleases(parsed.fullName)]);
  } catch (e) {
    const msg = e.status === 404 ? "Repo not found. It may be private, renamed or deleted." : e.message;
    return { node: h("div", { class: "card" }, h("div", { class: "title" }, parsed.fullName), errorBox(msg)) };
  }

  const head = h(
    "div",
    { class: "row" },
    icon(repo.owner.avatar_url),
    h("div", { class: "grow" }, h("div", { class: "title" }, repo.full_name), h("div", { class: "sub" }, repo.description || "No description")),
    h("span", { class: "sub" }, `★ ${repo.stargazers_count}`)
  );
  const card = h("div", { class: "card stack" }, head);
  const fail = (msg) => {
    card.append(errorBox(msg));
    return { node: card };
  };

  if (state.config.apps.some((a) => a.repo.toLowerCase() === repo.full_name.toLowerCase())) return fail("Already in your source.");
  if (repo.private) return fail("Private repo: AltStore can't download its releases.");

  const released = (r) => Date.parse(r.published_at || r.created_at);
  const usable = releases.filter((r) => !r.draft).sort((a, b) => released(b) - released(a));
  const withApps = usable.filter((r) => r.assets.some((a) => isAppAsset(a.name)));
  if (!usable.length) return fail("This repo has no GitHub releases.");
  if (!withApps.length) return fail(`None of the last ${usable.length} releases has an .ipa file attached.`);

  const latest = withApps.find((r) => !r.prerelease) || withApps[0];
  const appAssets = latest.assets.filter((a) => isAppAsset(a.name));
  const forkNote = repo.fork ? h("div", { class: "notice warn" }, `Fork of ${repo.parent?.full_name || "another repo"}. If you also add the original, they'll likely clash on bundle ID.`) : null;

  // Asset choice -> pattern
  let pattern = appAssets.length === 1 && /\.ipa$/i.test(appAssets[0].name) ? DEFAULT_PATTERN : null;
  const preselect = appAssets.find((a) => a.name === parsed.assetName) || appAssets.find((a) => /\.ipa$/i.test(a.name)) || appAssets[0];
  if (!pattern) pattern = patternForAsset(preselect.name);

  const prerelease = h("input", { type: "checkbox", checked: latest.prerelease });
  const patternInput = h("input", { value: pattern, autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const matchInfo = h("div", { class: "sub" });

  function updateMatches() {
    let re;
    try {
      re = new RegExp(patternInput.value, "i");
    } catch {
      matchInfo.textContent = "Invalid pattern";
      return;
    }
    const considered = usable.filter((r) => prerelease.checked || !r.prerelease);
    const hits = considered.filter((r) => r.assets.some((a) => re.test(a.name)));
    const first = hits[0]?.assets.find((a) => re.test(a.name));
    matchInfo.textContent = hits.length
      ? `Latest: ${hits[0].tag_name} (${ago(hits[0].published_at)}), ${first.name}, ${bytes(first.size)}. Matches ${hits.length} of the last ${considered.length} releases.`
      : "No releases match. Try another file or include pre-releases.";
  }
  patternInput.addEventListener("input", updateMatches);
  prerelease.addEventListener("change", updateMatches);

  const picker =
    appAssets.length > 1
      ? h(
          "div",
          { class: "stack" },
          h("div", { class: "sub" }, `The latest release has ${appAssets.length} app files. Which one?`),
          appAssets.map((a) =>
            h(
              "label",
              { class: "choice" },
              h("input", {
                type: "radio",
                name: `asset-${repo.id}`,
                checked: a === preselect,
                onChange() {
                  patternInput.value = patternForAsset(a.name);
                  updateMatches();
                },
              }),
              h("span", {}, a.name, h("span", { class: "sub" }, ` ${bytes(a.size)}`))
            )
          )
        )
      : null;

  card.append(
    ...[
      forkNote,
      picker,
      h("label", { class: "check" }, prerelease, "Include pre-releases"),
      h("details", {}, h("summary", {}, "File pattern"), h("label", {}, "Regex for the release file name", patternInput)),
      matchInfo,
    ].filter(Boolean)
  );
  updateMatches();

  return {
    node: card,
    entry: () => ({
      repo: repo.full_name,
      assetPattern: patternInput.value,
      includePrereleases: prerelease.checked,
      maxVersions: 5,
      overrides: {},
      addedAt: new Date().toISOString(),
    }),
  };
}

function appScreen(repoName) {
  const entry = state.config.apps.find((a) => a.repo.toLowerCase() === repoName.toLowerCase());
  if (!entry) {
    render(header("Not found", { back: "#/" }), h("main", {}, errorBox("That app isn't in your source any more.")));
    return;
  }
  const st = appStatus(entry.repo) || {};
  const app = sourceApp(entry.repo);
  const o = entry.overrides || {};

  const fields = {
    name: h("input", { value: o.name || "", placeholder: st.name || "" }),
    subtitle: h("input", { value: o.subtitle || "", placeholder: app?.subtitle || "" }),
    iconURL: h("input", { value: o.iconURL || "", placeholder: "Use icon from the .ipa", inputmode: "url", autocapitalize: "off" }),
    tintColor: h("input", { value: o.tintColor || "", placeholder: app?.tintColor || "#5B6CFF", autocapitalize: "off" }),
    category: h("select", {}, CATEGORIES.map((c) => h("option", { value: c, selected: (o.category || "other") === c }, c))),
  };
  const pattern = h("input", { value: entry.assetPattern || DEFAULT_PATTERN, autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const prerelease = h("input", { type: "checkbox", checked: !!entry.includePrereleases });
  const maxVersions = h("input", { type: "number", min: 1, max: 20, value: entry.maxVersions || 5, inputmode: "numeric" });

  async function saveSettings(button) {
    try {
      new RegExp(pattern.value);
    } catch {
      toast("The file pattern isn't a valid regex", "error");
      return;
    }
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await save(`Update ${entry.repo}`, (config) => {
        const target = config.apps.find((a) => a.repo === entry.repo);
        if (!target) throw new HttpError(404, "App was removed elsewhere");
        const overrides = {};
        for (const [key, input] of Object.entries(fields)) {
          const v = input.value.trim();
          if (v && !(key === "category" && v === "other")) overrides[key] = v;
        }
        target.overrides = { ...(target.overrides || {}), ...overrides };
        for (const key of Object.keys(fields)) if (!(key in overrides)) delete target.overrides[key];
        target.assetPattern = pattern.value.trim() || DEFAULT_PATTERN;
        target.includePrereleases = prerelease.checked;
        target.maxVersions = Math.min(20, Math.max(1, parseInt(maxVersions.value, 10) || 5));
      });
      toast("Saved, rebuilding…", "ok");
      location.hash = "#/";
    } catch (e) {
      toast(e.message, "error");
      button.disabled = false;
      button.textContent = "Save changes";
    }
  }

  async function refresh(button) {
    button.disabled = true;
    try {
      const startedAt = await state.gh.dispatch({ app: entry.repo, force: "true" });
      toast("Refresh started", "ok");
      state.run = null;
      watchRun(() => state.gh.runDispatchedAfter(startedAt));
      location.hash = "#/";
    } catch (e) {
      toast(e.status === 403 ? "Token needs Actions: read and write to refresh." : e.message, "error");
      button.disabled = false;
    }
  }

  async function remove(button) {
    if (!confirm(`Remove ${st.name || entry.repo} from your source?\n\nIt stays installed on your devices but won't get updates from this source.`)) return;
    button.disabled = true;
    try {
      await save(`Remove ${entry.repo}`, (config) => {
        config.apps = config.apps.filter((a) => a.repo !== entry.repo);
      });
      toast("Removed", "ok");
      location.hash = "#/";
    } catch (e) {
      toast(e.message, "error");
      button.disabled = false;
    }
  }

  const perms = app?.appPermissions || {};
  const privacy = Object.entries(perms.privacy || {});

  render(
    header(st.name || entry.repo.split("/")[1], { back: "#/" }),
    h(
      "main",
      {},
      h(
        "div",
        { class: "card stack" },
        h(
          "div",
          { class: "row" },
          icon(o.iconURL || st.iconURL),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title" }, st.name || entry.repo),
            h("div", { class: "sub" }, st.version ? `Version ${st.version} (${st.buildVersion}) · ${ago(st.updatedAt)}` : "Not built yet"),
            h("a", { class: "sub", href: `https://github.com/${entry.repo}/releases`, target: "_blank", rel: "noopener" }, `github.com/${entry.repo}`)
          )
        ),
        st.bundleIdentifier ? h("div", { class: "sub mono" }, st.bundleIdentifier) : null,
        (st.messages || []).map((m) => h("div", { class: `notice ${st.state === "error" ? "error" : "warn"}` }, m))
      ),

      app?.versions?.length
        ? h(
            "section",
            {},
            h("h2", {}, "Versions"),
            h(
              "div",
              { class: "card" },
              app.versions.map((v, i) =>
                h(
                  "details",
                  { class: "version", open: i === 0 },
                  h("summary", {}, h("span", { class: "title" }, v.version), h("span", { class: "sub" }, ` build ${v.buildVersion} · ${ago(v.date)} · ${bytes(v.size)}`)),
                  h("pre", { class: "notes" }, v.localizedDescription)
                )
              )
            )
          )
        : null,

      perms.entitlements?.length || privacy.length
        ? h(
            "section",
            {},
            h("h2", {}, "Permissions"),
            h(
              "div",
              { class: "card stack" },
              (() => {
                const rows = privacy.map(([k, v]) => h("div", {}, h("div", { class: "title small" }, k.replace(/^NS|UsageDescription$/g, "")), h("div", { class: "sub" }, v)));
                return rows.length > 5 ? h("details", {}, h("summary", {}, `${rows.length} privacy permissions`), h("div", { class: "stack" }, rows)) : rows;
              })(),
              perms.entitlements?.length ? h("details", {}, h("summary", {}, `${perms.entitlements.length} entitlements`), h("pre", { class: "notes mono" }, perms.entitlements.join("\n"))) : null
            )
          )
        : null,

      h(
        "section",
        {},
        h("h2", {}, "Settings"),
        h(
          "div",
          { class: "card stack" },
          h("label", {}, "Name", fields.name),
          h("label", {}, "Subtitle", fields.subtitle),
          h("label", {}, "Icon URL", fields.iconURL),
          h("label", {}, "Tint color", fields.tintColor),
          h("label", {}, "Category", fields.category),
          h("label", {}, "Versions to keep", maxVersions),
          h("label", { class: "check" }, prerelease, "Include pre-releases"),
          h("label", {}, "File pattern (regex)", pattern),
          h("button", { class: "primary", onClick: (e) => saveSettings(e.currentTarget) }, "Save changes")
        )
      ),

      h(
        "div",
        { class: "stack" },
        h("button", { class: "secondary wide", onClick: (e) => refresh(e.currentTarget) }, "Refresh now"),
        h("button", { class: "danger wide", onClick: (e) => remove(e.currentTarget) }, "Remove from source")
      )
    )
  );
}

function settingsScreen() {
  const s = state.config.source || {};
  const url = sourceURL();
  const fields = {
    name: h("input", { value: s.name || "" }),
    subtitle: h("input", { value: s.subtitle || "" }),
    iconURL: h("input", { value: s.iconURL || "", placeholder: "Default icon", inputmode: "url", autocapitalize: "off" }),
    tintColor: h("input", { value: s.tintColor || "", placeholder: "#5B6CFF", autocapitalize: "off" }),
  };

  async function saveSource(button) {
    button.disabled = true;
    try {
      await save("Update source settings", (config) => {
        config.source ||= {};
        for (const [key, input] of Object.entries(fields)) {
          const v = input.value.trim();
          if (v) config.source[key] = v;
          else delete config.source[key];
        }
      });
      toast("Saved, rebuilding…", "ok");
      location.hash = "#/";
    } catch (e) {
      toast(e.message, "error");
      button.disabled = false;
    }
  }

  render(
    header("Settings", { back: "#/" }),
    h(
      "main",
      {},
      h(
        "section",
        {},
        h("h2", {}, "Add to your phone"),
        h(
          "div",
          { class: "card stack" },
          h("div", { class: "mono sub break" }, url),
          h(
            "button",
            {
              class: "secondary",
              async onClick() {
                try {
                  await navigator.clipboard.writeText(url);
                  toast("Source URL copied", "ok");
                } catch {
                  prompt("Copy the source URL:", url);
                }
              },
            },
            "Copy source URL"
          ),
          h("a", { class: "button secondary", href: `altstore://source?url=${encodeURIComponent(url)}` }, "Open in AltStore"),
          h("a", { class: "button secondary", href: `sidestore://source?url=${encodeURIComponent(url)}` }, "Open in SideStore"),
          h("div", { class: "sub" }, "For FlareStore or other stores, copy the URL and add it as a source.")
        )
      ),
      h(
        "section",
        {},
        h("h2", {}, "Source"),
        h(
          "div",
          { class: "card stack" },
          h("label", {}, "Name", fields.name),
          h("label", {}, "Subtitle", fields.subtitle),
          h("label", {}, "Icon URL", fields.iconURL),
          h("label", {}, "Tint color", fields.tintColor),
          state.source?.identifier ? h("div", { class: "sub" }, "Identifier (never changes): ", h("span", { class: "mono" }, state.source.identifier)) : null,
          h("button", { class: "primary", onClick: (e) => saveSource(e.currentTarget) }, "Save")
        )
      ),
      h(
        "section",
        {},
        h("h2", {}, "This device"),
        h(
          "div",
          { class: "card stack" },
          h("div", { class: "sub" }, "Connected to ", h("span", { class: "mono" }, state.gh.fullName)),
          h(
            "button",
            {
              class: "danger",
              onClick() {
                if (!confirm("Sign out and forget the token on this device?")) return;
                store.set("token", null);
                state.gh = null;
                location.hash = "#/";
                setupScreen();
              },
            },
            "Sign out"
          )
        )
      )
    )
  );
}

// --- routing ---------------------------------------------------------------

function route() {
  if (!state.gh || !state.config) return;
  const hash = location.hash || "#/";
  let m;
  if ((m = hash.match(/^#add=(.+)$/)) || (m = hash.match(/^#\/add\?url=(.+)$/))) {
    const url = decodeURIComponent(m[1]);
    history.replaceState(null, "", "#/add");
    addScreen(url);
  } else if (hash === "#/add") addScreen();
  else if ((m = hash.match(/^#\/app\/(.+)$/))) appScreen(decodeURIComponent(m[1]));
  else if (hash === "#/settings") settingsScreen();
  else homeScreen();
}

async function start() {
  const token = store.get("token");
  const repo = store.get("repo");
  if (!token || !repo) return setupScreen();
  state.gh ||= new GitHub(token, repo);
  render(h("main", { class: "loading" }, h("div", { class: "spinner" }), "Loading…"));
  try {
    await state.gh.verify();
    await loadAll();
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      state.gh = null;
      return setupScreen(e.message);
    }
    if (!state.config) {
      render(header("Source"), h("main", {}, errorBox(e.message), h("button", { class: "primary wide", onClick: start }, "Try again")));
      return;
    }
    state.loadError = e.message;
  }
  route();
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.gh && state.config && !state.watching) {
    try {
      await loadAll();
      if (["", "#/"].includes(location.hash)) route();
    } catch {}
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();

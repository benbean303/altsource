const status = await fetch("status.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const url = status.sourceURL || new URL("source.json", location.href).href;
document.getElementById("url").textContent = url;
document.getElementById("altstore").href = `altstore://source?url=${encodeURIComponent(url)}`;
document.getElementById("sidestore").href = `sidestore://source?url=${encodeURIComponent(url)}`;

const res = await fetch("source.json", { cache: "no-cache" }).catch(() => null);
const source = res?.ok ? await res.json() : { apps: [] };
if (source.name) {
  document.getElementById("name").textContent = source.name;
  document.title = source.name;
}

const list = document.getElementById("apps");
for (const app of source.apps) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "row";
  const img = document.createElement("img");
  img.className = "icon";
  img.src = app.iconURL;
  img.alt = "";
  const text = document.createElement("div");
  text.className = "grow";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = app.name;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = `${app.versions?.[0]?.version ?? ""} · ${app.developerName}`;
  text.append(title, sub);
  row.append(img, text);
  li.append(row);
  list.append(li);
}
if (!source.apps.length) list.hidden = true;

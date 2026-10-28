// Cloudflare Worker that serves the AltStore source with "never cache" headers.
//
// GitHub Pages always sends `Cache-Control: max-age=600` and can't be told
// otherwise, and FlareStore keeps old copies of a source far longer than that.
// This Worker fetches the current source.json from GitHub Pages on every
// request (skipping GitHub's CDN cache) and returns it with headers that tell
// apps not to store it at all.
//
// It also logs each request (Cloudflare dashboard → this Worker → Logs), so
// you can see whether FlareStore actually re-downloads the source when you
// refresh it.

const UPSTREAM = "https://benbean303.github.io/altsource/source.json";

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/source.json") {
      return new Response("Not found", { status: 404, headers: NO_STORE });
    }

    console.log(
      JSON.stringify({
        path: url.pathname + url.search,
        userAgent: request.headers.get("user-agent"),
        ifNoneMatch: request.headers.get("if-none-match"),
        ifModifiedSince: request.headers.get("if-modified-since"),
        cacheControl: request.headers.get("cache-control"),
      })
    );

    // A unique query string makes GitHub's CDN return the latest deploy.
    const upstream = await fetch(`${UPSTREAM}?t=${Date.now()}`, {
      headers: { "user-agent": "altsource-worker" },
      cf: { cacheTtl: 0 },
    });
    if (!upstream.ok) {
      return new Response(`Couldn't load source (GitHub Pages returned ${upstream.status})`, {
        status: 502,
        headers: NO_STORE,
      });
    }

    // No ETag / Last-Modified, so there's nothing for an app to revalidate
    // against: it has to download the whole file every time.
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        ...NO_STORE,
      },
    });
  },
};

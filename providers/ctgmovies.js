/**
 * ctgmovies - Nuvio Provider (BDIX)
 * ctgmovies.com page scraper. Authenticated with a ctg_token cookie.
 */
var PROVIDER_NAME = "CTGMovies";
var BASE = "https://ctgmovies.com";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var EDITION_RE = /^(extended|remastered|unrated|special|directors)$/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var QRANK = { "4K": 5, "1080p": 4, "720p": 3, "480p": 1, "360p": 0 };

function run(genFn) {
  return new Promise(function (resolve, reject) {
    var it = genFn();
    function step(method, arg) {
      var r;
      try {
        r = it[method](arg);
      } catch (e) {
        return reject(e);
      }
      if (r.done) return resolve(r.value);
      Promise.resolve(r.value).then(
        function (v) { step("next", v); },
        function (e) { step("throw", e); }
      );
    }
    step("next");
  });
}

function safeFetch(url, options, timeoutMs) {
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 10000) : null;
  var opts = Object.assign({}, options || {}, {
    headers: Object.assign({ "User-Agent": UA }, (options && options.headers) || {}),
    skipSizeCheck: true
  });
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(
    function (r) { if (timer) clearTimeout(timer); return r; },
    function (e) { if (timer) clearTimeout(timer); throw e; }
  );
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(s) {
  return norm(s).replace(/\s/g, "");
}

function titlesMatch(candidate, query) {
  var c = norm(candidate);
  var q = norm(query);
  if (!c || !q) return false;
  if (c === q) return true;
  // spider-man vs spiderman, etc.
  if (compact(candidate) === compact(query)) return true;
  var cw = c.split(" ");
  var qw = q.split(" ");
  if (qw.length === 1) return cw.length === 2 && cw[0] === q && EDITION_RE.test(cw[1]);
  if (c.indexOf(q + " ") === 0 || q.indexOf(c + " ") === 0) return Math.abs(cw.length - qw.length) <= 3;
  return qw.every(function (w) { return cw.indexOf(w) !== -1; }) && Math.abs(cw.length - qw.length) <= 3;
}

function yearOk(a, b) {
  if (!a || !b) return true;
  return Math.abs(a - b) <= 1;
}

function qualityOf(s) {
  var l = String(s || "").toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(l)) return "4K";
  if (/1080p|fhd/.test(l)) return "1080p";
  if (/720p/.test(l)) return "720p";
  if (/480p/.test(l)) return "480p";
  if (/360p/.test(l)) return "360p";
  return "HD";
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function resolveMeta(id, mediaType, tmdbKey) {
  return run(function* () {
    if (id && typeof id === "object") {
      return { title: id.title || id.name || "", year: parseInt(id.year || "", 10) || null };
    }
    var s = String(id || "").trim();
    if (!s) return null;
    var isImdb = /^tt\d+/.test(s);
    if (!isImdb && !/^\d+$/.test(s)) return { title: s, year: null };
    var isTv = mediaType === "tv";
    var keys = (tmdbKey ? [tmdbKey] : []).concat(DEFAULT_TMDB_KEYS);
    for (var i = 0; i < keys.length; i++) {
      try {
        var url = isImdb
          ? "https://api.themoviedb.org/3/find/" + s.split(":")[0] + "?external_source=imdb_id&api_key=" + encodeURIComponent(keys[i])
          : "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + s + "?api_key=" + encodeURIComponent(keys[i]);
        var r = yield safeFetch(url, { headers: { Accept: "application/json" } }, 6000);
        if (!r.ok) continue;
        var d = yield r.json();
        if (isImdb) {
          d = ((isTv ? d.tv_results : d.movie_results) || [])[0];
          if (!d) continue;
        }
        var date = d.release_date || d.first_air_date || "";
        return {
          title: d.title || d.name || d.original_title || d.original_name,
          year: parseInt(date.slice(0, 4), 10) || null
        };
      } catch (e) {
        console.log("[CTGMovies] TMDB key " + i + " failed:", e.message);
      }
    }
    if (isImdb) {
      try {
        var cr = yield safeFetch(
          "https://v3-cinemeta.strem.io/meta/" + (isTv ? "series" : "movie") + "/" + s.split(":")[0] + ".json",
          { headers: { Accept: "application/json" } },
          7000
        );
        var cd = yield cr.json();
        if (cd && cd.meta && cd.meta.name) return { title: cd.meta.name, year: parseInt(cd.meta.year, 10) || null };
      } catch (e) {
        console.log("[CTGMovies] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

var cookieCache = { v: "", at: 0 };

function remoteCookie(url, key) {
  if (!url) return Promise.resolve("");
  if (cookieCache.v && Date.now() - cookieCache.at < 300000) return Promise.resolve(cookieCache.v);
  var sep = url.indexOf("?") === -1 ? "?" : "&";
  return safeFetch(url + (key ? sep + "key=" + encodeURIComponent(key) : ""), { headers: { "x-key": key || "" } }, 6000)
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (v) {
      v = String(v || "").trim();
      if (v) cookieCache = { v: v, at: Date.now() };
      return v;
    })
    .catch(function (e) {
      console.log("[CTGMovies] cookie worker failed:", e.message);
      return "";
    });
}

function buildCookie(raw) {
  var c = String(raw || "").trim();
  if (c && c.indexOf("=") === -1) c = "ctg_token=" + c;
  if (c && c.indexOf("ctg_geo_block") === -1) c += "; ctg_geo_block=allow";
  return c;
}

function pageHeaders(cookie) {
  return { Accept: "text/html,*/*", Referer: BASE + "/", Cookie: cookie };
}

function fetchText(url, cookie) {
  return safeFetch(url, { headers: pageHeaders(cookie) }, 12000).then(function (r) {
    if (!r.ok) throw new Error(r.status + " " + url);
    return r.text();
  });
}

// spider-man -> spiderman (site drops in-word hyphens), other punctuation -> dash
function slugOf(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/(\w)-(\w)/g, "$1$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseCards(html, kind) {
  var out = [];
  var seen = {};
  var re = new RegExp("<a\\b[^>]*href=\"(\\/" + kind + "\\/[^\"#?]+)\"[^>]*>([\\s\\S]*?)<\\/a>", "gi");
  var m;
  while ((m = re.exec(html))) {
    var href = m[1];
    if (seen[href]) continue;
    var inner = m[2];
    var alt = inner.match(/<img[^>]*\balt="([^"]+)"/i);
    var title = alt ? decodeHtml(alt[1]).trim() : "";
    if (!title) {
      var h3 = inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      title = h3 ? decodeHtml(h3[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
    }
    if (!title) continue;
    var ym = inner.replace(/<[^>]+>/g, " ").match(/\b((?:19|20)\d{2})\b/);
    seen[href] = true;
    out.push({ href: href, title: title.replace(/\s*\((?:19|20)\d{2}\)\s*$/, ""), year: ym ? Number(ym[1]) : null });
  }
  return out;
}

function isJunk(u) {
  var l = u.toLowerCase();
  return /\.(srt|vtt)(\?|$)/.test(l) || l.indexOf(".audio.") !== -1;
}

function rscText(html) {
  var out = "";
  var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  var m;
  while ((m = re.exec(html))) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch (e) {
      out += m[1];
    }
  }
  return out;
}

function extractLinks(html) {
  var sources = [rscText(html), html.replace(/\\u0026/g, "&").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/&amp;/g, "&")];
  var re = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|mkv|m3u8)(?:\?[^\s"'<>\\]*)?/gi;
  var seen = {};
  var out = [];
  sources.forEach(function (src) {
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      var u = m[0];
      if (isJunk(u) || /image\.tmdb|\/imgcache\//i.test(u)) continue;
      if (/\s/.test(u)) u = encodeURI(u);
      var key = safeDecode(u).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(u);
    }
  });
  return out;
}

function fileName(u) {
  var p = u.split("?")[0].split("/");
  return safeDecode(p[p.length - 1] || "");
}

function epMatch(name, s, e) {
  var re = /s(\d{1,2})[\s._-]*e(\d{1,3})/i;
  var m = re.exec(name);
  if (!m) return false;
  return parseInt(m[1], 10) === s && parseInt(m[2], 10) === e;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var isTv = mediaType === "tv";
      var kind = isTv ? "tv" : "movies";
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      BASE = String(settings.ctgUrl || "https://ctgmovies.com").trim().replace(/\/+$/, "");
      var remote = yield remoteCookie(String(settings.ctgCookieUrl || "https://ctgmovies.puls3.workers.dev/cookie").trim(), String(settings.ctgCookieKey || "").trim());
      var cookie = buildCookie(remote || settings.ctgCookie);
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[CTGMovies] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      console.log("[CTGMovies] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var hrefs = [];
      // try the raw title, then a hyphen-less / colon-less variant (site titles are messy)
      var queries = [meta.title];
      var alt = meta.title.replace(/[-:]/g, " ").replace(/\s+/g, " ").trim();
      if (alt && alt !== meta.title) queries.push(alt);
      var altJoined = meta.title.replace(/(\w)-(\w)/g, "$1$2");
      if (altJoined !== meta.title && queries.indexOf(altJoined) === -1) queries.push(altJoined);

      for (var qi = 0; qi < queries.length; qi++) {
        try {
          var html = yield fetchText(BASE + "/search?q=" + encodeURIComponent(queries[qi]), cookie);
          parseCards(html, kind)
            .filter(function (c) { return titlesMatch(c.title, meta.title) && yearOk(c.year, meta.year); })
            .forEach(function (c) { if (hrefs.indexOf(c.href) === -1) hrefs.push(c.href); });
        } catch (e) {
          console.log("[CTGMovies] search failed:", e.message);
        }
        if (hrefs.length) break;
      }

      var slug = slugOf(meta.title);
      if (slug) {
        [slug, slug + "-1", meta.year ? slug + "-" + meta.year : ""].forEach(function (s) {
          var h = "/" + kind + "/" + s;
          if (s && hrefs.indexOf(h) === -1) hrefs.push(h);
        });
      }
      hrefs = hrefs.slice(0, 5);
      console.log("[CTGMovies] candidates: " + hrefs.join(", "));

      var pages = yield Promise.all(
        hrefs.map(function (h) {
          return fetchText(BASE + h, cookie).catch(function () { return ""; });
        })
      );

      var s = season ? parseInt(season, 10) : 1;
      var ep = episode ? parseInt(episode, 10) : 1;
      var seen = {};
      var streams = [];
      pages.forEach(function (ph) {
        if (!ph) return;
        extractLinks(ph).forEach(function (u) {
          if (seen[u]) return;
          var name = fileName(u);
          if (isTv && !epMatch(name, s, ep)) return;
          seen[u] = true;
          var q = qualityOf(name);
          var ext = (name.match(/\.([a-z0-9]+)$/i) || [0, ""])[1].toUpperCase();
          streams.push({
            name: PROVIDER_NAME,
            title: "[CTGMovies] " + q + (ext ? " [" + ext + "]" : "") + " " + name,
            url: u,
            quality: q,
            headers: { "User-Agent": UA, Referer: BASE + "/" }
          });
        });
      });
      streams.sort(function (a, b) { return (QRANK[b.quality] || 0) - (QRANK[a.quality] || 0); });
      if (!cookie) console.log("[CTGMovies] no cookie: set Cookie Worker URL/Key in settings");
      if (!streams.length) console.log("[CTGMovies] no links found (cookie expired, geo block, or title missing?)");
      console.log("[CTGMovies] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[CTGMovies] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "CTGMovies Configuration" },
    {
      type: "text",
      key: "ctgUrl",
      label: "Site URL",
      placeholder: "https://ctgmovies.com",
      defaultValue: "https://ctgmovies.com",
      description: "Default: https://ctgmovies.com"
    },
    {
      type: "text",
      key: "ctgCookie",
      label: "ctg_token cookie (optional)",
      placeholder: "ctg_token=eyJ...",
      description: "Fallback if the worker is unavailable. Accepts the full cookie or just the token value."
    },
    {
      type: "text",
      key: "ctgCookieUrl",
      label: "Cookie Worker URL (optional)",
      placeholder: "https://ctgmovies.puls3.workers.dev/cookie",
      defaultValue: "https://ctgmovies.puls3.workers.dev/cookie",
      description: "Fetched on each run (cached 5 min). Takes priority over the manual cookie below."
    },
    {
      type: "text",
      key: "ctgCookieKey",
      label: "Cookie Worker Key",
      placeholder: "AUTH_KEY",
      description: "Sent as the x-key header and ?key= param."
    },
    { type: "header", label: "TMDB" },
    {
      type: "text",
      key: "tmdbApiKey",
      label: "TMDB API Key (optional)",
      placeholder: "Your TMDB v3 API key",
      description: "Built-in keys are used when blank."
    }
  ]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };

if (typeof globalThis !== "undefined" && typeof module !== "undefined" && module.exports) {
  globalThis.getStreams = module.exports.getStreams;
  globalThis.onSettings = module.exports.onSettings;
}

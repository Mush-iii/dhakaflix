/**
 * flixhub - Nuvio Provider
 * FlixHub scraper ported from CloudStream. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "FlixHub";
var DEFAULT_BASE_URL = "https://flixhub.net";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var EDITION_RE = /^(extended|remastered|unrated|special|directors)$/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

function titlesMatch(candidate, query) {
  var c = norm(candidate);
  var q = norm(query);
  if (!c || !q) return false;
  if (c === q) return true;
  var cw = c.split(" ");
  var qw = q.split(" ");
  if (qw.length === 1) return cw.length === 2 && cw[0] === q && EDITION_RE.test(cw[1]);
  if (c.indexOf(q + " ") === 0 || q.indexOf(c + " ") === 0) return Math.abs(cw.length - qw.length) <= 3;
  return qw.every(function (w) { return cw.indexOf(w) !== -1; }) && Math.abs(cw.length - qw.length) <= 3;
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

function absUrl(base, u) {
  u = String(u || "").trim().replace(/&amp;/g, "&");
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === "/" ? "" : "/") + u;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(h) {
  return decodeEntities(String(h || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrOf(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2]) : "";
}

function cookieOf(res) {
  try {
    var c = res && res.headers && res.headers.get && res.headers.get("set-cookie");
    if (!c) return "";
    return c.split(/,(?=\s*[^;,\s]+=)/).map(function (x) { return x.split(";")[0].trim(); }).filter(Boolean).join("; ");
  } catch (e) {
    return "";
  }
}

function getPage(url, headers) {
  return safeFetch(url, { headers: headers || {} }, 10000)
    .then(function (r) {
      if (!r.ok) return null;
      return r.text().then(function (t) { return { text: t, res: r }; });
    })
    .catch(function (e) {
      console.log("[FlixHub] request failed " + url + ":", e.message);
      return null;
    });
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
        console.log("[FlixHub] TMDB key " + i + " failed:", e.message);
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
        console.log("[FlixHub] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function jsonGet(url, base) {
  return safeFetch(url, {
    headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: base + "/" }
  }, 8000)
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function (e) {
      console.log("[FlixHub] request failed " + url + ":", e.message);
      return null;
    });
}

function parseEpisodes(html, base) {
  var eps = [];
  var chunks = html.split(/<article\b/i).slice(1);
  var counters = {};
  chunks.forEach(function (ch) {
    var open = ch.slice(0, ch.indexOf(">") + 1);
    var sn = attrOf(open, "data-season-number");
    if (!sn) return;
    var season = parseInt(sn, 10) || 1;
    var link = "";
    var am = /<a\b[^>]*>/gi;
    var t;
    while ((t = am.exec(ch))) {
      if (/player-sidebar-card-link/.test(attrOf(t[0], "class"))) {
        link = attrOf(t[0], "href");
        break;
      }
    }
    if (!link) return;
    counters[season] = (counters[season] || 0) + 1;
    var tm = /class=["'][^"']*player-sidebar-card-title[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(ch);
    var titleText = tm ? stripTags(tm[1]) : "";
    var nm = /(?:Episode|E)\s*(\d+)/.exec(stripTags(ch));
    var num = nm ? parseInt(nm[1], 10) : counters[season];
    eps.push({ season: season, episode: num, title: titleText, url: absUrl(base, link) });
  });
  return eps;
}

function extractSubs(html, base) {
  var subs = [];
  var re = /<track\b[^>]*>/gi;
  var m;
  while ((m = re.exec(html))) {
    var src = attrOf(m[0], "src");
    if (!src) continue;
    subs.push({
      url: absUrl(base, src),
      language: attrOf(m[0], "srclang") || "en",
      name: attrOf(m[0], "label") || "English"
    });
  }
  return subs;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.flixhubBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[FlixHub] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      console.log("[FlixHub] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var sd = yield jsonGet(base + "/search/suggestions?q=" + encodeURIComponent(meta.title), base);
      var results = sd && Array.isArray(sd.results) ? sd.results : [];
      var matches = results.filter(function (r) {
        if (r.is_available !== true || !r.watch_url) return false;
        var rTv = String(r.type || "").toLowerCase() === "tv series" || r.watch_url.indexOf("/watch/series/") !== -1;
        if (rTv !== isTv) return false;
        if (!titlesMatch(r.title, meta.title)) return false;
        var y = parseInt(r.year, 10);
        if (meta.year && y && Math.abs(y - meta.year) > 1) return false;
        return true;
      });
      if (meta.year) {
        matches.sort(function (a, b) {
          return Math.abs((parseInt(a.year, 10) || meta.year) - meta.year) - Math.abs((parseInt(b.year, 10) || meta.year) - meta.year);
        });
      }
      matches = matches.slice(0, 2);
      console.log("[FlixHub] " + matches.length + " match(es)");
      if (!matches.length) return [];

      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;

      var watchUrls = yield Promise.all(matches.map(function (m) {
        var wu = absUrl(base, m.watch_url);
        if (!isTv) return wu;
        return getPage(wu, { Referer: base + "/" }).then(function (page) {
          if (!page) return null;
          var hit = parseEpisodes(page.text, base).filter(function (x) { return x.season === s && x.episode === e; })[0];
          return hit ? hit.url : null;
        });
      }));

      var seen = {};
      var streams = [];
      for (var i = 0; i < watchUrls.length; i++) {
        var wu = watchUrls[i];
        if (!wu) continue;
        var kind = wu.indexOf("/watch/episode/") !== -1 ? "episode" : "movie";
        var marker = "/watch/" + kind + "/";
        if (wu.indexOf(marker) === -1) continue;
        var slug = wu.split(marker)[1].split("?")[0].trim();
        var streamUrl = base + "/stream/" + kind + "/" + slug;
        if (seen[streamUrl]) continue;
        seen[streamUrl] = true;

        var headers = { "User-Agent": UA, Referer: wu };
        var subs = [];
        var page = yield getPage(wu, { Referer: base + "/" });
        if (page) {
          var ck = cookieOf(page.res);
          if (ck) headers.Cookie = ck;
          subs = extractSubs(page.text, base);
        }
        var q = qualityOf(matches[i].title + " " + slug);
        var st = {
          name: PROVIDER_NAME,
          title: "[FlixHub] " + (isTv ? "S" + s + "E" + e + " - " : "") + q,
          url: streamUrl,
          quality: q,
          headers: headers
        };
        if (subs.length) st.subtitles = subs;
        streams.push(st);
      }
      console.log("[FlixHub] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[FlixHub] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "FlixHub Configuration" },
    {
      type: "text",
      key: "flixhubBaseUrl",
      label: "FlixHub Base URL",
      placeholder: DEFAULT_BASE_URL,
      defaultValue: DEFAULT_BASE_URL,
      description: "Default: https://flixhub.net"
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

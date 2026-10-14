/**
 * anikoto - Nuvio Provider
 * Anikoto anime scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "Anikoto";
var DEFAULT_BASE_URL = "https://anikototv.to";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function run(genFn) {
  return new Promise(function (resolve, reject) {
    var it = genFn();
    function step(method, arg) {
      var r;
      try { r = it[method](arg); } catch (e) { return reject(e); }
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

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function norm(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

var SEASON_RE = /\b(?:season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|part\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*cour)\b/;

function seasonOf(title) {
  var m = SEASON_RE.exec(norm(title));
  if (!m) return 1;
  return parseInt(m[1] || m[2] || m[3] || m[4], 10) || 1;
}

function stripSeason(title) {
  return norm(title).replace(SEASON_RE, " ").replace(/\s+/g, " ").trim();
}

function ordinal(n) {
  var s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getPage(url, headers) {
  return safeFetch(url, { headers: headers || {} }, 12000)
    .then(function (r) {
      if (!r.ok) return null;
      return r.text().then(function (t) { return { text: t, res: r }; });
    })
    .catch(function (e) {
      console.log("[Anikoto] request failed " + url + ":", e.message);
      return null;
    });
}

function jsonGet(url, base) {
  return safeFetch(url, {
    headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/plain, */*", Referer: base + "/" }
  }, 10000)
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (e) { return t; }
    })
    .catch(function (e) {
      console.log("[Anikoto] request failed " + url + ":", e.message);
      return null;
    });
}

function resolveMeta(id, mediaType, tmdbKey) {
  return run(function* () {
    if (id && typeof id === "object") {
      return { titles: [id.title || id.name || ""].filter(Boolean), year: parseInt(id.year || "", 10) || null };
    }
    var s = String(id || "").trim();
    if (!s) return null;
    var isImdb = /^tt\d+/.test(s);
    if (!isImdb && !/^\d+$/.test(s)) return { titles: [s], year: null };
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
        var titles = [d.name || d.title, d.original_name || d.original_title].filter(function (x, n, a) {
          return x && a.indexOf(x) === n;
        });
        return { titles: titles, year: parseInt(date.slice(0, 4), 10) || null };
      } catch (e) {
        console.log("[Anikoto] TMDB key " + i + " failed:", e.message);
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
        if (cd && cd.meta && cd.meta.name) return { titles: [cd.meta.name], year: parseInt(cd.meta.year, 10) || null };
      } catch (e) {
        console.log("[Anikoto] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function parseSearch(html) {
  var out = [];
  var chunks = html.split(/<div class="item\b/i).slice(1);
  chunks.forEach(function (ch) {
    var m = /<a class="name d-title" href="([^"]+)"([^>]*)>([^<]*)<\/a>/i.exec(ch);
    if (!m) return;
    var jp = /data-jp="([^"]*)"/i.exec(m[2]);
    var type = /<div class="right">\s*([^<]+?)\s*<\/div>/i.exec(ch);
    var eps = /ep-status total"><span>\s*(\d+)/i.exec(ch);
    out.push({
      url: m[1].replace(/\/ep-\d+\/?$/, "").replace(/\/+$/, ""),
      name: decodeEntities(m[3]).trim(),
      jp: jp ? decodeEntities(jp[1]).trim() : "",
      type: type ? type[1].toUpperCase() : "",
      eps: eps ? parseInt(eps[1], 10) : 0
    });
  });
  return out;
}

function pickEntry(results, titles, season, isTv) {
  var qs = titles.map(stripSeason);
  var scored = [];
  results.forEach(function (r) {
    var isMovie = r.type === "MOVIE";
    if (isTv === isMovie && !(isTv && r.type !== "MOVIE")) return;
    var names = [r.name, r.jp].filter(Boolean);
    var best = 0;
    names.forEach(function (n) {
      var base = stripSeason(n);
      qs.forEach(function (q) {
        if (!q || !base) return;
        if (base === q) best = Math.max(best, 3);
        else if (base.indexOf(q + " ") === 0 || q.indexOf(base + " ") === 0) best = Math.max(best, 1);
      });
    });
    if (!best) return;
    var rs = Math.max(seasonOf(r.name), seasonOf(r.jp));
    var score = best * 10;
    if (isTv) {
      if (rs === season) score += 8;
      else if (season === 1 && rs !== 1) score -= 20;
      else if (season > 1 && rs !== season) score -= 5;
    }
    scored.push({ r: r, score: score, rs: rs });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored[0] || null;
}

function parseServers(html) {
  var servers = [];
  var parts = html.split(/<div class="type" data-type="/i).slice(1);
  parts.forEach(function (p) {
    var type = p.slice(0, p.indexOf('"')).toLowerCase();
    var block = p.slice(0, p.indexOf("</ul>") + 5);
    var re = /<li\b[^>]*data-link-id="([^"]+)"[^>]*>([^<]*)<\/li>/gi;
    var m;
    while ((m = re.exec(block))) {
      servers.push({ type: type, linkId: m[1], name: decodeEntities(m[2]).trim() });
    }
  });
  return servers;
}

function resolveLink(base, linkId, referer) {
  return run(function* () {
    var urls = [
      base + "/ajax/server?get=" + encodeURIComponent(linkId),
      base + "/ajax/server/" + encodeURIComponent(linkId)
    ];
    for (var i = 0; i < urls.length; i++) {
      var d = yield jsonGet(urls[i], base);
      if (!d) continue;
      var u = null;
      if (typeof d === "string") u = /^https?:/i.test(d.trim()) ? d.trim() : null;
      else if (d.result && typeof d.result === "object") u = d.result.url || d.result.link || null;
      else if (typeof d.result === "string") u = d.result;
      else u = d.url || d.link || null;
      if (u && /^https?:/i.test(u)) return u.replace(/\\\//g, "/");
    }
    return null;
  });
}

function unslash(s) {
  return String(s || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
}

function extractFromEmbed(embedUrl, base) {
  return run(function* () {
    var origin = (/^(https?:\/\/[^\/]+)/i.exec(embedUrl) || [])[1] || base;
    var headers = { Referer: base + "/", Origin: base };
    var found = { url: null, subs: [], referer: origin + "/" };
    if (/\.m3u8(\?|$)/i.test(embedUrl)) { found.url = embedUrl; return found; }
    var page = yield getPage(embedUrl, headers);
    if (!page) return found;
    var html = page.text;
    var m = /https?:[^"'\s\\]*(?:\\\/[^"'\s\\]*)*\.m3u8[^"'\s\\]*/i.exec(html);
    if (m) found.url = unslash(m[0]);
    var tr = /<track\b[^>]*>/gi, t;
    while ((t = tr.exec(html))) {
      var src = /src="([^"]+)"/i.exec(t[0]);
      if (!src) continue;
      var lb = /label="([^"]*)"/i.exec(t[0]);
      var sl = /srclang="([^"]*)"/i.exec(t[0]);
      found.subs.push({ url: src[1], language: sl ? sl[1] : "en", name: lb ? lb[1] : "English" });
    }
    if (!found.url) {
      var idm = /data-id=["'](\d+)["']/i.exec(html) || /[?&]id=(\d+)/.exec(embedUrl);
      if (idm) {
        var apis = [origin + "/stream/getSources?id=" + idm[1], origin + "/embed-1/v2/e-1/getSources?id=" + idm[1]];
        for (var i = 0; i < apis.length && !found.url; i++) {
          var d = yield jsonGet(apis[i], origin);
          if (!d || typeof d !== "object") continue;
          var f = d.sources && (d.sources.file || (d.sources[0] && d.sources[0].file));
          if (f) found.url = f;
          (d.tracks || []).forEach(function (tk) {
            if (tk.file && (!tk.kind || tk.kind === "captions" || tk.kind === "subtitles")) {
              found.subs.push({ url: tk.file, language: "en", name: tk.label || "English" });
            }
          });
        }
      }
    }
    return found;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.anikotoBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      var wantDub = settings.anikotoDub !== false && settings.anikotoDub !== "false";
      var wantSub = settings.anikotoSub !== false && settings.anikotoSub !== "false";
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.titles.length) {
        console.log("[Anikoto] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      console.log("[Anikoto] searching " + JSON.stringify(meta.titles) + " S" + s + "E" + e);

      var queries = [];
      meta.titles.forEach(function (t) {
        if (isTv && s > 1) {
          queries.push(t + " season " + s);
          queries.push(t + " " + ordinal(s) + " season");
        }
        queries.push(t);
      });

      var entry = null;
      for (var qi = 0; qi < queries.length && !entry; qi++) {
        var sp = yield getPage(base + "/filter?keyword=" + encodeURIComponent(queries[qi]), { Referer: base + "/" });
        if (!sp) continue;
        entry = pickEntry(parseSearch(sp.text), meta.titles, s, isTv);
      }
      if (!entry) {
        console.log("[Anikoto] no match");
        return [];
      }
      console.log("[Anikoto] matched " + entry.r.name + " -> " + entry.r.url);

      var epNum = isTv ? e : 1;
      var watchUrl = entry.r.url + "/ep-" + epNum;
      var wp = yield getPage(watchUrl, { Referer: base + "/" });
      if (!wp) return [];
      var servers = parseServers(wp.text).filter(function (x) {
        return (x.type === "dub" && wantDub) || (x.type === "sub" && wantSub) || (x.type !== "dub" && x.type !== "sub");
      });
      console.log("[Anikoto] " + servers.length + " server(s)");
      if (!servers.length) return [];

      var embeds = yield Promise.all(servers.map(function (sv) {
        return resolveLink(base, sv.linkId, watchUrl).then(function (u) {
          if (!u) return null;
          return extractFromEmbed(u, base).then(function (x) { return x && x.url ? x : null; });
        }).catch(function () { return null; });
      }));

      var seen = {};
      var streams = [];
      embeds.forEach(function (x, i) {
        if (!x || seen[x.url]) return;
        seen[x.url] = true;
        var sv = servers[i];
        var st = {
          name: PROVIDER_NAME,
          title: "[Anikoto] " + sv.type.toUpperCase() + " " + sv.name + (isTv ? " - S" + s + "E" + e : ""),
          url: x.url,
          quality: "Auto",
          headers: { "User-Agent": UA, Referer: x.referer }
        };
        if (x.subs.length) st.subtitles = x.subs;
        streams.push(st);
      });
      streams.sort(function (a, b) { return (a.title.indexOf(" SUB ") !== -1 ? 1 : 0) - (b.title.indexOf(" SUB ") !== -1 ? 1 : 0); });
      console.log("[Anikoto] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[Anikoto] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "Anikoto Configuration" },
    {
      type: "text",
      key: "anikotoBaseUrl",
      label: "Anikoto Base URL",
      placeholder: DEFAULT_BASE_URL,
      defaultValue: DEFAULT_BASE_URL,
      description: "Default: https://anikototv.to"
    },
    { type: "toggle", key: "anikotoSub", label: "Include SUB", defaultValue: true },
    { type: "toggle", key: "anikotoDub", label: "Include DUB", defaultValue: true },
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

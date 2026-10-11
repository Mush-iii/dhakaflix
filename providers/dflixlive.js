/**
 * dflixlive - Nuvio Provider (BDIX)
 * DFLIX.live JSON API scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "DFLIX.live";
var DEFAULT_BASE_URL = "https://dflix.live";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var EDITION_RE = /^(extended|remastered|unrated|special|directors)$/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 8000) : null;
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

var QRANK = { "4K": 5, "1080p": 4, "720p": 3, "HD": 2, "480p": 1, "360p": 0 };

function absUrl(base, u) {
  return /^https?:\/\//i.test(u) ? u : base + (u.charAt(0) === "/" ? "" : "/") + u;
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
        console.log("[DFLIX.live] TMDB key " + i + " failed:", e.message);
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
        console.log("[DFLIX.live] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function apiGet(base, path, timeoutMs) {
  return safeFetch(base + path, { headers: { Accept: "application/json" } }, timeoutMs || 8000)
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function (e) {
      console.log("[DFLIX.live] request failed " + path + ":", e.message);
      return null;
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.dflixBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[DFLIX.live] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      console.log("[DFLIX.live] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var sd = yield apiGet(base, "/api/search?q=" + encodeURIComponent(meta.title));
      var results = sd && Array.isArray(sd.results) ? sd.results : [];
      var kind = isTv ? "tv" : "movie";
      var matches = results.filter(function (r) {
        if (r.kind && r.kind !== kind) return false;
        if (!titlesMatch(r.title, meta.title)) return false;
        if (meta.year && r.year && Math.abs(r.year - meta.year) > 1) return false;
        return true;
      });
      if (meta.year) {
        matches.sort(function (a, b) {
          return Math.abs((a.year || meta.year) - meta.year) - Math.abs((b.year || meta.year) - meta.year);
        });
      }
      matches = matches.slice(0, 2);
      console.log("[DFLIX.live] " + matches.length + " match(es)");
      if (!matches.length) return [];

      var details = yield Promise.all(
        matches.map(function (m) { return apiGet(base, "/api/title/" + m.id); })
      );

      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      var seen = {};
      var streams = [];
      details.forEach(function (d) {
        if (!d || !Array.isArray(d.files)) return;
        var files;
        if (isTv) {
          files = d.files.filter(function (f) { return Number(f.season) === s && Number(f.episode) === e; });
        } else {
          files = d.files.filter(function (f) { return !f.season && !f.episode; });
          if (!files.length) files = d.files;
        }
        files.forEach(function (f) {
          if (!f.streamUrl) return;
          var url = absUrl(base, f.streamUrl);
          if (seen[url]) return;
          seen[url] = true;
          var q = qualityOf(f.quality || url);
          var ext = String(f.container || "mp4").toUpperCase();
          var subs = [];
          (Array.isArray(f.subtitles) ? f.subtitles : []).forEach(function (sub) {
            if (!sub || !sub.url) return;
            subs.push({
              url: absUrl(base, sub.url),
              language: sub.lang || "en",
              name: sub.label || (sub.lang ? sub.lang.toUpperCase() : "English")
            });
          });
          var st = {
            name: PROVIDER_NAME,
            title: "[DFLIX.live] " + (isTv ? "S" + s + "E" + e + " - " : "") + q + " [" + ext + "]",
            url: url,
            quality: q,
            headers: { "User-Agent": UA }
          };
          if (subs.length) st.subtitles = subs;
          streams.push(st);
        });
      });
      streams.sort(function (a, b) { return (QRANK[b.quality] || 0) - (QRANK[a.quality] || 0); });
      console.log("[DFLIX.live] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[DFLIX.live] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "DFLIX.live Configuration" },
    {
      type: "text",
      key: "dflixBaseUrl",
      label: "DFLIX.live Base URL",
      placeholder: DEFAULT_BASE_URL,
      defaultValue: DEFAULT_BASE_URL,
      description: "Default: https://dflix.live"
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

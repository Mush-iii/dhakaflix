/**
 * circleftp - Nuvio Provider (BDIX)
 * Circle FTP REST API scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "CircleFTP";
var DEFAULT_API_URL = "http://new.circleftp.net:5000/api";
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
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 7000) : null;
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
        console.log("[CircleFTP] TMDB key " + i + " failed:", e.message);
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
        console.log("[CircleFTP] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function qualityOf(s) {
  var l = String(s || "").toLowerCase();
  if (/2160p|4k|uhd/.test(l)) return "4K";
  if (/1080p|fhd/.test(l)) return "1080p";
  if (/720p|hd/.test(l)) return "720p";
  if (/480p/.test(l)) return "480p";
  if (/360p/.test(l)) return "360p";
  return "1080p";
}

function yearOf(s) {
  var m = String(s || "").match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function episodeNumber(title) {
  if (!title) return null;
  var m = title.match(/S:?\d+[\.:\s]*E(?:pisode)?:?(\d+)/i) || title.match(/Episode[:\s]*(\d+)/i) || title.match(/\bEp[:\s]*(\d+)\b/i) || title.match(/\bE(\d+)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function seasonNumber(name) {
  var m = String(name || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function apiGet(api, path) {
  return safeFetch(api + path, { headers: { Accept: "application/json" } }, 6000)
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function (e) {
      console.log("[CircleFTP] request failed " + path + ":", e.message);
      return null;
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var api = String(settings.circleApiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[CircleFTP] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      console.log("[CircleFTP] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var sd = yield apiGet(api, "/posts?searchTerm=" + encodeURIComponent(meta.title) + "&order=desc");
      var posts = sd && Array.isArray(sd.posts) ? sd.posts : [];
      var matches = posts.filter(function (p) {
        if (p.type !== (isTv ? "series" : "singleVideo")) return false;
        var name = p.name || p.title || "";
        if (!titlesMatch(name, meta.title)) return false;
        if (!isTv && meta.year) {
          var y = yearOf(p.year || name);
          if (y && Math.abs(y - meta.year) > 1) return false;
        }
        return true;
      });
      console.log("[CircleFTP] " + matches.length + " match(es)");
      if (!matches.length) return [];

      var details = yield Promise.all(matches.map(function (m) { return apiGet(api, "/posts/" + m.id); }));

      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      var seen = {};
      var streams = [];
      details.forEach(function (d, i) {
        if (!d) return;
        var url;
        var q;
        var title;
        if (isTv) {
          if (!Array.isArray(d.content)) return;
          var sd2 = d.content.filter(function (x) { return seasonNumber(x.seasonName) === s; })[0];
          if (!sd2 || !Array.isArray(sd2.episodes)) return;
          var ep = sd2.episodes.filter(function (x) { return episodeNumber(x.title) === e; })[0];
          if (!ep || typeof ep.link !== "string") return;
          url = ep.link.trim();
          q = qualityOf(matches[i].quality || ep.title || url);
          title = "[CircleFTP] S" + s + "E" + e + " - " + q;
        } else {
          if (typeof d.content !== "string") return;
          url = d.content.trim();
          q = qualityOf(matches[i].quality || d.title || url);
          title = "[CircleFTP] " + q + (matches[i].quality && matches[i].quality !== q ? " - " + matches[i].quality : "");
        }
        if (!/^https?:\/\//i.test(url) || seen[url]) return;
        seen[url] = true;
        streams.push({ name: PROVIDER_NAME, title: title, url: url, quality: q, headers: { "User-Agent": UA } });
      });
      console.log("[CircleFTP] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[CircleFTP] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "Circle FTP Configuration" },
    {
      type: "text",
      key: "circleApiUrl",
      label: "Circle FTP API Base URL",
      placeholder: DEFAULT_API_URL,
      defaultValue: DEFAULT_API_URL,
      description: "Default: http://new.circleftp.net:5000/api"
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

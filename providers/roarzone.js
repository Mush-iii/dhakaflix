/**
 * roarzone - Nuvio Provider (BDIX)
 * Emby guest-login scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "RoarZone";
var DEFAULT_EMBY_URL = "https://play.roarzone.net";
var DEFAULT_USERNAME = "RoarZone_Guest";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var TOKEN_MS = 30 * 60 * 1000;
var auth = {};

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
  var c = norm(candidate).replace(/^the /, "");
  var q = norm(query).replace(/^the /, "");
  if (!c || !q) return false;
  if (c === q) return true;
  var cw = c.split(" ");
  var qw = q.split(" ");
  if (qw.length === 1 || cw.length === 1) return false;
  if (c.indexOf(q + " ") === 0 || q.indexOf(c + " ") === 0) return Math.abs(cw.length - qw.length) <= 3;
  return false;
}

function yearOk(a, b) {
  if (!a || !b) return true;
  return Math.abs(a - b) <= 1;
}

function resolveMeta(id, mediaType, tmdbKey) {
  return run(function* () {
    if (id && typeof id === "object") {
      return { title: id.title || id.name || "", year: parseInt(id.year || "", 10) || null, imdb: id.imdb_id || id.imdbId || null, tmdb: id.tmdb_id || id.tmdbId || null };
    }
    var s = String(id || "").trim();
    if (!s) return null;
    var isTv = mediaType === "tv";
    var isImdb = /^tt\d+/.test(s);
    if (!isImdb && !/^\d+$/.test(s)) return { title: s, year: null, imdb: null, tmdb: null };
    var keys = (tmdbKey ? [tmdbKey] : []).concat(DEFAULT_TMDB_KEYS);
    for (var i = 0; i < keys.length; i++) {
      try {
        var url = isImdb
          ? "https://api.themoviedb.org/3/find/" + s.split(":")[0] + "?external_source=imdb_id&api_key=" + encodeURIComponent(keys[i])
          : "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + s + "?append_to_response=external_ids&api_key=" + encodeURIComponent(keys[i]);
        var r = yield safeFetch(url, { headers: { Accept: "application/json" } }, 7000);
        if (!r.ok) continue;
        var d = yield r.json();
        if (isImdb) {
          d = ((isTv ? d.tv_results : d.movie_results) || [])[0];
          if (!d) continue;
        }
        var date = d.release_date || d.first_air_date || "";
        return {
          title: d.title || d.name || d.original_title || d.original_name,
          year: parseInt(date.slice(0, 4), 10) || null,
          imdb: isImdb ? s.split(":")[0] : (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null,
          tmdb: isImdb ? d.id : Number(s)
        };
      } catch (e) {
        console.log("[RoarZone] TMDB key " + i + " failed:", e.message);
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
        if (cd && cd.meta && cd.meta.name) {
          return { title: cd.meta.name, year: parseInt(cd.meta.year, 10) || null, imdb: s.split(":")[0], tmdb: null };
        }
      } catch (e) {
        console.log("[RoarZone] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function authenticate(base, user, force) {
  var key = base + "|" + user;
  var c = auth[key];
  if (!force && c && Date.now() < c.exp) return Promise.resolve(c.token);
  return safeFetch(
    base + "/emby/Users/AuthenticateByName",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization": 'MediaBrowser Client="Nuvio", Device="Nuvio", DeviceId="nuvio-roarzone", Version="1.0.0"'
      },
      body: JSON.stringify({ Username: user, Pw: "" })
    },
    8000
  )
    .then(function (r) {
      if (!r.ok) throw new Error("auth " + r.status);
      return r.json();
    })
    .then(function (d) {
      if (!d || !d.AccessToken) throw new Error("no token");
      auth[key] = { token: d.AccessToken, exp: Date.now() + TOKEN_MS };
      return d.AccessToken;
    });
}

function embyItems(base, token, params) {
  var q = Object.keys(params)
    .map(function (k) { return k + "=" + encodeURIComponent(params[k]); })
    .join("&");
  return safeFetch(base + "/emby/Items?" + q + "&api_key=" + encodeURIComponent(token), { headers: { Accept: "application/json" } }, 10000)
    .then(function (r) {
      if (r.status === 401) throw new Error("401");
      return r.ok ? r.json() : null;
    })
    .then(function (d) { return (d && d.Items) || []; });
}

function findItems(base, token, meta, type) {
  return run(function* () {
    var common = { IncludeItemTypes: type, Recursive: "true", Fields: type === "Movie" ? "MediaSources,ProviderIds,Path,ProductionYear" : "ProviderIds,ProductionYear" };
    var ids = [];
    if (meta.imdb) ids.push("imdb." + meta.imdb);
    if (meta.tmdb) ids.push("tmdb." + meta.tmdb);
    for (var i = 0; i < ids.length; i++) {
      var items = yield embyItems(base, token, Object.assign({ AnyProviderIdEquals: ids[i] }, common));
      if (items.length) return items;
    }
    var term = meta.title.split(/[:\-\u2013]/)[0].trim();
    if (!term) return [];
    var res = yield embyItems(base, token, Object.assign({ SearchTerm: term }, common));
    return res.filter(function (it) {
      return titlesMatch(it.Name, meta.title) && yearOk(it.ProductionYear, meta.year);
    });
  });
}

function qualityOf(s) {
  var l = String(s || "").toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(l)) return "4K";
  if (/1080p|fhd/.test(l)) return "1080p";
  if (/720p/.test(l)) return "720p";
  if (/480p/.test(l)) return "480p";
  if (/360p/.test(l)) return "360p";
  return null;
}

function heightQuality(h) {
  if (!h) return "HD";
  if (h >= 2000) return "4K";
  if (h >= 1000) return "1080p";
  if (h >= 700) return "720p";
  if (h >= 440) return "480p";
  return "360p";
}

var QRANK = { "4K": 5, "1080p": 4, "720p": 3, "HD": 2, "480p": 1, "360p": 0 };

function sourceQuality(src) {
  var q = qualityOf((src.Name || "") + " " + (src.Path || ""));
  if (q) return q;
  var v = (src.MediaStreams || []).filter(function (m) { return m.Type === "Video"; })[0];
  return heightQuality(v && (v.Height || v.Width && Math.round(v.Width * 9 / 16)));
}

function sizeStr(n) {
  if (!n) return "";
  var gb = n / 1073741824;
  return gb >= 1 ? gb.toFixed(2) + " GB" : Math.round(n / 1048576) + " MB";
}

function toStreams(base, token, item, label) {
  var out = [];
  (item.MediaSources || []).forEach(function (src) {
    var q = sourceQuality(src);
    var ext = String(src.Container || "").split(",")[0].toUpperCase();
    var size = sizeStr(src.Size);
    var file = src.Path ? String(src.Path).split(/[\\/]/).pop() : src.Name || "";
    out.push({
      name: PROVIDER_NAME,
      title: "[RoarZone] " + label + q + (ext ? " [" + ext + "]" : "") + (size ? " " + size : "") + (file ? " " + file : ""),
      url: base + "/emby/videos/" + item.Id + "/original." + (String(src.Container || "mkv").split(",")[0].toLowerCase()) + "?MediaSourceId=" + encodeURIComponent(src.Id || item.Id) + "&api_key=" + encodeURIComponent(token),
      quality: q,
      headers: { "User-Agent": UA }
    });
  });
  return out;
}

function movieStreams(base, token, meta) {
  return run(function* () {
    var movies = yield findItems(base, token, meta, "Movie");
    var out = [];
    movies.forEach(function (m) { out = out.concat(toStreams(base, token, m, "")); });
    return out;
  });
}

function tvStreams(base, token, meta, s, e) {
  return run(function* () {
    var shows = yield findItems(base, token, meta, "Series");
    if (!shows.length) return [];
    var out = [];
    for (var i = 0; i < Math.min(shows.length, 3); i++) {
      var r = yield safeFetch(
        base + "/emby/Shows/" + shows[i].Id + "/Episodes?Season=" + s + "&Fields=MediaSources,Path&api_key=" + encodeURIComponent(token),
        { headers: { Accept: "application/json" } },
        10000
      );
      if (r.status === 401) throw new Error("401");
      if (!r.ok) continue;
      var d = yield r.json();
      ((d && d.Items) || []).forEach(function (ep) {
        if (ep.IndexNumber !== e) return;
        if (ep.ParentIndexNumber != null && ep.ParentIndexNumber !== s) return;
        out = out.concat(toStreams(base, token, ep, "S" + s + "E" + e + " - "));
      });
    }
    return out;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.embyUrl || DEFAULT_EMBY_URL).trim().replace(/\/+$/, "");
      var user = String(settings.embyUser || DEFAULT_USERNAME);
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[RoarZone] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      console.log("[RoarZone] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var streams = [];
      for (var attempt = 0; attempt < 2; attempt++) {
        var token = yield authenticate(base, user, attempt > 0);
        try {
          streams = isTv ? yield tvStreams(base, token, meta, s, e) : yield movieStreams(base, token, meta);
          break;
        } catch (err) {
          if (err.message !== "401" || attempt) throw err;
        }
      }

      var seen = {};
      streams = streams.filter(function (x) {
        if (seen[x.url]) return false;
        seen[x.url] = true;
        return true;
      });
      streams.sort(function (a, b) { return (QRANK[b.quality] || 0) - (QRANK[a.quality] || 0); });
      console.log("[RoarZone] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[RoarZone] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "RoarZone Configuration" },
    {
      type: "text",
      key: "embyUrl",
      label: "Emby Base URL",
      placeholder: DEFAULT_EMBY_URL,
      defaultValue: DEFAULT_EMBY_URL,
      description: "Default: " + DEFAULT_EMBY_URL
    },
    {
      type: "text",
      key: "embyUser",
      label: "Emby Guest Username",
      placeholder: DEFAULT_USERNAME,
      defaultValue: DEFAULT_USERNAME,
      description: "Guest account with an empty password"
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

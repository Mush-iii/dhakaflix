/**
 * royalflix - Nuvio Provider (BDIX)
 * RoyalFlix autoindex scraper ported from CloudStream. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "RoyalFlix";
var DEFAULT_BASE_URL = "http://royalflix.net";
var DEFAULT_TMDB_KEYS = [
  "af3d19d7c3406af63381ebd165e32e86",
  "1865f43a0549ca50d341dd9ab8b29f49",
  "439c478a771f35c05022f9feabcca01c",
  "b8a6a683a48e77c8e96bf71b3e5cb5b2",
  "8265bd1679663a7ea12ac168da84d2e8"
];
var EDITION_RE = /^(extended|remastered|unrated|special|directors)$/;
var VIDEO_RE = /\.(mp4|mkv|avi|webm|mov|m4v)$/i;
var EP_RE = /[Ss](\d{1,2})[Ee][Pp]?(\d{1,3})/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var CACHE_MS = 30 * 60 * 1000;
var MAX_DEPTH = 6;
var MAX_CONC = 8;
var SECTIONS = [
  { key: "hollywood-new", tv: false, roots: ["Data/disk1/movies/hollywood", "Data/disk6/movies/hollywood"], mirror: ["Data/disk3/movies/movies/hollywood"] },
  { key: "hollywood-classic", tv: false, roots: ["Data/disk1/hollywood"] },
  { key: "bollywood-new", tv: false, roots: ["Data/disk1/movies/bollywood"], mirror: ["Data/disk3/movies/movies/bollywood"] },
  { key: "bollywood-classic", tv: false, roots: ["Data/disk2/bollywood"] },
  { key: "hindi-dubbed", tv: false, roots: ["Data/disk1/movies/hindidub", "Data/disk2/movies/hindidub", "Data/disk4/movies/hindi%20dubbed", "Data/disk6/movies/hindidub"], mirror: ["Data/disk3/movies/movies/hindidubbed"] },
  { key: "indian-bangla", tv: false, roots: ["Data/disk1/movies/indianbangla", "Data/disk2/movies/indianbangla", "Data/disk4/movies/indianbangla", "Data/disk3/movies/indian%20bangla"], mirror: ["Data/disk3/movies/movies/indian%20bangla"] },
  { key: "bangla", tv: false, roots: ["Data/disk6/movies/bangla"] },
  { key: "korean", tv: false, roots: ["Data/disk1/movies/korean", "Data/disk2/movies/korean", "Data/disk4/movies/korean"], mirror: ["Data/disk3/movies/movies/korean"] },
  { key: "tamil", tv: false, roots: ["Data/disk1/movies/tamil", "Data/disk2/movies/tamil", "Data/disk3/movies/tamil", "Data/disk4/movies/tamil"] },
  { key: "animation", tv: false, roots: ["Data/disk1/movies/animation", "Data/disk2/movies/animation", "Data/disk4/movies/animation"], mirror: ["Data/disk3/movies/movies/animation"] },
  { key: "turkish", tv: false, roots: ["Data/disk3/movies/Turkish", "Data/disk3/movies/turkish"] },
  { key: "tv-series", tv: true, roots: ["Data/disk6/tvseries"] }
];
var dirCache = {};
var sectionCache = {};
var active = 0;
var queue = [];

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
        console.log("[RoyalFlix] TMDB key " + i + " failed:", e.message);
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
        console.log("[RoyalFlix] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

var QRANK = { "4K": 5, "1080p": 4, "720p": 3, "HD": 2, "480p": 1, "360p": 0 };

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function flatten(arrs) {
  return arrs.reduce(function (a, b) { return a.concat(b); }, []);
}

function limited(fn) {
  return new Promise(function (resolve, reject) {
    function go() {
      active++;
      fn().then(
        function (v) { active--; next(); resolve(v); },
        function (e) { active--; next(); reject(e); }
      );
    }
    if (active < MAX_CONC) go();
    else queue.push(go);
  });
}

function next() {
  if (queue.length && active < MAX_CONC) queue.shift()();
}

function resolveHref(base, href) {
  if (/^https?:\/\//i.test(href)) return href;
  var om = base.match(/^https?:\/\/[^\/]+/);
  if (href.charAt(0) === "/") return (om ? om[0] : "") + href;
  return (base.charAt(base.length - 1) === "/" ? base : base + "/") + href;
}

function isJunk(name) {
  var l = name.toLowerCase();
  return l === "lost+found" || l === "lostandfound" || l === "wget-log" || l === "parent directory" || name.charAt(0) === "." || l.indexOf("wget-log.") === 0;
}

function parseListing(html, base) {
  var pm = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  var scope = pm ? pm[1] : html;
  var out = [];
  var seen = {};
  var re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(scope))) {
    var href = m[1].replace(/&amp;/g, "&");
    if (/^(\?|#|mailto:|javascript:)/i.test(href) || href === ".." || href === "../" || href === "./") continue;
    var isDir = href.charAt(href.length - 1) === "/";
    var url = resolveHref(base, href);
    if (seen[url]) continue;
    var parts = url.replace(/\/+$/, "").split("/");
    var name = safeDecode(parts[parts.length - 1]).trim();
    if (!name || name === "Parent Directory") continue;
    seen[url] = true;
    out.push({ name: name, url: url, dir: isDir });
  }
  return out;
}

function listFolder(url) {
  var c = dirCache[url];
  if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.items);
  return limited(function () { return safeFetch(url, {}, 15000); })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (html) {
      var items = html ? parseListing(html, url) : [];
      if (items.length) dirCache[url] = { at: Date.now(), items: items };
      return items;
    })
    .catch(function () { return []; });
}

function folderBase(url) {
  var parts = url.split("/").filter(Boolean);
  return safeDecode(parts[parts.length - 1] || "").trim();
}

function cleanFileTitle(name) {
  return name.replace(VIDEO_RE, "").replace(/\./g, " ").replace(/\s+/g, " ").trim();
}

function parseSeason(name) {
  var m = /season\s*(\d+)/i.exec(name) || /\bS(\d{1,2})\b/i.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function walk(root, depth) {
  return run(function* () {
    if (depth > MAX_DEPTH) return [];
    var rows = yield listFolder(root);
    if (!rows.length) return [];
    var folders = rows.filter(function (r) { return r.dir && !isJunk(r.name); });
    var videos = rows.filter(function (r) { return !r.dir && VIDEO_RE.test(r.name); });
    if (videos.length) {
      if (!folders.length) {
        if (depth === 0) return videos.map(function (v) { return { name: cleanFileTitle(v.name), url: v.url }; });
        return [{ name: folderBase(root), url: root }];
      }
      if (depth > 0) return [{ name: folderBase(root), url: root }];
    }
    var loose = depth === 0 ? videos.map(function (v) { return { name: cleanFileTitle(v.name), url: v.url }; }) : [];
    if (!folders.length) return loose;
    var seasonLike = folders.filter(function (f) { return parseSeason(f.name) !== null; });
    if (seasonLike.length && seasonLike.length === folders.length) return [{ name: folderBase(root), url: root }];
    var subs = yield Promise.all(folders.map(function (f) { return walk(f.url, depth + 1); }));
    var seen = {};
    return loose.concat(flatten(subs)).filter(function (i) {
      if (seen[i.url]) return false;
      seen[i.url] = true;
      return true;
    });
  });
}

function getSection(base, sec) {
  var key = base + "|" + sec.key;
  var c = sectionCache[key];
  if (c && Date.now() - c.at < CACHE_MS) return c.promise;
  var promise = run(function* () {
    var join = function (r) { return base + "/" + r.replace(/^\/+|\/+$/g, "") + "/"; };
    var lists = yield Promise.all(sec.roots.map(function (r) { return walk(join(r), 0); }));
    var items = flatten(lists);
    if (!items.length && sec.mirror) {
      lists = yield Promise.all(sec.mirror.map(function (r) { return walk(join(r), 0); }));
      items = flatten(lists);
    }
    return items;
  });
  sectionCache[key] = { at: Date.now(), promise: promise };
  promise.then(function (items) {
    if (!items.length) delete sectionCache[key];
    console.log("[RoyalFlix] section " + sec.key + ": " + items.length + " item(s)");
  }, function () { delete sectionCache[key]; });
  return promise;
}

function parseTitle(name) {
  var n = String(name || "").replace(VIDEO_RE, "");
  var tv = /\(\s*TV[^)]*\)/i.exec(n);
  var year = null;
  var title;
  if (tv) {
    var ty = /(?:19|20)\d{2}/.exec(tv[0]);
    year = ty ? Number(ty[0]) : null;
    title = n.slice(0, tv.index);
  } else {
    var re = /\(((?:19|20)\d{2})\)/g;
    var m;
    var last = null;
    while ((m = re.exec(n))) last = m;
    if (!last) {
      var re2 = /[\s.\[_-]((?:19|20)\d{2})(?=$|[\s.)\]_-])/g;
      while ((m = re2.exec(n))) last = m;
    }
    if (last) {
      year = Number(last[1]);
      title = n.slice(0, last.index);
    } else {
      title = n.replace(/\[.*?\]/g, "").replace(/\b(480p|720p|1080p|2160p|4k|uhd|hdr|web-?dl|blu-?ray|webrip|hdtv|nordic)\b/gi, "");
    }
  }
  title = title.replace(/[._]+/g, " ").replace(/[\s(\[-]+$/, "").trim();
  return { title: title, year: year };
}

function stripThe(s) {
  return norm(s).replace(/^the /, "");
}

function pickItems(items, meta) {
  var out = [];
  items.forEach(function (it) {
    var p = parseTitle(it.name);
    if (!p.title) return;
    if (!titlesMatch(stripThe(p.title), stripThe(meta.title))) return;
    if (meta.year && p.year && Math.abs(p.year - meta.year) > 1) return;
    out.push({
      name: it.name,
      url: it.url,
      exact: stripThe(p.title) === stripThe(meta.title) ? 0 : 1,
      yd: meta.year && p.year ? Math.abs(p.year - meta.year) : 0
    });
  });
  out.sort(function (a, b) { return a.exact - b.exact || a.yd - b.yd; });
  return out;
}

function collectVideos(url, depth) {
  return run(function* () {
    var rows = yield listFolder(url);
    var vids = rows.filter(function (r) { return !r.dir && VIDEO_RE.test(r.name) && !/\b(sample|trailer)\b/i.test(r.name); });
    if (depth <= 0) return vids;
    var subs = rows.filter(function (r) { return r.dir && !isJunk(r.name); });
    var res = yield Promise.all(subs.map(function (s) { return collectVideos(s.url, depth - 1); }));
    return vids.concat(flatten(res));
  });
}

function episodeNumber(name) {
  var m = EP_RE.exec(name);
  return m ? parseInt(m[2], 10) : null;
}

function filesForMovie(item) {
  if (VIDEO_RE.test(item.url)) return Promise.resolve([{ name: safeDecode(item.url.split("/").pop()), url: item.url }]);
  return collectVideos(item.url, 1);
}

function filesForEpisode(item, s, e) {
  return run(function* () {
    if (VIDEO_RE.test(item.url)) return [];
    var rows = yield listFolder(item.url);
    var vids = rows.filter(function (r) { return !r.dir && VIDEO_RE.test(r.name); });
    var folders = rows.filter(function (r) { return r.dir && !isJunk(r.name); });
    var out = [];
    if (vids.length) {
      var flat = vids.filter(function (v) {
        var m = EP_RE.exec(v.name);
        return m && parseInt(m[1], 10) === s && parseInt(m[2], 10) === e;
      });
      out = out.concat(flat);
    }
    var seasonFolders = folders.filter(function (f) { return parseSeason(f.name) === s; });
    for (var i = 0; i < seasonFolders.length; i++) {
      var files = (yield listFolder(seasonFolders[i].url))
        .filter(function (r) { return !r.dir && VIDEO_RE.test(r.name); })
        .sort(function (a, b) {
          var x = episodeNumber(a.name);
          var y = episodeNumber(b.name);
          return (x === null ? 1e9 : x) - (y === null ? 1e9 : y);
        });
      var hit = files.filter(function (f) { return episodeNumber(f.name) === e; });
      if (!hit.length && files[e - 1] && episodeNumber(files[e - 1].name) === null) hit = [files[e - 1]];
      out = out.concat(hit);
    }
    return out;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.royalflixBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      var isTv = mediaType === "tv";
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[RoyalFlix] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      console.log("[RoyalFlix] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var secs = SECTIONS.filter(function (x) { return x.tv === isTv; });
      var lists = yield Promise.all(secs.map(function (sec) {
        return getSection(base, sec).catch(function () { return []; });
      }));
      var cands = pickItems(flatten(lists), meta);
      var seenC = {};
      cands = cands.filter(function (c) {
        if (seenC[c.url]) return false;
        seenC[c.url] = true;
        return true;
      }).slice(0, 4);
      console.log("[RoyalFlix] " + cands.length + " candidate(s)");
      if (!cands.length) return [];

      var groups = yield Promise.all(cands.map(function (c) {
        return (isTv ? filesForEpisode(c, s, e) : filesForMovie(c)).catch(function () { return []; });
      }));

      var seen = {};
      var streams = [];
      flatten(groups).forEach(function (f) {
        if (seen[f.url]) return;
        seen[f.url] = true;
        var q = qualityOf(safeDecode(f.url));
        var ext = (f.name.match(/\.([a-z0-9]+)$/i) || [0, "mp4"])[1].toUpperCase();
        streams.push({
          name: PROVIDER_NAME,
          title: "[RoyalFlix] " + (isTv ? "S" + s + "E" + e + " - " : "") + q + " [" + ext + "] " + f.name,
          url: f.url,
          quality: q,
          headers: { "User-Agent": UA }
        });
      });
      streams.sort(function (a, b) { return (QRANK[b.quality] || 0) - (QRANK[a.quality] || 0); });
      console.log("[RoyalFlix] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[RoyalFlix] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "RoyalFlix Configuration" },
    {
      type: "text",
      key: "royalflixBaseUrl",
      label: "RoyalFlix Base URL",
      placeholder: DEFAULT_BASE_URL,
      defaultValue: DEFAULT_BASE_URL,
      description: "Default: http://royalflix.net"
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

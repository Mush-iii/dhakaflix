/**
 * dhakaflix - Nuvio Provider (BDIX)
 * Live h5ai directory scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "DhakaFlix";
var DEFAULT_MOVIE_ROOTS = [
  "http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/",
  "http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/"
];
var DEFAULT_TV_ROOTS = [];
var VIDEO_RE = /\.(mkv|mp4|avi|m4v|webm|ts|mov)$/i;
var EDITION_RE = /^(extended|remastered|unrated|special|directors)$/;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var CACHE_MS = 30 * 60 * 1000;
var dirCache = {};

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

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
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
  return false;
}

function yearOk(a, b) {
  if (!a || !b) return true;
  return Math.abs(a - b) <= 1;
}

function parseName(name) {
  var base = name.replace(VIDEO_RE, "");
  var m;
  var last = null;
  var re = /\(((?:19|20)\d{2})\)/g;
  while ((m = re.exec(base))) last = m;
  if (!last) {
    var re2 = /[\s.\[_-]((?:19|20)\d{2})(?=$|[\s.)\]_-])/g;
    while ((m = re2.exec(base))) last = m;
  }
  if (!last) return { title: base.replace(/[._]+/g, " ").trim(), year: null, isYearFolder: false };
  var title = base
    .slice(0, last.index)
    .replace(/[._]+/g, " ")
    .replace(/[\s(\[-]+$/, "")
    .trim();
  if (!title) return { title: "", year: Number(last[1]), isYearFolder: last.index === 0 };
  return { title: title, year: Number(last[1]), isYearFolder: false };
}

function yearFolderOk(name, year) {
  var p = parseName(name);
  if (!p.isYearFolder) return false;
  if (!year) return true;
  if (/before/i.test(name)) return year <= p.year;
  return Math.abs(p.year - year) <= 1;
}

function fixRoot(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (/\s/.test(u)) u = encodeURI(u);
  if (u.charAt(u.length - 1) !== "/") u += "/";
  return u;
}

function splitRoots(s) {
  return String(s || "")
    .split(/[,\n]/)
    .map(fixRoot)
    .filter(Boolean);
}

function mergeRoots(defaults, extra) {
  var seen = {};
  var out = [];
  defaults.concat(extra).forEach(function (r) {
    r = fixRoot(r);
    var k = safeDecode(r);
    if (r && !seen[k]) {
      seen[k] = true;
      out.push(r);
    }
  });
  return out;
}

function entryFromAbs(abs, base, dbase) {
  var dabs = safeDecode(abs);
  if (dabs.indexOf(dbase) !== 0 || dabs === dbase) return null;
  var rest = dabs.slice(dbase.length).replace(/\/$/, "");
  if (!rest || rest.indexOf("/") !== -1 || rest.charAt(0) === "?") return null;
  return { name: rest, href: abs, dir: dabs.charAt(dabs.length - 1) === "/", key: dabs };
}

function parseListing(html, base) {
  var om = base.match(/^https?:\/\/[^\/]+/);
  var origin = om ? om[0] : "";
  var dbase = safeDecode(base);
  var out = [];
  var seen = {};
  var re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html))) {
    var href = m[1].replace(/&amp;/g, "&");
    if (/^(\?|#|mailto:|javascript:|\.\.)/i.test(href)) continue;
    if (/\s/.test(href)) href = encodeURI(href);
    href = href.replace(/^\.\//, "");
    var abs;
    if (/^https?:\/\//i.test(href)) abs = href;
    else if (href.charAt(0) === "/") abs = origin + href;
    else abs = base + href;
    var e = entryFromAbs(abs, base, dbase);
    if (!e || seen[e.key]) continue;
    seen[e.key] = true;
    out.push(e);
  }
  return out;
}

function listH5ai(url) {
  var om = url.match(/^(https?:\/\/[^\/]+)(\/.*)$/);
  if (!om) return Promise.resolve([]);
  var origin = om[1];
  var dbase = safeDecode(url);
  return safeFetch(
    origin + "/_h5ai/public/php/api.php",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", items: { href: om[2], what: 1 } })
    },
    15000
  )
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var out = [];
      var seen = {};
      ((d && d.items) || []).forEach(function (it) {
        if (!it || !it.href) return;
        var abs = it.href.charAt(0) === "/" ? origin + it.href : it.href;
        var e = entryFromAbs(abs, url, dbase);
        if (e && !seen[e.key]) {
          seen[e.key] = true;
          out.push(e);
        }
      });
      return out;
    });
}

function listDir(url) {
  var c = dirCache[url];
  if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.items);
  return safeFetch(url, {}, 15000)
    .then(function (r) {
      if (!r.ok) throw new Error(r.status + " " + url);
      return r.text();
    })
    .then(function (html) {
      var items = parseListing(html, url);
      if (items.length || html.indexOf("_h5ai") === -1) return items;
      return listH5ai(url).catch(function () { return []; });
    })
    .then(function (items) {
      console.log("[DhakaFlix] listed " + items.length + " items: " + url);
      if (items.length) dirCache[url] = { at: Date.now(), items: items };
      return items;
    });
}

function flatten(arrs) {
  return arrs.reduce(function (a, b) { return a.concat(b); }, []);
}

function collectVideos(url, depth, rel) {
  return run(function* () {
    var items;
    try {
      items = yield listDir(url);
    } catch (e) {
      return [];
    }
    var out = [];
    var subs = [];
    items.forEach(function (it) {
      var path = rel ? rel + "/" + it.name : it.name;
      if (!it.dir) {
        if (VIDEO_RE.test(it.name) && !/\b(sample|trailer)\b/i.test(it.name)) {
          out.push({ name: it.name, href: it.href, path: path });
        }
      } else if (depth > 0) {
        subs.push(collectVideos(it.href, depth - 1, path));
      }
    });
    var res = yield Promise.all(subs);
    return out.concat(flatten(res));
  });
}

function pick(items, meta, isTv) {
  return items.filter(function (it) {
    if (isTv && !it.dir) return false;
    if (!it.dir && !VIDEO_RE.test(it.name)) return false;
    var p = parseName(it.name);
    if (p.isYearFolder) return false;
    return titlesMatch(p.title, meta.title) && yearOk(p.year, meta.year);
  });
}

function scan(url, meta, isTv, depth) {
  return run(function* () {
    var items = yield listDir(url);
    var hits = pick(items, meta, isTv);
    if (depth > 0) {
      var subs = items.filter(function (it) {
        if (!it.dir) return false;
        var p = parseName(it.name);
        if (p.isYearFolder) return yearFolderOk(it.name, meta.year);
        return !p.year;
      });
      if (!meta.year) subs = subs.slice(0, 8);
      subs = subs.slice(0, 8);
      var res = yield Promise.all(
        subs.map(function (s) {
          return scan(s.href, meta, isTv, depth - 1).catch(function () { return []; });
        })
      );
      hits = hits.concat(flatten(res));
    }
    return hits;
  });
}

function epMatch(path, s, e) {
  var parts = path.split("/");
  var file = parts[parts.length - 1];
  var m = file.match(/S0*(\d{1,2})[\s._-]*E0*(\d{1,3})/i) || path.match(/S0*(\d{1,2})[\s._-]*E0*(\d{1,3})/i);
  if (m) return Number(m[1]) === s && Number(m[2]) === e;
  m = file.match(/(?:^|[^0-9])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/i);
  if (m) return Number(m[1]) === s && Number(m[2]) === e;
  var sm = path.match(/season[\s._-]*0*(\d{1,2})/i);
  var seasonNum = sm ? Number(sm[1]) : 1;
  var em = file.match(/(?:^|[\s._\-\[(])(?:e|ep|episode)[\s._-]*0*(\d{1,3})(?=$|[\s._\-\])])/i);
  if (em) return seasonNum === s && Number(em[1]) === e;
  return false;
}

function searchRoot(root, meta, isTv, season, episode) {
  return run(function* () {
    var cands = (yield scan(root, meta, isTv, 2)).slice(0, 4);
    console.log("[DhakaFlix] " + cands.length + " candidate(s) in " + root);
    var groups = yield Promise.all(
      cands.map(function (c) {
        if (c.dir) return collectVideos(c.href, isTv ? 3 : 2, c.name);
        return Promise.resolve([{ name: c.name, href: c.href, path: c.name }]);
      })
    );
    var files = flatten(groups);
    if (isTv) {
      files = files.filter(function (f) { return epMatch(f.path, season, episode); });
    }
    return files;
  });
}

function resolveMeta(id, mediaType, tmdbKey) {
  return run(function* () {
    if (id && typeof id === "object") {
      return { title: id.title || id.name || "", year: parseInt(id.year || "", 10) || null };
    }
    var s = String(id || "").trim();
    var isTv = mediaType === "tv";
    try {
      if (/^tt\d+/.test(s)) {
        var r = yield safeFetch(
          "https://v3-cinemeta.strem.io/meta/" + (isTv ? "series" : "movie") + "/" + s.split(":")[0] + ".json",
          { headers: { Accept: "application/json" } },
          7000
        );
        var d = yield r.json();
        if (d && d.meta && d.meta.name) {
          return { title: d.meta.name, year: parseInt(d.meta.year, 10) || null };
        }
      } else if (/^\d+$/.test(s)) {
        if (!tmdbKey) {
          console.log("[DhakaFlix] numeric TMDB id " + s + " but no TMDB API key set in settings");
          return null;
        }
        var url =
          "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + s + "?api_key=" + encodeURIComponent(tmdbKey);
        var r2 = yield safeFetch(url, { headers: { Accept: "application/json" } }, 7000);
        if (r2.ok) {
          var d2 = yield r2.json();
          var date = d2.release_date || d2.first_air_date || "";
          return {
            title: d2.title || d2.name || d2.original_title || d2.original_name,
            year: parseInt(date.slice(0, 4), 10) || null
          };
        }
        console.log("[DhakaFlix] TMDB lookup failed: " + r2.status);
      } else if (s) {
        return { title: s, year: null };
      }
    } catch (e) {
      console.log("[DhakaFlix] metadata failed:", e.message);
    }
    return null;
  });
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

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var isTv = mediaType === "tv";
      var roots = mergeRoots(
        isTv ? DEFAULT_TV_ROOTS : DEFAULT_MOVIE_ROOTS,
        splitRoots(isTv ? settings.tvRoots : settings.movieRoots)
      );
      if (!roots.length) {
        console.log("[DhakaFlix] no " + (isTv ? "TV" : "movie") + " roots configured");
        return [];
      }
      var meta = yield resolveMeta(tmdbId, mediaType, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[DhakaFlix] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      var s = season ? parseInt(season, 10) : 1;
      var e = episode ? parseInt(episode, 10) : 1;
      console.log("[DhakaFlix] searching \"" + meta.title + "\" (" + (meta.year || "?") + ") " + mediaType);

      var results = yield Promise.all(
        roots.map(function (root) {
          return searchRoot(root, meta, isTv, s, e).catch(function (err) {
            console.log("[DhakaFlix] root failed " + root + ": " + err.message);
            return [];
          });
        })
      );

      var seen = {};
      var streams = [];
      flatten(results).forEach(function (f) {
        if (seen[f.href]) return;
        seen[f.href] = true;
        var q = qualityOf(f.path);
        var ext = (f.name.match(/\.([a-z0-9]+)$/i) || [0, "mp4"])[1].toUpperCase();
        streams.push({
          name: PROVIDER_NAME,
          title: "[DhakaFlix] " + (isTv ? "S" + s + "E" + e + " - " : "") + q + " [" + ext + "] " + f.name,
          url: f.href,
          quality: q,
          headers: { "User-Agent": UA }
        });
      });
      streams.sort(function (a, b) { return (QRANK[b.quality] || 0) - (QRANK[a.quality] || 0); });
      console.log("[DhakaFlix] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[DhakaFlix] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "DhakaFlix Configuration" },
    {
      type: "text",
      key: "movieRoots",
      label: "Extra movie folder URLs (comma separated)",
      placeholder: "http://172.16.50.x/DHAKA-FLIX-x/Some%20Movies/",
      description: "Added on top of the built-in English Movies folders"
    },
    {
      type: "text",
      key: "tvRoots",
      label: "TV series folder URLs (comma separated)",
      placeholder: "http://172.16.50.x/DHAKA-FLIX-x/TV-WEB-Series/",
      description: "Folders that directly contain show folders"
    },
    { type: "header", label: "TMDB" },
    {
      type: "text",
      key: "tmdbApiKey",
      label: "TMDB API Key",
      placeholder: "Your TMDB v3 API key",
      description: "Required when Nuvio passes numeric TMDB ids. IMDb ids (tt...) work without it."
    }
  ]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };

if (typeof globalThis !== "undefined" && typeof module !== "undefined" && module.exports) {
  globalThis.getStreams = module.exports.getStreams;
  globalThis.onSettings = module.exports.onSettings;
}

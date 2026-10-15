/**
 * ghuri - Nuvio Provider (BDIX)
 * Ghuri (103.96.104.6) movie scraper. Runs on the device, no server needed.
 */
var PROVIDER_NAME = "Ghuri";
var DEFAULT_BASE_URL = "http://103.96.104.6";
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
  if (qw.length === 1) return false;
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

function absUrl(base, u) {
  u = decodeEntities(String(u || "").trim());
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === "/" ? "" : "/") + u;
}

function encodePath(u) {
  if (/%[0-9a-f]{2}/i.test(u)) return u;
  try {
    return encodeURI(u);
  } catch (e) {
    return u;
  }
}

function postPage(url, body, headers) {
  return safeFetch(url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }, headers || {}),
    body: body
  }, 10000)
    .then(function (r) { return r.ok ? r.text() : null; })
    .catch(function (e) {
      console.log("[Ghuri] POST failed " + url + ":", e.message);
      return null;
    });
}

function getPage(url, headers) {
  return safeFetch(url, { headers: headers || {} }, 10000)
    .then(function (r) { return r.ok ? r.text() : null; })
    .catch(function (e) {
      console.log("[Ghuri] request failed " + url + ":", e.message);
      return null;
    });
}

function resolveMeta(id, tmdbKey) {
  return run(function* () {
    if (id && typeof id === "object") {
      return { title: id.title || id.name || "", year: parseInt(id.year || "", 10) || null, imdbId: id.imdbId || id.imdb_id || null };
    }
    var s = String(id || "").trim();
    if (!s) return null;
    var isImdb = /^tt\d+/.test(s);
    if (!isImdb && !/^\d+$/.test(s)) return { title: s, year: null, imdbId: null };
    var keys = (tmdbKey ? [tmdbKey] : []).concat(DEFAULT_TMDB_KEYS);
    for (var i = 0; i < keys.length; i++) {
      try {
        var url = isImdb
          ? "https://api.themoviedb.org/3/find/" + s.split(":")[0] + "?external_source=imdb_id&api_key=" + encodeURIComponent(keys[i])
          : "https://api.themoviedb.org/3/movie/" + s + "?append_to_response=external_ids&api_key=" + encodeURIComponent(keys[i]);
        var r = yield safeFetch(url, { headers: { Accept: "application/json" } }, 6000);
        if (!r.ok) continue;
        var d = yield r.json();
        if (isImdb) {
          d = (d.movie_results || [])[0];
          if (!d) continue;
        }
        var date = d.release_date || "";
        return {
          title: d.title || d.original_title,
          year: parseInt(date.slice(0, 4), 10) || null,
          imdbId: isImdb ? s.split(":")[0] : (d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null)
        };
      } catch (e) {
        console.log("[Ghuri] TMDB key " + i + " failed:", e.message);
      }
    }
    if (isImdb) {
      try {
        var cr = yield safeFetch(
          "https://v3-cinemeta.strem.io/meta/movie/" + s.split(":")[0] + ".json",
          { headers: { Accept: "application/json" } },
          7000
        );
        var cd = yield cr.json();
        if (cd && cd.meta && cd.meta.name) return { title: cd.meta.name, year: parseInt(cd.meta.year, 10) || null, imdbId: s.split(":")[0] };
      } catch (e) {
        console.log("[Ghuri] cinemeta failed:", e.message);
      }
    }
    return null;
  });
}

function parseResults(html, base) {
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var href = attrOf(m[1], "href");
    var idm = /movie\.php\?imdbid=(tt\d+)/i.exec(href);
    if (!idm || seen[idm[1]]) continue;
    var inner = m[2];
    var title = "";
    var hm = /class=["'][^"']*searchheading[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(inner);
    if (hm) title = stripTags(hm[1]);
    if (!title) {
      var im = /<img\b[^>]*>/i.exec(inner);
      title = im ? attrOf(im[0], "alt").trim() : "";
    }
    if (!title) title = stripTags(inner);
    if (!title) continue;
    seen[idm[1]] = true;
    var ym = /\((\d{4})\)/.exec(title);
    var catm = /[?&]cat=([^&"']+)/i.exec(href);
    out.push({
      imdbId: idm[1],
      title: title,
      year: ym ? parseInt(ym[1], 10) : null,
      cat: catm ? decodeEntities(decodeURIComponent(catm[1].replace(/\+/g, " "))) : "",
      url: absUrl(base, href.charAt(0) === "/" || /^https?:/i.test(href) ? href : "/" + href)
    });
  }
  return out;
}

function search(base, title) {
  return run(function* () {
    var html = yield postPage(base + "/rpc.php", "queryString=" + encodeURIComponent(title), { Referer: base + "/", Origin: base });
    var items = html ? parseResults(html, base) : [];
    if (items.length) return items;
    html = yield getPage(base + "/msearch.php?q=&searchquery=" + encodeURIComponent(title) + "&q=M", { Referer: base + "/" });
    return html ? parseResults(html, base) : [];
  });
}

function extractVideos(html, base) {
  var urls = [];
  var m;
  var re = /<source\b[^>]*>/gi;
  while ((m = re.exec(html))) {
    var s = attrOf(m[0], "src");
    if (s) urls.push(absUrl(base, s));
  }
  var are = /<a\b[^>]*title=["']Download Movie["'][^>]*>/gi;
  while ((m = are.exec(html))) {
    var h = attrOf(m[0], "href");
    if (h) urls.push(absUrl(base, h));
  }
  var seen = {};
  return urls.filter(function (u) {
    if (!/\.(mp4|mkv|webm|m3u8)(\?|$)/i.test(u) || seen[u]) return false;
    seen[u] = true;
    return true;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      if (mediaType === "tv") return [];
      var settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
      var base = String(settings.ghuriBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      var meta = yield resolveMeta(tmdbId, settings.tmdbApiKey || null);
      if (!meta || !meta.title) {
        console.log("[Ghuri] could not resolve title for id " + JSON.stringify(tmdbId));
        return [];
      }
      console.log("[Ghuri] searching \"" + meta.title + "\" (" + (meta.year || "?") + ")");

      var items = yield search(base, meta.title);
      var cards = [];
      if (meta.imdbId) {
        cards = items.filter(function (c) { return c.imdbId === meta.imdbId; });
      }
      if (!cards.length) {
        cards = items.filter(function (c) { return titlesMatch(c.title, meta.title); });
        if (meta.year) {
          cards = cards.filter(function (c) { return !c.year || Math.abs(c.year - meta.year) <= 1; });
        }
      }
      cards = cards.slice(0, 2);
      console.log("[Ghuri] " + cards.length + " match(es)");
      if (!cards.length) return [];

      var results = yield Promise.all(cards.map(function (c) {
        return getPage(c.url, { Referer: base + "/" }).then(function (html) {
          if (!html) return [];
          var sizeM = /DOWNLOAD\s*<span[^>]*>\s*\[([^\]]+)\]/i.exec(html);
          var size = sizeM ? sizeM[1].trim() : "";
          return extractVideos(html, base).map(function (u) {
            var q = qualityOf(decodeURIComponent(u) + " " + c.title);
            return {
              name: PROVIDER_NAME,
              title: "[Ghuri] " + q + (size ? " | " + size : ""),
              url: encodePath(u),
              quality: q,
              headers: { "User-Agent": UA, Referer: c.url }
            };
          });
        });
      }));

      var seen = {};
      var streams = [];
      results.forEach(function (arr) {
        arr.forEach(function (st) {
          if (seen[st.url]) return;
          seen[st.url] = true;
          streams.push(st);
        });
      });
      console.log("[Ghuri] " + streams.length + " stream(s)");
      return streams;
    } catch (err) {
      console.log("[Ghuri] error:", err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    { type: "header", label: "Ghuri Configuration" },
    {
      type: "text",
      key: "ghuriBaseUrl",
      label: "Ghuri Base URL",
      placeholder: DEFAULT_BASE_URL,
      defaultValue: DEFAULT_BASE_URL,
      description: "Default: http://103.96.104.6"
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

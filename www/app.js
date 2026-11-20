/*
 * LibreTV iOS — 内置播放源的原生播放器前端
 * 纯静态实现，无打包工具。原生网络由 CapacitorHttp 接管，因此不受跨域限制。
 */
(function () {
  'use strict';

  var LS_SOURCES = 'libretv.sources.v1';
  var LS_PROGRESS = 'libretv.progress.v1';
  var LS_HISTORY = 'libretv.history.v1';
  var LS_LIVE_M3U = 'libretv.live.m3u.v1';
  var LS_LIVE_URL = 'libretv.live.url.v1';

  var APP_VERSION = '2.2';
  var UPDATE_REPO = 'vip369168/libretv-ios';
  var DEFAULT_LIVE_URL = 'https://iptv-org.github.io/iptv/countries/cn.m3u';

  var el = function (id) { return document.getElementById(id); };

  var state = {
    sources: [],
    activeSource: 'all',
    results: [],
    detail: null,
    groups: [],
    groupIndex: 0,
    episode: null,
    view: 'home',
    liveMode: false,
    liveChannels: [],
    liveGroup: '',
    latest: []
  };

  /* ---------- 原生桥 ---------- */

  function nativeHttp() {
    var cap = window.Capacitor;
    if (!cap || !cap.Plugins) return null;
    var http = cap.Plugins.CapacitorHttp;
    return (http && typeof http.get === 'function') ? http : null;
  }

  function getJson(url) {
    var http = nativeHttp();
    if (http) {
      return http.get({
        url: url,
        headers: { 'Accept': 'application/json, text/plain, */*' },
        connectTimeout: 10000,
        readTimeout: 20000
      }).then(function (res) {
        if (res.status >= 400) throw new Error('HTTP ' + res.status);
        var d = res.data;
        if (typeof d === 'string') {
          try { return JSON.parse(d); } catch (e) { throw new Error('返回内容不是 JSON'); }
        }
        return d;
      });
    }
    return fetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        try { return JSON.parse(text); } catch (e) { throw new Error('返回内容不是 JSON'); }
      });
  }

  function getText(url) {
    var http = nativeHttp();
    if (http) {
      return http.get({
        url: url,
        headers: { 'Accept': '*/*' },
        responseType: 'TEXT',
        connectTimeout: 10000,
        readTimeout: 20000
      }).then(function (res) {
        if (res.status >= 400) throw new Error('HTTP ' + res.status);
        return typeof res.data === 'string' ? res.data : String(res.data);
      });
    }
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  /* ---------- 存储 ---------- */

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 配额满时忽略 */ }
  }

  function normalizeSource(s) {
    return {
      id: s.id || ('s' + Math.random().toString(36).slice(2, 9)),
      name: String(s.name || '未命名源').trim(),
      api: String(s.api || '').trim(),
      enabled: s.enabled !== false
    };
  }

  function persistSources() { writeStore(LS_SOURCES, state.sources); }

  function loadSources() {
    var saved = readStore(LS_SOURCES, null);
    if (saved && saved.length) {
      state.sources = saved.map(normalizeSource);
      return Promise.resolve();
    }
    return fetch('sources.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.sources = (data.sources || []).map(normalizeSource);
        persistSources();
      })
      .catch(function () { state.sources = []; });
  }

  /* ---------- 提示 ---------- */

  var toastTimer = null;
  function toast(msg, ms) {
    var t = el('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  /* ---------- 视图 ---------- */

  function show(view) {
    if (state.view === 'player' && view !== 'player') {
      state.liveMode = false;
      var v = el('video');
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    state.view = view;
    ['home', 'detail', 'player', 'sources', 'live'].forEach(function (name) {
      el('view-' + name).hidden = (name !== view);
    });
    el('btn-back').hidden = (view === 'home');
    el('btn-live').hidden = (view === 'live');
    el('btn-settings').textContent = (view === 'sources') ? '完成' : '源';
    el('topbar-title').textContent = {
      home: 'LibreTV', detail: '详情', player: '播放', sources: '播放源', live: '直播'
    }[view];
    window.scrollTo(0, 0);
  }

  function goHome() {
    show('home');
    renderChips();
    renderHistory();
    renderLatest();
  }

  /* ---------- 搜索 ---------- */

  function enabledSources() {
    return state.sources.filter(function (s) { return s.enabled && s.api; });
  }

  function sourceUrl(api, keyword) {
    return api.replace(/\/+$/, '') + '/?ac=videolist&wd=' + encodeURIComponent(keyword) + '&pg=1';
  }

  function mapItem(src, it) {
    return {
      sourceId: src.id,
      sourceName: src.name,
      id: String(it.vod_id == null ? '' : it.vod_id),
      name: String(it.vod_name || '').trim(),
      pic: it.vod_pic || '',
      remarks: it.vod_remarks || '',
      year: it.vod_year || '',
      area: it.vod_area || '',
      type: it.vod_type_name || it.vod_class || '',
      time: String(it.vod_time || ''),
      raw: it
    };
  }

  function searchOne(src, keyword) {
    return getJson(sourceUrl(src.api, keyword)).then(function (data) {
      var list = (data && (data.list || data.data)) || [];
      if (!Array.isArray(list)) return [];
      return list.map(function (it) {
        return mapItem(src, it);
      }).filter(function (x) { return x.name; });
    });
  }

  function runSearch(keyword) {
    var pool = enabledSources();
    if (!pool.length) {
      toast('还没有可用的源');
      renderSources();
      show('sources');
      return;
    }
    var targets = state.activeSource === 'all'
      ? pool
      : pool.filter(function (s) { return s.id === state.activeSource; });

    el('results').innerHTML = '';
    el('home-hint').hidden = false;
    el('home-hint').textContent = '正在 ' + targets.length + ' 个源中搜索「' + keyword + '」…';

    Promise.all(targets.map(function (src) {
      return searchOne(src, keyword).then(
        function (items) { return { ok: true, items: items }; },
        function (err) { return { ok: false, error: err }; }
      );
    })).then(function (report) {
      var failed = report.filter(function (r) { return !r.ok; }).length;
      var merged = [];
      report.forEach(function (r) { if (r.ok) merged = merged.concat(r.items); });

      state.results = merged;
      renderResults(merged);

      if (!merged.length) {
        el('home-hint').textContent = failed
          ? '没有结果，其中 ' + failed + ' 个源请求失败'
          : '没有找到相关影片，换个关键词试试';
      } else {
        el('home-hint').textContent = '共 ' + merged.length + ' 条结果'
          + (failed ? '，' + failed + ' 个源请求失败' : '');
      }
    });
  }

  var BLANK_POSTER = 'data:image/svg+xml;charset=utf-8,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#1b2430"/></svg>');

  function renderResults(items) {
    var box = el('results');
    box.innerHTML = '';
    items.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'card';

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.name;
      img.src = item.pic || BLANK_POSTER;
      img.addEventListener('error', function () { img.src = BLANK_POSTER; });

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;

      card.appendChild(img);
      card.appendChild(name);

      if (item.remarks) {
        var b = document.createElement('div');
        b.className = 'badge';
        b.textContent = item.remarks;
        card.appendChild(b);
      }

      card.addEventListener('click', function () { openDetail(item); });
      box.appendChild(card);
    });
  }

  /* ---------- 最近上新（电视剧） ---------- */

  function isTvType(t) {
    return /剧/.test(String(t || ''));
  }

  function latestUrl(api) {
    return api.replace(/\/+$/, '') + '/?ac=videolist&pg=1';
  }

  function fetchLatest() {
    var pool = enabledSources();
    if (!pool.length) { el('latest-section').hidden = true; return; }
    Promise.all(pool.map(function (src) {
      return getJson(latestUrl(src.api)).then(
        function (data) {
          var list = (data && (data.list || data.data)) || [];
          if (!Array.isArray(list)) return [];
          return list.map(function (it) { return mapItem(src, it); })
            .filter(function (x) { return x.name && isTvType(x.type); });
        },
        function () { return []; }
      );
    })).then(function (batches) {
      var seen = {};
      var merged = [];
      batches.forEach(function (items) {
        items.forEach(function (x) {
          if (seen[x.name]) return;
          seen[x.name] = 1;
          merged.push(x);
        });
      });
      state.latest = merged.slice(0, 24);
      renderLatest();
    });
  }

  function renderLatest() {
    var sec = el('latest-section');
    var box = el('latest');
    if (!state.latest || !state.latest.length) { sec.hidden = true; return; }
    sec.hidden = false;
    box.innerHTML = '';
    state.latest.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'l-card';

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.name;
      img.src = item.pic || BLANK_POSTER;
      img.addEventListener('error', function () { img.src = BLANK_POSTER; });

      var name = document.createElement('div');
      name.className = 'l-name';
      name.textContent = item.name;

      var sub = document.createElement('div');
      sub.className = 'l-sub';
      sub.textContent = [item.remarks, item.sourceName].filter(Boolean).join(' · ');

      card.appendChild(img);
      card.appendChild(name);
      card.appendChild(sub);
      if (item.remarks) {
        var b = document.createElement('div');
        b.className = 'badge';
        b.textContent = item.remarks;
        card.appendChild(b);
      }

      card.addEventListener('click', function () { openLatest(item); });
      box.appendChild(card);
    });
  }

  function openLatest(item) {
    var src = null;
    state.sources.forEach(function (s) { if (s.id === item.sourceId) src = s; });
    if (!src || !item.id) { openDetail(item); return; }
    toast('正在获取剧集详情…', 1200);
    getJson(src.api.replace(/\/+$/, '') + '/?ac=detail&ids=' + encodeURIComponent(item.id))
      .then(function (data) {
        var list = (data && (data.list || data.data)) || [];
        var d = Array.isArray(list) ? list[0] : null;
        openDetail(d && d.vod_id != null ? mapItem(src, d) : item);
      })
      .catch(function () { openDetail(item); });
  }

  /* ---------- 详情 ---------- */

  function parseGroups(raw) {
    var froms = String(raw.vod_play_from || '').split('$$$');
    var blocks = String(raw.vod_play_url || '').split('$$$');
    var groups = [];

    blocks.forEach(function (block, i) {
      if (!block) return;
      var eps = block.split('#').filter(Boolean).map(function (seg) {
        var cut = seg.indexOf('$');
        var label = cut < 0 ? '播放' : seg.slice(0, cut);
        var url = cut < 0 ? seg : seg.slice(cut + 1);
        return { name: label.trim() || '播放', url: url.trim() };
      }).filter(function (e) { return /^https?:\/\//i.test(e.url); });

      if (eps.length) {
        groups.push({ from: (froms[i] || ('线路 ' + (i + 1))).trim(), episodes: eps });
      }
    });

    return groups;
  }

  function openDetail(item) {
    state.detail = item;
    state.groups = parseGroups(item.raw || {});
    state.groupIndex = 0;

    el('d-title').textContent = item.name;
    el('d-poster').src = item.pic || BLANK_POSTER;

    var meta = [item.year, item.area, item.type].filter(Boolean).join(' · ');
    el('d-sub').textContent = meta || '暂无信息';
    el('d-from').textContent = '来自 ' + item.sourceName;

    show('detail');

    if (!state.groups.length) {
      el('d-tabs').innerHTML = '';
      el('d-episodes').innerHTML = '';
      el('d-note').hidden = false;
      el('d-note').textContent = '这个条目没有可直接播放的地址。部分源需要先请求详情接口，换一个源通常能解决。';
      return;
    }
    el('d-note').hidden = true;
    renderDetailGroups();
  }

  function renderDetailGroups() {
    var tabs = el('d-tabs');
    tabs.innerHTML = '';
    if (state.groups.length > 1) {
      state.groups.forEach(function (g, i) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (i === state.groupIndex ? ' on' : '');
        chip.textContent = g.from;
        chip.addEventListener('click', function () {
          state.groupIndex = i;
          renderDetailGroups();
        });
        tabs.appendChild(chip);
      });
    }

    var box = el('d-episodes');
    box.innerHTML = '';
    state.groups[state.groupIndex].episodes.forEach(function (ep) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ep';
      b.textContent = ep.name;
      b.addEventListener('click', function () { playEpisode(ep); });
      box.appendChild(b);
    });
  }

  /* ---------- 播放 ---------- */

  function progressMap() { return readStore(LS_PROGRESS, {}); }

  function saveProgress(url, time) {
    if (!url || !time || time < 5) return;
    var map = progressMap();
    map[url] = Math.floor(time);
    writeStore(LS_PROGRESS, map);
  }

  /* ---------- 观看记录（继续观看） ---------- */

  function historyList() {
    var list = readStore(LS_HISTORY, []);
    return Array.isArray(list) ? list : [];
  }

  function upsertHistory(rec) {
    if (!rec || !rec.url) return;
    var list = historyList().filter(function (r) { return r.url !== rec.url; });
    list.unshift(rec);
    if (list.length > 30) list = list.slice(0, 30);
    writeStore(LS_HISTORY, list);
    renderHistory();
  }

  function recordFor(ep, time, duration) {
    var d = state.detail || {};
    var group = state.groups[state.groupIndex] || {};
    return {
      url: ep.url,
      title: d.name || ep.name,
      ep: ep.name,
      from: group.from || '',
      pic: d.pic || '',
      time: Math.floor(time || 0),
      duration: Math.floor(duration || 0),
      updated: Date.now()
    };
  }

  function renderHistory() {
    var box = el('history');
    var sec = el('history-section');
    if (!box || !sec) return;
    var list = historyList();
    if (!list.length) { sec.hidden = true; box.innerHTML = ''; return; }
    sec.hidden = false;
    box.innerHTML = '';
    list.slice(0, 12).forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'h-item';

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = r.title;
      img.src = r.pic || BLANK_POSTER;
      img.addEventListener('error', function () { img.src = BLANK_POSTER; });

      var info = document.createElement('div');
      info.className = 'h-info';

      var t = document.createElement('div');
      t.className = 'h-title';
      t.textContent = r.title;

      var e = document.createElement('div');
      e.className = 'h-ep';
      var pct = (r.duration > 0 && r.time > 0)
        ? Math.min(100, Math.round(r.time / r.duration * 100))
        : 0;
      e.textContent = r.ep + (r.from ? ' · ' + r.from : '')
        + (pct > 0 ? ' · 看到第' + pct + '%' : '');

      var track = document.createElement('div');
      track.className = 'h-track';
      var fill = document.createElement('div');
      fill.className = 'h-fill';
      fill.style.width = pct + '%';
      track.appendChild(fill);

      info.appendChild(t);
      info.appendChild(e);
      info.appendChild(track);
      item.appendChild(img);
      item.appendChild(info);

      item.addEventListener('click', function () { resumeRecord(r); });
      box.appendChild(item);
    });
  }

  function resumeRecord(r) {
    state.detail = { name: r.title, pic: r.pic, sourceName: '', raw: {} };
    state.groups = [{
      from: r.from || '继续观看',
      episodes: [{ name: r.ep || '播放', url: r.url }]
    }];
    state.groupIndex = 0;
    playEpisode(state.groups[0].episodes[0]);
  }

  function clearHistory() {
    writeStore(LS_HISTORY, []);
    writeStore(LS_PROGRESS, {});
    renderHistory();
    toast('观看记录已清空');
  }

  function playEpisode(ep) {
    var group = state.groups[state.groupIndex];
    state.episode = ep;

    var v = el('video');
    el('p-title').textContent = state.detail ? (state.detail.name + ' · ' + ep.name) : ep.name;
    el('p-status').textContent = '线路：' + (group ? group.from : '默认');

    show('player');
    v.src = ep.url;
    v.load();

    var saved = progressMap()[ep.url];
    var onMeta = function () {
      v.removeEventListener('loadedmetadata', onMeta);
      if (saved && saved > 5 && (!isFinite(v.duration) || saved < v.duration - 10)) {
        v.currentTime = saved;
        toast('已从上次位置继续播放', 1600);
      }
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* 需要用户手势，忽略 */ });
    };
    v.addEventListener('loadedmetadata', onMeta);

    upsertHistory(recordFor(ep, saved || 0, 0));
    renderPlayerEpisodes();
  }

  function renderPlayerEpisodes() {
    var box = el('p-episodes');
    box.innerHTML = '';
    var group = state.groups[state.groupIndex];
    if (!group) return;
    group.episodes.forEach(function (ep) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ep' + (state.episode && state.episode.url === ep.url ? ' on' : '');
      b.textContent = ep.name;
      b.addEventListener('click', function () { playEpisode(ep); });
      box.appendChild(b);
    });
  }

  /* ---------- 源管理 ---------- */

  function renderSources() {
    var box = el('source-list');
    box.innerHTML = '';

    if (!state.sources.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有任何源。在下面填名称和接口地址即可添加。';
      box.appendChild(empty);
    }

    state.sources.forEach(function (src) {
      var row = document.createElement('div');
      row.className = 'source-item';

      var info = document.createElement('div');
      info.className = 'info';
      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = src.name;
      var a = document.createElement('div');
      a.className = 'a';
      a.textContent = src.api;
      info.appendChild(n);
      info.appendChild(a);

      var sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'switch' + (src.enabled ? ' on' : '');
      sw.setAttribute('aria-label', '启用或停用');
      sw.addEventListener('click', function () {
        src.enabled = !src.enabled;
        persistSources();
        renderSources();
        renderChips();
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        state.sources = state.sources.filter(function (s) { return s.id !== src.id; });
        if (state.activeSource === src.id) state.activeSource = 'all';
        persistSources();
        renderSources();
        renderChips();
      });

      row.appendChild(info);
      row.appendChild(sw);
      row.appendChild(del);
      box.appendChild(row);
    });

    el('env-info').textContent = nativeHttp()
      ? '原生网络已接管：请求不受跨域限制，可直接访问第三方接口。'
      : '当前为浏览器模式（无原生网络），跨域接口可能请求失败。';
  }

  function renderChips() {
    var box = el('chips');
    box.innerHTML = '';
    var pool = enabledSources();
    if (pool.length < 2) { box.hidden = true; return; }
    box.hidden = false;

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.activeSource === 'all' ? ' on' : '');
    all.textContent = '全部源';
    all.addEventListener('click', function () {
      state.activeSource = 'all';
      renderChips();
    });
    box.appendChild(all);

    pool.forEach(function (src) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (state.activeSource === src.id ? ' on' : '');
      chip.textContent = src.name;
      chip.addEventListener('click', function () {
        state.activeSource = src.id;
        renderChips();
      });
      box.appendChild(chip);
    });
  }

  /* ---------- 直播 ---------- */

  function parseM3U(text) {
    var lines = String(text).split(/\r?\n/);
    var out = [];
    var pending = null;
    lines.forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (/^#EXTINF/i.test(line)) {
        var name = line.split(',').pop().trim();
        var g = (line.match(/group-title="([^"]*)"/i) || [])[1] || '';
        pending = { name: name || '未命名频道', group: g.trim() || '其他', url: '' };
      } else if (line.charAt(0) !== '#') {
        if (pending && /^https?:\/\//i.test(line)) {
          pending.url = line;
          out.push(pending);
        }
        pending = null;
      }
    });
    return out.filter(function (c) { return c.url; });
  }

  function loadLive(url, useCache) {
    var status = el('live-status');
    if (!useCache) {
      status.textContent = '正在加载频道列表…';
      writeStore(LS_LIVE_URL, url);
    }
    var done = function (text) {
      if (!useCache) {
        try { localStorage.setItem(LS_LIVE_M3U, String(text)); } catch (e) { /* 忽略 */ }
      }
      state.liveChannels = parseM3U(text);
      state.liveGroup = '';
      el('live-url').value = url;
      if (!state.liveChannels.length) {
        status.textContent = '这个列表里没有解析到频道。确认地址指向 m3u/m3u8 播放列表。';
      } else {
        status.textContent = '已解析 ' + state.liveChannels.length + ' 个频道';
      }
      renderLive();
    };
    if (useCache) {
      var cached = '';
      try { cached = localStorage.getItem(LS_LIVE_M3U) || ''; } catch (e) { cached = ''; }
      if (cached) { done(cached); return; }
    }
    getText(url).then(done, function (err) {
      status.textContent = '加载失败：' + (err && err.message ? err.message : '网络错误')
        + '。直播源不稳定是常态，可以换一个列表地址。';
      renderLive();
    });
  }

  function renderLive() {
    var box = el('live-list');
    box.innerHTML = '';
    var chips = el('live-groups');
    chips.innerHTML = '';

    var groups = {};
    state.liveChannels.forEach(function (c) {
      (groups[c.group] = groups[c.group] || []).push(c);
    });
    var names = Object.keys(groups).sort();
    if (names.length > 1) {
      names.forEach(function (n) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (state.liveGroup === n ? ' on' : '');
        chip.textContent = n;
        chip.addEventListener('click', function () {
          state.liveGroup = (state.liveGroup === n) ? '' : n;
          renderLive();
        });
        chips.appendChild(chip);
      });
    }

    var pool = state.liveGroup
      ? (groups[state.liveGroup] || [])
      : state.liveChannels;
    pool.forEach(function (c) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'live-item';
      item.textContent = c.name;
      item.addEventListener('click', function () { playLive(c); });
      box.appendChild(item);
    });
  }

  function playLive(ch) {
    state.liveMode = true;
    state.detail = { name: ch.name, pic: '', sourceName: '' };
    state.episode = { name: ch.name, url: ch.url };
    state.groups = [];
    state.groupIndex = 0;

    var v = el('video');
    el('p-title').textContent = ch.name;
    el('p-status').textContent = '直播频道，不支持进度记忆';
    el('p-episodes').innerHTML = '';

    show('player');
    v.src = ch.url;
    v.load();
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* 等待用户手势 */ });
  }

  /* ---------- 自动更新 ---------- */

  function isNewerTag(tag, current) {
    var a = String(tag).replace(/^v/i, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var b = String(current).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function openExternal(url) {
    var cap = window.Capacitor;
    var browser = cap && cap.Plugins && cap.Plugins.Browser;
    if (browser && typeof browser.open === 'function') {
      browser.open({ url: url });
      return;
    }
    try { window.open(url, '_blank'); } catch (e) { /* 环境不支持 */ }
  }

  function checkUpdate() {
    getJson('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest')
      .then(function (rel) {
        var tag = String(rel.tag_name || '').trim();
        if (!tag || !isNewerTag(tag, APP_VERSION)) return;
        var banner = el('update-banner');
        banner.textContent = '发现新版本 ' + tag
          + '（当前 v' + APP_VERSION + '），点此获取新安装包';
        banner.hidden = false;
        banner.onclick = function () { openExternal(rel.html_url); };
      })
      .catch(function () { /* 静默失败：离线或接口不可达 */ });
  }

  /* ---------- 事件 ---------- */

  function bind() {
    el('search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var kw = el('q').value.trim();
      if (!kw) { toast('先输入关键词'); return; }
      if (state.view !== 'home') show('home');
      el('history-section').hidden = true;
      el('latest-section').hidden = true;
      runSearch(kw);
    });

    el('btn-fullscreen').addEventListener('click', function () {
      var v2 = el('video');
      if (typeof v2.webkitEnterFullscreen === 'function') {
        v2.webkitEnterFullscreen();
        return;
      }
      if (v2.requestFullscreen) { v2.requestFullscreen(); return; }
      if (v2.webkitRequestFullscreen) { v2.webkitRequestFullscreen(); return; }
      toast('当前环境不支持全屏');
    });

    el('btn-clear-history').addEventListener('click', clearHistory);

    el('btn-refresh-latest').addEventListener('click', function () {
      toast('正在刷新上新列表…', 1400);
      fetchLatest();
    });

    el('btn-live').addEventListener('click', function () {
      el('live-url').value = readStore(LS_LIVE_URL, '') || DEFAULT_LIVE_URL;
      loadLive(readStore(LS_LIVE_URL, '') || DEFAULT_LIVE_URL, true);
      show('live');
    });

    el('live-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var url = el('live-url').value.trim();
      if (!/^https?:\/\//i.test(url)) { toast('直播列表地址要以 http:// 或 https:// 开头'); return; }
      loadLive(url, false);
    });

    el('btn-settings').addEventListener('click', function () {
      if (state.view === 'sources') {
        goHome();
      } else {
        renderSources();
        show('sources');
      }
    });

    el('btn-back').addEventListener('click', function () {
      if (state.view === 'player') {
        if (state.liveMode) { show('live'); return; }
        show('detail');
        return;
      }
      if (state.view === 'detail') { goHome(); return; }
      goHome();
    });

    el('source-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el('s-name').value.trim();
      var api = el('s-api').value.trim();
      if (!name || !api) { toast('名称和接口地址都要填'); return; }
      if (!/^https?:\/\//i.test(api)) { toast('接口地址要以 http:// 或 https:// 开头'); return; }
      state.sources.push(normalizeSource({ name: name, api: api }));
      persistSources();
      el('s-name').value = '';
      el('s-api').value = '';
      renderSources();
      renderChips();
      toast('已添加');
    });

    el('btn-import').addEventListener('click', function () {
      var text = el('s-json').value.trim();
      if (!text) { toast('先把 JSON 粘贴到框里'); return; }
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { toast('JSON 格式有误'); return; }
      if (!Array.isArray(parsed)) { toast('需要一个数组'); return; }
      var added = 0;
      parsed.forEach(function (item) {
        if (!item || !item.name || !item.api) return;
        state.sources.push(normalizeSource(item));
        added += 1;
      });
      persistSources();
      el('s-json').value = '';
      renderSources();
      renderChips();
      toast('导入 ' + added + ' 个源');
    });

    el('btn-export').addEventListener('click', function () {
      var list = state.sources.map(function (s) {
        return { name: s.name, api: s.api, enabled: s.enabled };
      });
      el('s-json').value = JSON.stringify(list, null, 2);
      toast('已导出到上方文本框，可长按复制');
    });

    var v = el('video');
    var lastSave = 0;
    v.addEventListener('timeupdate', function () {
      if (state.liveMode) return;
      var now = Date.now();
      if (now - lastSave < 5000) return;
      lastSave = now;
      if (state.episode && v.currentTime > 0) {
        saveProgress(state.episode.url, v.currentTime);
        upsertHistory(recordFor(
          state.episode,
          v.currentTime,
          isFinite(v.duration) ? v.duration : 0
        ));
      }
    });
    v.addEventListener('webkitpresentationmodechanged', function () {
      var mode = v.webkitPresentationMode || '';
      el('btn-fullscreen').textContent =
        mode === 'fullscreen' ? '⛶ 退出全屏' : '⛶ 横屏';
    });
    v.addEventListener('error', function () {
      el('p-status').textContent = '这条线路播放失败，可能是防盗链或链接已失效，换一条线路试试。';
    });
    v.addEventListener('ended', function () {
      if (state.liveMode) return;
      if (state.episode) saveProgress(state.episode.url, 0);
    });
  }

  /* ---------- 启动 ---------- */

  function boot() {
    bind();
    loadSources().then(function () {
      renderChips();
      renderSources();
      renderHistory();
      show('home');
      fetchLatest();
      checkUpdate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* 短剧放映厅 · 前端逻辑 */
(() => {
  'use strict';

  const CFG = window.MR_CONFIG || {};
  const API = (CFG.API_BASE || '').replace(/\/+$/, '');
  let KEY = CFG.API_KEY || '';
  let SHARE = CFG.SHARECODE || '';
  const QUALITIES = ['1080p', '720p', '540p', '360p'];
  const Q_LABEL = { '1080p': '1080P 超清', '720p': '720P 高清', '540p': '540P 标清', '360p': '360P 兼容' };
  // 解码失败时逐档下降（1080p→720p→540p→360p），而不是一步跳到 360P：
  // 有些设备只是解不了最高档，降到 720p 还能看高清。
  function lowerQuality(q) {
    const i = QUALITIES.indexOf(q);
    return i < 0 ? '360p' : QUALITIES[Math.min(i + 1, QUALITIES.length - 1)];
  }
  // 高清档位是 HEVC(H.265)，浏览器是否支持取决于系统解码器
  const HEVC_OK = (() => {
    try {
      const v = document.createElement('video');
      return !!(v.canPlayType && (v.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"')
        || v.canPlayType('video/mp4; codecs="hev1.1.6.L120.90"')));
    } catch (e) { return false; }
  })();

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  /* 记录存储：本机 / 账号两套，各用独立前缀，互不覆盖。
     目前只用本机；将来接登录（或 WebDAV 同步）时把 scope 切到 'account'，
     两套记录并存——切账号不会清掉本机数据，反过来也不会。 */
  const records = {
    scope: 'local',
    prefix() { return this.scope === 'account' ? 'acc.' : 'mr.'; },
    get(name, d) { return store.get(this.prefix() + name, d); },
    set(name, v) { store.set(this.prefix() + name, v); },
    history() { return this.get('history', {}); },
    setHistory(v) { this.set('history', v); },
    favs() { return this.get('fav', {}); },
    setFavs(v) { this.set('fav', v); }
  };
  const fmtCount = (n) => {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return String(n);
  };
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  };
  /* 剧名/封面来自上游，插进 innerHTML 前要转义，否则剧名带引号会破坏整行 DOM */
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------------- 网络 ---------------- */
  /* 从后端拉当前密钥：后端轮换后这里会自动跟上，不用手改 config.js */
  let configFetchedAt = 0;
  async function refreshClientConfig(force) {
    const now = Date.now();
    if (!force && now - configFetchedAt < 60 * 1000) return false;
    try {
      const r = await fetch(`${API}/client-config`, { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      let changed = false;
      if (j.api_key && j.api_key !== KEY) { KEY = j.api_key; changed = true; }
      if (typeof j.sharecode === 'string' && j.sharecode !== SHARE) { SHARE = j.sharecode; changed = true; }
      configFetchedAt = now;
      return changed;
    } catch (e) {
      return false;
    }
  }

  async function api(path, params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
    qs.set('api_key', KEY);
    if (SHARE) qs.set('sharecode', SHARE);
    const url = `${API}${path}?${qs.toString()}`;
    let res = await fetch(url);
    if (res.status === 401) {
      // 密钥被轮换过：拉一次最新密钥再重试
      if (await refreshClientConfig(true)) {
        qs.set('api_key', KEY);
        if (SHARE) qs.set('sharecode', SHARE);
        res = await fetch(`${API}${path}?${qs.toString()}`);
      }
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('接口返回异常'); }
    if (!res.ok) throw new Error(data.detail || `请求失败 ${res.status}`);
    return data;
  }
  const streamUrl = (vid, quality) =>
    `${API}/stream?vid=${encodeURIComponent(vid)}&quality=${encodeURIComponent(quality)}&api_key=${encodeURIComponent(KEY)}`
    + (SHARE ? `&sharecode=${encodeURIComponent(SHARE)}` : '');

  /* ---------------- 卡片 ---------------- */
  function normalize(item) {
    return {
      id: String(item.series_id || item.seriesId || item.id || ''),
      title: item.title || item.series_name || '未命名',
      cover: item.cover || item.series_cover || '',
      eps: Number(item.episode_cnt || item.episodeCount || 0),
      score: item.score || '',
      play: item.play_cnt || item.views || 0,
      tags: item.tags || item.category || [],
      intro: item.abstract || item.intro || item.description || '',
      rank: item.rank || 0
    };
  }

  function card(item) {
    const d = normalize(item);
    const node = el('div', 'card');
    const tags = Array.isArray(d.tags) ? d.tags : [];
    const sub = [d.eps ? `全 ${d.eps} 集` : '', tags.slice(0, 2).join(' / '), d.score ? `评分 ${d.score}` : ''].filter(Boolean).join(' · ');
    node.innerHTML = `
      <div class="thumb">
        ${d.cover ? `<img loading="lazy" src="${d.cover}" alt="">` : ''}
        ${d.rank ? `<span class="badge rank">TOP ${d.rank}</span>` : (d.score ? `<span class="badge">${d.score} 分</span>` : '')}
        ${d.eps ? `<span class="ep-tag">${d.eps} 集</span>` : ''}
      </div>
      <div class="name">${d.title}</div>
      <div class="sub">${sub}</div>`;
    node.addEventListener('click', () => openDetail(d.id, d));
    return node;
  }

  /* ---------------- 首页 ---------------- */
  const home = { view: 'hot', page: 0, loading: false, done: false, items: [] };
  const grid = $('grid'), status = $('status'), sentinel = $('sentinel');

  function skeleton(n = 6) {
    grid.innerHTML = '';
    for (let i = 0; i < n; i++) grid.appendChild(el('div', 'skeleton'));
  }

  let homeGen = 0;
  function resetHome(view) {
    // 每次切视图都换一代，丢弃上一代还在飞行的请求结果，
    // 否则重复 reset 会让第二次请求又从 offset=0 开始，拿回重复数据后误判「到底了」
    homeGen += 1;
    home.started = true;
    home.view = view; home.page = 0; home.loading = false; home.done = false; home.items = [];
    grid.innerHTML = ''; status.textContent = '';
    if (view === 'mine') return renderMine();
    skeleton();
    loadHome();
  }

  async function loadHome() {
    if (!home.started || home.loading || home.done) return;
    const gen = homeGen;
    home.loading = true;
    status.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>';
    try {
      let items = [];
      let more = false;
      if (home.view === 'hot') {
        // 榜单也走 offset 翻页：offset=0 时上游不返回 has_more，用「是否满 30 条」判断
        const r = await api('/rank', { board: 'hot', limit: 30, offset: home.page * 30 });
        items = r.items || [];
        more = home.page === 0 ? items.length >= 30 : !!r.has_more;
      } else {
        const r = await api('/catalog', { channel: home.view, page: home.page + 1 });
        items = r.items || [];
        more = !!r.has_more;
      }

      if (gen !== homeGen) return;   // 期间切换了视图，这批数据作废
      if (home.page === 0) grid.innerHTML = '';
      const seen = new Set(home.items.map((x) => x.id));
      let added = 0;
      items.forEach((it) => {
        const d = normalize(it);
        if (d.id && seen.has(d.id)) return;   // 跨页去重
        if (d.id) seen.add(d.id);
        home.items.push(d);
        grid.appendChild(card(it));
        added += 1;
      });

      home.page += 1;
      if (added === 0 || !more || home.items.length >= 600) home.done = true;
      status.textContent = home.items.length === 0
        ? '暂无内容'
        : (home.done ? `— 共 ${home.items.length} 部，已经到底了 —` : '');
    } catch (e) {
      if (gen === homeGen) {
        status.textContent = e.message || '加载失败';
        home.done = true;
      }
    } finally {
      if (gen === homeGen) home.loading = false;
    }
    maybeFill();
  }

  /* 首屏没填满视口时继续拉，避免「一屏只有 30 个」的错觉 */
  function maybeFill() {
    if (home.done || home.view === 'mine') return;
    // 正在加载就等它结束再判断，否则这次机会被吞掉，页面会停在 24 条
    if (home.loading) { setTimeout(maybeFill, 300); return; }
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 1200) {
      setTimeout(() => { if (!home.done && !home.loading) loadHome(); }, 150);
    }
  }

  /* 记录「这部剧看过哪些分集」，删缓存时才知道要删哪些文件 */
  function rememberVid(seriesId, vid) {
    if (!seriesId || !vid) return;
    const map = store.get('mr.vids', {});
    const arr = map[seriesId] || [];
    if (!arr.includes(vid)) {
      arr.push(vid);
      map[seriesId] = arr.slice(-300);
      store.set('mr.vids', map);
    }
  }

  /* 删本地记录时同步删后端解密缓存。
     传 series_id 让后端补全该剧全部分集：前端只记得看过的那几集，
     预热提前落盘的下一集缓存不在这里，只按 vid 删会漏。 */
  async function purgeCache(seriesId, extraVid) {
    if (!seriesId) return null;
    const map = store.get('mr.vids', {});
    const vids = new Set(map[seriesId] || []);
    if (extraVid) vids.add(extraVid);
    const qs = new URLSearchParams({ series_id: seriesId, api_key: KEY });
    if (vids.size) qs.set('vid', Array.from(vids).join(','));
    if (SHARE) qs.set('sharecode', SHARE);
    try {
      const r = await fetch(`${API}/cache/delete?${qs.toString()}`);
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 我的 ---------------- */
  function renderMine() {
    const hist = records.history();
    const fav = records.favs();
    const resv = reservations();
    const rows = Object.values(hist).sort((a, b) => b.ts - a.ts).slice(0, 12);
    const favs = Object.values(fav).sort((a, b) => b.ts - a.ts).slice(0, 12);
    const resvs = Object.keys(resv).map((sid) => Object.assign({ id: sid }, resv[sid]))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    grid.innerHTML = '';
    status.textContent = '';
    const wrap = el('div', 'mine');
    wrap.style.gridColumn = '1 / -1';
    wrap.innerHTML = `
      <div class="mine-tools">
        <button class="text-btn light" id="clearCacheBtn" title="清空全部观看记录，并清理已缓存的视频">清空历史记录</button>
      </div>
      <h2>我的预约${resvs.length ? ' <span class="mine-count">' + resvs.length + '</span>' : ''}</h2>
      <div class="mini-list" id="reserveList">${resvs.length ? '' : '<div class="empty">还没有预约。在剧集详情页点「预约下一季」，下一季上线时首页会提醒你</div>'}</div>
      <h2>继续观看</h2>
      <div class="mini-list" id="historyList">${rows.length ? '' : '<div class="empty">还没有观看记录</div>'}</div>
      <h2>我的收藏</h2>
      <div class="mini-list" id="favList">${favs.length ? '' : '<div class="empty">还没有收藏</div>'}</div>`;
    const reserveList = wrap.querySelector('#reserveList');
    const historyList = wrap.querySelector('#historyList');
    const favList = wrap.querySelector('#favList');
    resvs.forEach((r) => reserveList.appendChild(reserveRow(r)));
    rows.forEach((r) => historyList.appendChild(miniRow(r, true)));
    favs.forEach((r) => favList.appendChild(miniRow(r, false)));
    grid.appendChild(wrap);
    const cc = $('clearCacheBtn');
    if (cc) {
      cc.addEventListener('click', async () => {
        // 清空历史记录：观看记录与 vid 索引清掉，收藏不动；
        // 后端缓存沿用原来的全清能力（缓存可随时重新生成）。
        const removed = Object.keys(records.history()).length;
        records.setHistory({});
        store.set('mr.vids', {});
        renderMine();
        const head = removed > 0 ? `已清空 ${removed} 条记录` : '记录已清空';
        const qs = new URLSearchParams({ all: '1', api_key: KEY });
        if (SHARE) qs.set('sharecode', SHARE);
        try {
          const r = await fetch(`${API}/cache/delete?${qs.toString()}`);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json().catch(() => null);
          // 缓存删不掉时如实说，别提示「已清空」骗人（文件被占用时很常见）
          const failed = (j && j.failed) || 0;
          const mb = (j && j.freed_mb) || 0;
          if (failed > 0) toast(`${head}；${failed} 个缓存文件删不掉（正被占用），稍后自动清理`);
          else if (mb > 0) toast(`${head}，释放 ${mb}MB 缓存`);
          else toast(head);
        } catch (e) {
          toast('记录已清空；缓存清理请求失败，可稍后重试');
        }
      });
    }
  }

  function miniRow(r, withProgress) {
    const node = el('div', 'mini-row');
    const sub = withProgress
      ? `看到第 ${r.index} 集${r.eps ? ' · 共 ' + r.eps + ' 集' : ''}`
      : `共 ${r.eps || '?'} 集`;
    // 用文字按钮，不说「解密缓存」这种技术黑话：历史叫「删除」，收藏叫「取消收藏」
    const delText = withProgress ? '删除' : '取消收藏';
    const delTitle = withProgress ? '删除这条观看记录' : '取消收藏';
    node.innerHTML = `
      <img loading="lazy" src="${esc(r.cover)}" alt="">
      <div class="info">
        <div class="t">${esc(r.title)}</div>
        <div class="s">${sub}</div>
      </div>
      <div class="go">${withProgress ? '继续' : '播放'}</div>
      <button class="row-del" aria-label="${delTitle}" title="${delTitle}">${delText}</button>`;

    node.addEventListener('click', async (ev) => {
      if (ev.target.closest('.row-del')) {
        ev.stopPropagation();
        // 不用 window.confirm：嵌入式预览里弹窗会被拦下，点了像没反应。
        const box = withProgress ? records.history() : records.favs();
        delete box[r.id];
        if (withProgress) records.setHistory(box); else records.setFavs(box);
        node.style.opacity = '.4';
        // 删记录时同步清掉这部剧已缓存的分集（先取 vid 列表，再清索引）
        await purgeCache(r.id, r.vid);
        const vm = store.get('mr.vids', {});
        if (vm[r.id]) { delete vm[r.id]; store.set('mr.vids', vm); }
        if (!withProgress) syncFavBtn();   // 详情页开着同一部剧时同步收藏按钮
        toast(withProgress ? '已删除记录' : '已取消收藏');
        renderMine();
        return;
      }
      openDetail(r.id, r);
    });
    return node;
  }

  /** 「我的预约」列表里的一行：点进详情，可取消预约。 */
  function reserveRow(r) {
    const node = el('div', 'mini-row reserve-row');
    const kind = r.kind || '季';
    const cover = r.cover
      ? `<img loading="lazy" src="${esc(r.cover)}" alt="">`
      : `<div class="cover-ph">📅</div>`;
    node.innerHTML = `${cover}
      <div class="info">
        <div class="t">${esc(r.title || '未命名')}</div>
        <div class="s">已预约第 ${r.num || 1} ${kind}${r.eps ? ' · 共 ' + r.eps + ' 集' : ''} · 上线时提醒你</div>
      </div>
      <button class="row-del" aria-label="取消预约" title="取消预约">取消预约</button>`;
    node.addEventListener('click', (ev) => {
      if (ev.target.closest('.row-del')) {
        ev.stopPropagation();
        cancelReservation(r.id);
        syncReserveBtn();
        toast('已取消预约');
        renderMine();
        return;
      }
      openDetail(r.id, { id: r.id, title: r.title, cover: r.cover });
    });
    return node;
  }

  /* ---------------- 搜索 ---------------- */
  const searchPage = $('searchPage'), searchGrid = $('searchGrid'), searchStatus = $('searchStatus');
  const HOT_WORDS = ['总裁', '重生', '战神', '穿越', '复仇', '萌宝', '甜宠', '逆袭'];
  const SEARCH_HIST_KEY = 'mr.searches';

  function getSearchHist() {
    const arr = store.get(SEARCH_HIST_KEY, []);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  }
  function pushSearchHist(q) {
    q = String(q || '').trim();
    if (!q) return;
    const arr = getSearchHist().filter((x) => x !== q);
    arr.unshift(q);
    store.set(SEARCH_HIST_KEY, arr.slice(0, 10));
  }

  function renderSearchHist() {
    const box = $('searchHist');
    const hist = getSearchHist();
    box.innerHTML = '';
    if (!hist.length) { box.hidden = true; return; }
    const head = el('div', 'sh-head');
    head.appendChild(el('span', 'sh-title', '搜索历史'));
    const clear = el('button', 'sh-clear', '清空');
    clear.addEventListener('click', () => { store.set(SEARCH_HIST_KEY, []); renderSearchHist(); });
    head.appendChild(clear);
    box.appendChild(head);
    const chips = el('div', 'sh-chips');
    hist.forEach((w) => {
      const b = el('button', 'word', esc(w));
      b.addEventListener('click', () => { $('searchInput').value = w; doSearch(); });
      chips.appendChild(b);
    });
    box.appendChild(chips);
    box.hidden = false;
  }

  /* ---- 实时联想（复用 /search，防抖 + 取消旧请求）---- */
  let suggestTimer = null;
  let suggestSeq = 0;
  let suggestAbort = null;

  function hideSuggest() {
    const box = $('suggestList');
    box.hidden = true;
    box.innerHTML = '';
  }

  function renderSuggest(items, q) {
    const box = $('suggestList');
    box.innerHTML = '';
    if (!items.length) {
      if (q) box.appendChild(el('div', 'sg-empty', '没有找到相关短剧，按回车试试'));
      box.hidden = !q;
      return;
    }
    items.slice(0, 8).forEach((it) => {
      const d = normalize(it);
      if (!d.id) return;
      const row = el('button', 'sg-row');
      row.innerHTML = (d.cover ? `<img src="${esc(d.cover)}" alt="">` : '<span class="sg-ph"></span>')
        + `<span class="sg-info"><span class="sg-name">${esc(d.title)}</span>`
        + `<span class="sg-sub">${d.eps ? '全 ' + d.eps + ' 集' : ''}${(Array.isArray(d.tags) && d.tags.length) ? (d.eps ? ' · ' : '') + esc(d.tags.slice(0, 2).join(' / ')) : ''}</span></span>`
        + '<span class="sg-go">›</span>';
      // 用 mousedown 阻止默认，避免输入框失焦导致点击丢失
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        hideSuggest();
        $('searchInput').value = d.title;
        pushSearchHist(d.title);
        renderSearchHist();
        openDetail(d.id, d);
      });
      box.appendChild(row);
    });
    box.hidden = false;
  }

  async function fetchSuggest(q) {
    const seq = ++suggestSeq;
    if (suggestAbort) { try { suggestAbort.abort(); } catch (e) { /* ignore */ } }
    suggestAbort = new AbortController();
    try {
      const qs = new URLSearchParams({ q, limit: 8, api_key: KEY });
      if (SHARE) qs.set('sharecode', SHARE);
      const res = await fetch(`${API}/search?${qs.toString()}`, { signal: suggestAbort.signal });
      if (seq !== suggestSeq) return;
      const data = await res.json();
      if (seq !== suggestSeq) return;
      renderSuggest(data.results || [], q);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (seq === suggestSeq) renderSuggest([], q);
    }
  }

  function onSearchInput() {
    const q = $('searchInput').value.trim();
    const hasHist = getSearchHist().length > 0;
    $('searchHist').hidden = q !== '' || !hasHist;
    $('hotWords').hidden = q !== '';
    if (suggestTimer) clearTimeout(suggestTimer);
    if (!q) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => fetchSuggest(q), 260);
  }

  function openSearch() {
    searchPage.hidden = false;
    const hw = $('hotWords');
    if (!hw.dataset.init) {
      HOT_WORDS.forEach((w) => {
        const b = el('button', 'word', w);
        b.addEventListener('click', () => { $('searchInput').value = w; doSearch(); });
        hw.appendChild(b);
      });
      hw.dataset.init = '1';
    }
    hideSuggest();
    $('searchInput').value = '';
    renderSearchHist();
    $('hotWords').hidden = false;
    setTimeout(() => $('searchInput').focus(), 120);
  }

  async function doSearch() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    hideSuggest();
    pushSearchHist(q);
    renderSearchHist();
    $('searchHist').hidden = true;
    $('hotWords').hidden = true;
    searchGrid.innerHTML = '';
    searchStatus.innerHTML = '搜索中…';
    try {
      const r = await api('/search', { q, limit: 40 });
      const items = r.results || [];
      searchStatus.textContent = items.length ? `共 ${items.length} 个结果` : '没有找到相关短剧';
      items.forEach((it) => searchGrid.appendChild(card(it)));
    } catch (e) {
      searchStatus.textContent = e.message || '搜索失败';
    }
  }

  /* ---------------- 详情 ---------------- */
  const detailPage = $('detailPage');
  let detail = { seriesId: '', meta: null, episodes: [] };
  let detailNext = null;        // 当前详情页检测到的下一季；null = 没有/未检测
  let detailNextToken = 0;      // 竞态 token：切剧后丢弃旧的异步检测结果

  async function openDetail(seriesId, seed, keepHash) {
    if (!seriesId) return;
    if (!keepHash) history.replaceState(null, '', '#/d/' + seriesId);
    detail = { seriesId, meta: null, episodes: [] };
    detailNext = null;              // 切剧先清掉上一部的下一季状态
    detailNextToken += 1;           // 让上一部未完成的探测结果作废
    detailPage.hidden = false;
    // 详情页自己是 fixed 全屏滚动容器，必须锁住 body，
    // 否则首页那条滚动条会留在最右边，出现两条滑轨（外侧那条还拖不动）
    document.body.style.overflow = 'hidden';
    detailPage.scrollTop = 0;
    $('detailTitle').textContent = seed ? seed.title : '加载中…';
    $('detailCover').src = seed && seed.cover ? seed.cover : '';
    $('heroBg').style.backgroundImage = seed && seed.cover ? `url("${seed.cover}")` : '';
    $('detailChips').innerHTML = '';
    $('detailIntro').textContent = seed ? seed.intro : '';
    $('epGrid').innerHTML = '';
    $('epCount').textContent = '';

    try {
      let r;
      try {
        r = await api('/detail', { series_id: seriesId });
      } catch (err) {
        r = await api('/episodes', { series_id: seriesId });
      }
      const m = r.meta || {};
      detail.meta = m;
      detail.episodes = r.episodes || [];
      const cover = m.cover || (seed && seed.cover) || '';
      $('detailTitle').textContent = m.title || (seed && seed.title) || '';
      $('detailCover').src = cover;
      $('heroBg').style.backgroundImage = cover ? `url("${cover}")` : '';
      const statusText = (m.status && !/^全\s*\d+\s*集$/.test(m.status)) ? m.status : '';
      const chips = [
        m.episode_cnt ? `${m.episode_cnt} 集` : '',
        statusText,
        m.play_cnt ? `${fmtCount(m.play_cnt)} 次播放` : '',
        ...(m.category || []).slice(0, 3)
      ].filter(Boolean);
      $('detailChips').innerHTML = chips.map((c, i) => `<span class="chip${i === 0 ? ' accent' : ''}">${c}</span>`).join('');
      $('detailIntro').textContent = m.abstract || (seed && seed.intro) || '暂无简介';
      $('epCount').textContent = `${detail.episodes.length} 集`;
      renderEpisodes();
      syncFavBtn();
      syncReserveBtn();
      probeDetailNext(seriesId);    // 有下一季就把按钮升级成「看第X季 →」
      // 打开详情页就把「大概率要点的那一集」丢给后端预取（有观看记录则续播那集，
      // 否则第 1 集）：等用户真去点播放时缓存多半已经就绪，首播不用再等解密。
      // 后端有并发去重与缓存，重复进详情页不会重复下载。
      const resumeIdx = (records.history()[detail.seriesId] || {}).index;
      const likely = detail.episodes.find((ep) => ep.index === (resumeIdx || 1))
        || detail.episodes[0];
      if (likely) prewarm(likely.vid, play.quality);
    } catch (e) {
      $('detailIntro').textContent = '加载失败：' + (e.message || '');
    }
  }

  function renderEpisodes() {
    const box = $('epGrid');
    box.innerHTML = '';
    const hist = records.history()[detail.seriesId];
    detail.episodes.forEach((ep) => {
      const b = el('button', 'ep', String(ep.index));
      if (hist && hist.index === ep.index) b.classList.add('playing');
      else if (hist && ep.index < hist.index) b.classList.add('watched');
      b.addEventListener('click', () => playEpisode(ep.index));
      box.appendChild(b);
    });
  }

  function syncFavBtn() {
    const fav = records.favs();
    const on = !!fav[detail.seriesId];
    const btn = $('favBtn');
    btn.textContent = on ? '已收藏' : '收藏';
    btn.classList.toggle('on', on);
  }

  function syncReserveBtn() {
    const btn = $('reserveBtn');
    if (!btn) return;
    // 已经找到下一季：按钮变成「看第X季 →」，不再误导用户去预约一个已存在的季
    if (detailNext) {
      const s = parseSeason(String((detailNext.title || '')));
      const label = s ? ('看第' + s.num + (s.kind === '部' ? '部' : '季')) : '看下一季';
      btn.textContent = label + ' →';
      btn.classList.remove('ghost', 'on');
      btn.classList.add('primary');
      btn.title = detailNext.title || '';
      return;
    }
    // 没找到下一季：原来的预约开关
    btn.classList.remove('primary');
    btn.classList.add('ghost');
    btn.removeAttribute('title');
    const on = isReserved(detail.seriesId);
    btn.textContent = on ? '已预约✓' : '预约下一季';
    btn.classList.toggle('on', on);
  }

  /**
   * 详情页打开后探测下一季，把「预约下一季」升级成「看第X季 →」。
   * 复用 lookupNextSeason 的缓存/去重，不额外打接口；切剧后用 token 丢弃旧结果。
   */
  function probeDetailNext(sid) {
    const token = ++detailNextToken;
    detailNext = null;
    syncReserveBtn();
    lookupNextSeason(false).then((r) => {
      if (token !== detailNextToken || detail.seriesId !== sid) return;
      detailNext = r.next || null;
      syncReserveBtn();
    }).catch(() => { /* 查不到就维持预约按钮，不影响主流程 */ });
  }

  /* ---------------- 播放器 ---------------- */
  const player = $('player'), video = $('video');
  const play = {
    seriesId: '', index: 0, quality: CFG.DEFAULT_QUALITY || '1080p', speed: 1,
    idleTimer: 0, seekDragging: false,
    view: { aspect: 'contain', rotate: 0 },   // 画面模式与旋转（会持久化）
    locked: false,                            // 控件锁定（防误触，不持久化）
    hintTimer: 0,                             // 锁定态下解锁条的自动淡出计时
    holdTimer: 0, holdActive: false,          // 长按三倍速
    holdFired: false,                         // 本次手势是否已触发长按（用于吞掉随后的 click）
    panelSwallow: false,                      // 本次 click 只是「收面板」，不要暂停
    sleepAt: 0, sleepTimer: 0,                // 定时停止
    crossSeason: false                        // 跨季连播（持久化，默认关）
  };

  function toast(msg, ms = 1800) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function currentEp() { return detail.episodes[play.index - 1]; }

  /* 首帧等待提示：解密代理首次要下载+解密整集，慢时给用户明确反馈 */
  const hint = { timer: 0, t0: 0 };
  function showHint(text) {
    const box = $('playerHint');
    box.hidden = false;
    hint.t0 = Date.now();
    hint.text = text;
    const paint = () => {
      const sec = Math.floor((Date.now() - hint.t0) / 1000);
      $('playerHintText').textContent = text + (sec >= 2 ? `（已等 ${sec}s）` : '');
    };
    paint();
    clearInterval(hint.timer);
    hint.timer = setInterval(paint, 1000);
  }
  function hideHint() {
    clearInterval(hint.timer);
    $('playerHint').hidden = true;
  }

  /* 预热：让后端提前下载并解密，点播时直接命中缓存 */
  function prewarm(vid, quality) {
    if (!vid) return;
    const qs = new URLSearchParams({ vid, quality: quality || play.quality, api_key: KEY });
    if (SHARE) qs.set('sharecode', SHARE);
    fetch(`${API}/prewarm?${qs.toString()}`).catch(() => {});
  }

  /** 从 fromIndex（1 起）开始的连续三集 vid：本集 + 后两集。 */
  function cacheWindow(fromIndex) {
    const out = [];
    for (let i = fromIndex; i < fromIndex + 3 && i <= detail.episodes.length; i++) {
      const ep = detail.episodes[i - 1];
      if (ep && ep.vid) out.push(String(ep.vid));
    }
    return out;
  }

  /** 通知后端按窗口滚动缓存：窗口外、且不是刚落盘的旧缓存会被顶替掉。 */
  function keepCacheWindow(vids) {
    if (!vids || vids.length === 0) return;
    const qs = new URLSearchParams({ vids: vids.join(','), api_key: KEY });
    if (SHARE) qs.set('sharecode', SHARE);
    fetch(`${API}/cache/keep?${qs.toString()}`).catch(() => {});
  }

  /**
   * 播放器标题：剧名跑马灯 + 集数徽章。
   * 短标题静止居中，长标题来回滚动；外层 #playerTitle 的 textContent 仍是完整
   * 「剧名 · 第 N 集」，与旧实现一致（测试/无障碍依赖这点）。
   */
  async function playEpisode(index) {
    if (!detail.episodes.length) return;
    play.index = Math.min(Math.max(1, index), detail.episodes.length);
    const ep = currentEp();
    if (!ep) return;
    hideNextSeason();
    closePanels();            // 换集时把上一集留着的面板收掉
    rememberVid(detail.seriesId, ep.vid);   // 兜底名单：后端取不到剧集列表时仍能删当前集
    player.hidden = false;
    document.body.style.overflow = 'hidden';
    history.replaceState(null, '', '#/w/' + detail.seriesId + '/' + play.index);
    $('playerTitle').textContent = `${detail.meta ? detail.meta.title : ''} · 第 ${ep.index} 集`;
    $('qualityBtn').textContent = (play.quality || 'auto').replace('p', 'P');
    $('bigPlay').classList.add('hide');
    $('seekPlayed').style.width = '0%';
    $('seekBuffer').style.width = '0%';
    applyView();             // 旋转/画面模式跨集保持，但要按当前容器重算尺寸

    const hist = records.history()[detail.seriesId];
    const resume = hist && hist.index === ep.index ? hist.t : 0;

    showHint(`正在准备 ${(play.quality || '').toUpperCase()} 片源，首次播放需服务端解密`);
    loadSource(ep.vid, play.quality, resume, true);
    loadDanmaku(ep.vid);      // 弹幕与片源并行拉，互不阻塞

    // 预热「后两集」+ 弹幕预取 + 缓存窗口滚动：当前集一开始加载就排队，
    // 不再依赖 playing 事件（禁自动播放 / 用户暂停时 playing 不来，预热就永远不发）。
    // 后端取址队列区分优先级：预热是 low，排在用户点播（high）后面，
    // 提前排队不会抢当前集的取址位，但用户点下一集时缓存多半已就绪。
    // 缓存只留「本集 + 后两集」三集，再往前的一律顶替掉（磁盘不无限涨）。
    const myToken = loadToken;
    const windowIds = cacheWindow(play.index);
    if (windowIds.length > 1) {
      setTimeout(() => {
        if (myToken !== loadToken || player.hidden) return;
        for (const vid of windowIds.slice(1)) prewarm(vid, play.quality);
        prefetchDanmaku(windowIds.slice(1));   // 后两集弹幕先拉到内存，换集零等待
        keepCacheWindow(windowIds);            // 窗口外的旧缓存让位
      }, 3000);
    }

    renderEpisodes();
    updateQualityMenu();
    if (!$('epSheet').hidden) renderEpSheet();
    prefetchNextSeason();   // 最后两集时提前查下一季（命中缓存后季末提示不再等搜索）
  }

  /* 播放源加载：区分「解码不支持」与「网络/解密慢」，后者绝不降档 */
  let loadToken = 0;
  let netRetry = 0;

  /* 探测这个 URL 给的是视频还是错误 JSON。
     注意：360P 是后端 302 到 CDN，跨域重定向会让 fetch 抛错（CORS），
     这种情况返回 unknown，交给 <video> 自己判断，不能当成失败去重试。 */
  async function probeSource(url) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      return { video: ct.indexOf('video/') === 0, status: r.status, unknown: false };
    } catch (e) {
      return { video: false, status: 0, unknown: true };
    }
  }

  async function loadSource(vid, quality, resume, resetRetry) {
    const token = ++loadToken;
    if (resetRetry) netRetry = 0;
    const url = streamUrl(vid, quality);
    const qLabel = quality.toUpperCase();

    showHint(`正在准备 ${qLabel} 片源…`);
    const probe = await probeSource(url + '&_t=' + Date.now());
    if (token !== loadToken) return;

    if (!probe.video && !probe.unknown) {
      // 服务端还没解密好 / 上游被限流 / 502 —— 这是服务端问题，绝不降清晰度
      if (netRetry < 4) {
        netRetry += 1;
        showHint(`服务端还在准备 ${qLabel}（第 ${netRetry} 次重试）`);
        setTimeout(() => {
          if (token === loadToken) loadSource(vid, quality, resume, false);
        }, 1000 * netRetry + 500);
      } else {
        hideHint();
        toast('服务端解密失败，稍后点播放重试');
        $('bigPlay').classList.remove('hide');
      }
      return;
    }

    // 正常加载不带 _t，浏览器可复用；只有重试时才加时间戳绕开失败响应
    video.src = netRetry > 0 ? url + '&_t=' + Date.now() : url;
    video.load();
    endHold();                         // 换源时清掉长按快进，避免残留 3×
    video.playbackRate = play.speed;   // 切集/切清晰度后保持倍速

    const onMeta = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      if (video.playbackRate !== play.speed) video.playbackRate = play.speed;
      if (resume > 3 && resume < (video.duration || 0) - 5) {
        video.currentTime = resume;
        toast(`已续播 ${fmtTime(resume)}`);
      }
      dmAlign();                 // 弹幕时间轴对齐到本集（续播点），不清屏
      video.play().catch(() => { $('bigPlay').classList.remove('hide'); });
    };
    video.addEventListener('loadedmetadata', () => { hideHint(); }, { once: true });
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('playing', () => {
      hideHint();
      // 兜底：设备没有 HEVC 解码器时，浏览器不会报错，只会「有声音没画面」
      // （videoWidth 恒为 0）。这种情况才提示换 360P，避免误伤能播的机器。
      if (quality === '360p') return;
      setTimeout(() => {
        if (token !== loadToken) return;
        if (video.videoWidth === 0 && !video.paused) {
          const lower = lowerQuality(quality);
          toast('这台设备解不了 ' + quality.toUpperCase() + '，已降到 ' + lower.toUpperCase());
          play.quality = lower;
          store.set('mr.quality', lower);
          $('qualityBtn').textContent = lower.replace('p', 'P');
          loadSource(vid, lower, video.currentTime || 0, true);
        }
      }, 4000);
    }, { once: true });

    video.addEventListener('error', () => {
      if (token !== loadToken) return;
      hideHint();
      const code = video.error ? video.error.code : 0;
      // 走到这里说明服务端确实给了视频，但设备解不了（HEVC 常见）
      if (code === 3 || code === 4) {
        if (quality !== '360p') {
          const lower = lowerQuality(quality);
          toast('这台设备解不了 ' + quality.toUpperCase() + '，已降到 ' + lower.toUpperCase());
          play.quality = lower;
          store.set('mr.quality', lower);
          $('qualityBtn').textContent = lower.replace('p', 'P');
          loadSource(vid, lower, video.currentTime || 0, true);
        } else {
          toast('本集暂不可播，换一集试试');
        }
      } else {
        toast('播放中断，点播放键重试');
        $('bigPlay').classList.remove('hide');
      }
    }, { once: true });
  }

  function closePlayer() {
    saveProgress();
    hideNextSeason();
    endHold();                 // 关播放器时清掉长按快进状态
    dmClear();                 // 弹幕一并清屏（下集进播放器会重新拉）
    dm.awaitMeta = false;      // 关播放器复位换集冻结点，避免下集弹幕卡住
    // 关播放器就结束定时与锁定：下次进来是干净状态
    if (play.sleepTimer) { clearInterval(play.sleepTimer); play.sleepTimer = 0; }
    play.sleepAt = 0;
    updateSleepBadge();
    setLocked(false);
    if (detail.seriesId) history.replaceState(null, '', '#/d/' + detail.seriesId);
    video.pause();
    video.removeAttribute('src');
    video.load();
    player.hidden = true;
    // 关播放器后若还停在详情页，body 要继续锁住（详情页自己滚）
    document.body.style.overflow = detailPage.hidden ? '' : 'hidden';
    renderEpisodes();
  }

  function saveProgress() {
    const ep = currentEp();
    if (!ep || !detail.seriesId) return;
    const t = video.currentTime || 0;
    if (!t || video.ended) return;
    const hist = records.history();
    hist[detail.seriesId] = {
      id: detail.seriesId,
      title: detail.meta ? detail.meta.title : '',
      cover: detail.meta ? detail.meta.cover : '',
      eps: detail.episodes.length,
      index: ep.index,
      vid: ep.vid,
      t,
      ts: Date.now()
    };
    records.setHistory(hist);
  }

  /* ---------------- 下一季提示 ---------------- */
  const CN_DIGIT = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function cnToNum(s) {
    if (!s) return NaN;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return CN_DIGIT[s];
    if (s[0] === '十') return 10 + (CN_DIGIT[s[1]] || 0);
    if (s[1] === '十') return (CN_DIGIT[s[0]] || 0) * 10 + (CN_DIGIT[s[2]] || 0);
    return NaN;
  }
  /* 从剧名里解析季/部/Season 序号，返回 { base 去掉季号的剧名, num, kind } */
  function parseSeason(title) {
    const t = String(title || '');
    let m = t.match(/第\s*([一二三四五六七八九十两零\d]+)\s*季/);
    if (m) { const n = cnToNum(m[1]); if (!isNaN(n)) return { base: t.slice(0, m.index).replace(/[的之\s·]+$/, ''), num: n, kind: '季' }; }
    m = t.match(/第\s*([一二三四五六七八九十两零\d]+)\s*部/);
    if (m) { const n = cnToNum(m[1]); if (!isNaN(n)) return { base: t.slice(0, m.index).replace(/[的之\s·]+$/, ''), num: n, kind: '部' }; }
    m = t.match(/season\s*(\d+)/i);
    if (m) return { base: t.slice(0, m.index).replace(/[的之\s·-]+$/, ''), num: parseInt(m[1], 10), kind: 'season' };
    // 上游有一批剧用「…考试一季 / …考试二季」这种省略「第」的写法（没有「第」字）。
    // 旧实现解析不出，currentSeason 就把整串标题当基名、num=1，导致
    // 基名带尾巴（…考试一季）匹配不上候选（…考试第二季），永远提示「暂未找到下一季」。
    // 这里只认「出现在标题末尾」的 X季/X部，避免误伤「四季如春」这类正常词。
    m = t.match(/([一二三四五六七八九十两零\d]+)\s*季\s*$/);
    if (m) { const n = cnToNum(m[1]); if (!isNaN(n)) return { base: t.slice(0, m.index).replace(/[的之\s·]+$/, ''), num: n, kind: '季' }; }
    m = t.match(/([一二三四五六七八九十两零\d]+)\s*部\s*$/);
    if (m) { const n = cnToNum(m[1]); if (!isNaN(n)) return { base: t.slice(0, m.index).replace(/[的之\s·]+$/, ''), num: n, kind: '部' }; }
    return null;
  }

  let seasonLookupToken = 0;
  let seasonTimer = 0;
  const seasonCache = new Map();      // seriesId -> { at, next }
  const seasonInflight = new Map();   // seriesId -> Promise
  const SEASON_TTL = 10 * 60 * 1000;
  function clearSeasonTimer() {
    if (seasonTimer) { clearInterval(seasonTimer); seasonTimer = 0; }
  }
  function hideNextSeason() {
    seasonLookupToken += 1;
    clearSeasonTimer();
    const box = $('nextSeasonBox');
    box.hidden = true;
    box.innerHTML = '';
  }

  /**
   * 当前剧的「季号 + 基名」。
   *
   * 关键：**没有「第X季」标记的剧按第 1 季处理**——续集叫《XXX第二季》。
   * 旧实现 parseSeason 返回 null 就直接放弃搜索，导致《和离后我带女儿横扫魔域》
   * 这类剧永远找不到下一季（它确实有第二季）。
   */
  function currentSeason(meta) {
    const title = String((meta && meta.title) || '').trim();
    const parsed = parseSeason(title);
    if (parsed !== null) return parsed;
    const idx = Number((meta && meta.season_index) || 0);
    if (idx > 0) return { base: title, num: idx, kind: '季' };
    return title === '' ? null : { base: title, num: 1, kind: '季' };
  }

  /** 基名比较：去掉季号后要一致（忽略「的/之/：/-」等连接符差异）。 */
  function sameBase(a, b) {
    const norm = (s) => String(s || '').replace(/[的之\s·:：\-—]+/g, '');
    return norm(a) === norm(b);
  }

  /** 取候选季详情：同源校验（album_id）+ 第 1 集 vid（用于预取）。 */
  async function seasonDetail(sid, albumId) {
    try {
      const r = await api('/episodes', { series_id: sid });
      // 任一侧拿不到 album_id（上游风控回落官网时这个字段整个不存在）就放行，
      // 宁可多给一个入口，也不要因为缺字段把真·下一季挡掉。
      const a = String(albumId === undefined || albumId === null ? '' : albumId);
      const b = String((r.meta && r.meta.album_id) || '');
      const ok = a === '' || b === '' || a === b;
      const first = (r.episodes || [])[0] || null;
      return { ok, firstVid: first ? first.vid : '' };
    } catch (e) {
      return { ok: true, firstVid: '' };
    }
  }

  /**
   * 查下一季（带缓存 + 并发去重）。
   *
   * 选的是「同剧、季号大于当前的最小那一季」，不要求正好 +1——上游经常缺季
   * 或跳号（第五季之后直接第七季），硬等 nextNum 会漏。
   *
   * @param {boolean} [force] 忽略缓存
   * @returns {Promise<{next: object|null, current: object|null}>}
   */
  function lookupNextSeason(force) {
    const sid = detail.seriesId;
    const meta = detail.meta || {};
    if (!sid) return Promise.resolve({ next: null, current: null });
    const cur = currentSeason(meta);
    if (cur === null) return Promise.resolve({ next: null, current: null });

    const cached = seasonCache.get(sid);
    if (!force && cached && Date.now() - cached.at < SEASON_TTL) {
      return Promise.resolve({ next: cached.next, current: cur });
    }
    const running = seasonInflight.get(sid);
    if (!force && running) return running;

    const task = (async () => {
      let next = null;
      try {
        const r = await api('/search', { q: cur.base, limit: 30 });
        let bestNum = Infinity;
        for (const it of r.results || []) {
          const d = normalize(it);
          if (!d.id || d.id === sid) continue;
          const s = parseSeason(d.title);
          if (s === null || s.num <= cur.num || s.num >= bestNum) continue;
          if (!sameBase(s.base, cur.base)) continue;
          bestNum = s.num;
          next = d;
        }
        if (next !== null) {
          const info = await seasonDetail(next.id, meta.album_id);
          if (!info.ok) {
            next = null;
          } else if (info.firstVid) {
            // 顺手把下一季第 1 集预取到服务端，切过去就能秒开
            prewarm(info.firstVid, play.quality);
          }
        }
      } catch (e) {
        next = null;
      }
      seasonCache.set(sid, { at: Date.now(), next });
      return { next, current: cur };
    })();
    seasonInflight.set(sid, task);
    task.then(() => seasonInflight.delete(sid), () => seasonInflight.delete(sid));
    return task;
  }

  /**
   * 提前查：一进入最后两集就开始找下一季并预取。
   *
   * 放完最后一集才查，用户会盯着「正在查找下一季…」等一次跨境请求；
   * 提前到倒数第二集，通常还有几分钟，查+预取早就完成了。
   */
  function prefetchNextSeason() {
    if (!detail.seriesId) return;
    if (play.index < detail.episodes.length - 1) return;
    lookupNextSeason(false).catch(() => {});
  }

  /* 看完最后一集：底部弹提示；命中缓存时直接给按钮，不再等搜索 */
  async function showNextSeasonPrompt() {
    const box = $('nextSeasonBox');
    box.hidden = false;
    box.innerHTML = '<div class="ns-card"><div class="ns-emoji">🎬</div>'
      + '<div class="ns-body"><div class="ns-title">本季已看完</div><div class="ns-sub">已是最后一集</div></div>'
      + '<div class="ns-actions"><button class="btn ghost" id="nsClose">关闭</button></div></div>';
    $('nsClose').addEventListener('click', hideNextSeason);

    const token = ++seasonLookupToken;
    const subEl = box.querySelector('.ns-sub');
    if (subEl) subEl.textContent = '正在查找下一季…';
    const r = await lookupNextSeason(false);
    if (token !== seasonLookupToken) return;
    if (r.next === null) {
      const reserved = isReserved(detail.seriesId);
      const title = String((detail.meta && detail.meta.title) || '');
      box.innerHTML = '<div class="ns-card"><div class="ns-emoji">📅</div>'
        + `<div class="ns-body"><div class="ns-title">${esc(title || '本剧')} · 本季已看完</div>`
        + `<div class="ns-sub">${reserved ? '已预约下一季，上线时首页会提醒你' : '暂未找到下一季，可预约，上线时提醒你'}</div></div>`
        + `<div class="ns-actions"><button class="btn ${reserved ? 'ghost' : 'primary'}" id="nsReserve">${reserved ? '取消预约' : '预约下一季'}</button>`
        + '<button class="btn ghost" id="nsClose">关闭</button></div></div>';
      $('nsReserve').addEventListener('click', () => {
        if (isReserved(detail.seriesId)) {
          cancelReservation(detail.seriesId);
          toast('已取消预约');
        } else {
          const added = reserveSeason(detail.seriesId, detail.meta);
          toast(added ? '已预约，下一季上线时首页会提醒你' : '预约失败');
        }
        showNextSeasonPrompt();   // 刷新按钮状态
      });
      $('nsClose').addEventListener('click', hideNextSeason);
      return;
    }
    showFoundSeason(r.next, box, token);
  }

  /** 找到下一季后：按「跨季连播」开关决定直接倒计时，还是给个按钮。 */
  function showFoundSeason(next, box, token) {
    const go = () => {
      hideNextSeason();
      closePlayer();
      openDetail(next.id, next).then(() => playEpisode(1));
    };
    if (!play.crossSeason) {
      box.innerHTML = '<div class="ns-card"><div class="ns-emoji">🎉</div>'
        + '<div class="ns-body"><div class="ns-title">本季看完啦</div>'
        + `<div class="ns-sub">发现《${esc(next.title)}》</div></div>`
        + '<div class="ns-actions"><button class="btn primary" id="nsGo">看下一季</button>'
        + '<button class="btn ghost" id="nsClose">关闭</button></div></div>';
      $('nsGo').addEventListener('click', go);
      $('nsClose').addEventListener('click', hideNextSeason);
      return;
    }
    let left = 5;
    const paint = () => {
      box.innerHTML = '<div class="ns-card"><div class="ns-emoji">⏭</div>'
        + '<div class="ns-body"><div class="ns-title">本季看完啦</div>'
        + `<div class="ns-sub">${left} 秒后自动播放《${esc(next.title)}》</div></div>`
        + '<div class="ns-actions"><button class="btn primary" id="nsGo">马上播</button>'
        + '<button class="btn ghost" id="nsClose">取消</button></div></div>';
      $('nsGo').addEventListener('click', () => { clearSeasonTimer(); go(); });
      $('nsClose').addEventListener('click', hideNextSeason);
    };
    paint();
    clearSeasonTimer();
    seasonTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { paint(); return; }
      clearSeasonTimer();
      if (token !== seasonLookupToken) return;
      go();
    }, 1000);
  }

  function nextEpisode(auto) {
    if (play.index < detail.episodes.length) {
      playEpisode(play.index + 1);
    } else {
      showNextSeasonPrompt();
    }
  }

  /* ---------------- 预约下一季（本机 localStorage） ----------------
     记录：mr.reservations = { [seriesId]: { title, base, num, at, notifiedNum } }
     - title/base/num：当前剧的剧名、去季号基名、当前季号（来自 currentSeason）
     - notifiedNum：最近一次已提醒的季号，避免重复提醒同一季
     没有账号体系，预约只在本机生效；换设备不同步。 */
  const RES_KEY = 'mr.reservations';
  function reservations() { return store.get(RES_KEY, {}); }
  function saveReservations(r) { store.set(RES_KEY, r); }
  function reserveSeason(seriesId, meta) {
    if (!seriesId) return false;
    const cur = currentSeason(meta);
    if (cur === null) return false;
    const all = reservations();
    const old = all[seriesId];
    if (old && old.num === cur.num) return false;   // 已预约过这一季
    all[seriesId] = {
      title: String((meta && meta.title) || ''),
      cover: String((meta && meta.cover) || ''),
      eps: Number((meta && meta.episode_cnt) || 0) || 0,
      base: cur.base,
      num: cur.num,
      kind: cur.kind || '季',
      at: Date.now(),
      notifiedNum: old ? old.notifiedNum : 0
    };
    saveReservations(all);
    return true;
  }
  function cancelReservation(seriesId) {
    const all = reservations();
    if (!all[seriesId]) return false;
    delete all[seriesId];
    saveReservations(all);
    return true;
  }
  function isReserved(seriesId) {
    const r = reservations()[seriesId];
    return !!(r && r.num);
  }

  /** 检查所有预约：任一剧已上线季号 > 预约时的 num，就返回命中项。 */
  async function checkReservedSeasons() {
    const all = reservations();
    const keys = Object.keys(all);
    if (keys.length === 0) return [];
    const hits = [];
    // 逐个查（预约数量通常很少），并发会导致上游限流
    for (const sid of keys) {
      const r = all[sid];
      if (!r || !r.base) continue;
      try {
        const res = await api('/search', { q: r.base, limit: 30 });
        let found = null;
        let best = Infinity;
        for (const it of res.results || []) {
          const d = normalize(it);
          if (!d.id) continue;
          const s = parseSeason(d.title);
          if (s === null || s.num <= (r.num || 0) || s.num >= best) continue;
          if (!sameBase(s.base, r.base)) continue;
          best = s.num;
          found = { seriesId: d.id, title: d.title, num: s.num, cover: d.cover, reserved: r };
        }
        if (found && found.num > (r.notifiedNum || 0)) hits.push(found);
      } catch (e) { /* 单部查询失败不影响其它 */ }
    }
    return hits;
  }

  /** 打开页面时的下一季提醒：命中则弹横幅，可点进去看。 */
  let notifyBannerShown = false;
  function showSeasonNotify(hits) {
    if (notifyBannerShown || hits.length === 0) return;
    notifyBannerShown = true;
    const h = hits[0];
    const all = reservations();
    if (all[h.reserved && h.reserved.seriesId]) {
      // 用预约记录的 key（不是命中的新季 id）标记已提醒的季号
      const key = Object.keys(all).find((k) => all[k] && all[k].base === h.reserved.base);
      if (key) { all[key].notifiedNum = h.num; saveReservations(all); }
    }
    const banner = $('seasonNotify');
    if (!banner) return;
    const txt = banner.querySelector('.sn-text');
    if (txt) txt.textContent = `你预约的《${h.title}》已上线`;
    banner.hidden = false;
    banner._go = () => {
      banner.hidden = true;
      openDetail(h.seriesId, normalize({ series_id: h.seriesId, title: h.title, cover: h.cover }));
    };
  }

  /** 页面启动后跑一次预约检查（节流：30 分钟内只查一次）。 */
  let reserveCheckStarted = false;
  function maybeCheckReservations() {
    if (reserveCheckStarted) return;
    if (Object.keys(reservations()).length === 0) return;
    reserveCheckStarted = true;
    const lastAt = store.get('mr.reserveCheckAt', 0);
    if (Date.now() - lastAt < 30 * 60 * 1000) return;
    store.set('mr.reserveCheckAt', Date.now());
    // 延迟 2 秒，避开首屏加载与后端冷启动
    setTimeout(() => { checkReservedSeasons().then(showSeasonNotify).catch(() => {}); }, 2000);
  }

  /* ---------------- 清晰度 ---------------- */
  function updateQualityMenu() {
    const menu = $('qualityMenu');
    menu.innerHTML = '';
    QUALITIES.forEach((q) => {
      const needHevc = q !== '360p';
      const disabled = false;
      const b = el('button', q === play.quality ? 'on' : '');
      b.style.opacity = disabled ? '.42' : '1';
      const tag = disabled ? '不支持' : (q === '360p' ? 'H.264' : (q === '1080p' ? '最高' : 'HEVC'));
      b.innerHTML = `<span>${Q_LABEL[q]}</span><span class="tag">${tag}</span>`;
      b.addEventListener('click', () => {
        if (disabled) { toast('当前浏览器不支持 HEVC 解码，请用 360P'); return; }
        switchQuality(q);
      });
      menu.appendChild(b);
    });
    menu.hidden = true;
  }

  function switchQuality(q) {
    if (q === play.quality) { $('qualityMenu').hidden = true; return; }
    const t = video.currentTime;
    const paused = video.paused;
    play.quality = q;
    store.set('mr.quality', q);
    $('qualityBtn').textContent = q.replace('p', 'P');
    const ep = currentEp();
    if (ep) {
      showHint(`正在切换 ${q.toUpperCase()}，首次切换需服务端解密`);
      loadSource(ep.vid, q, t, true);
      if (!paused) video.addEventListener('playing', () => video.play().catch(() => {}), { once: true });
    }
    $('qualityMenu').hidden = true;
    toast('已切换到 ' + Q_LABEL[q]);
  }

  /* ---------------- 工具面板：定时停止 / 画面模式 / 旋转 / 倍速 ---------------- */
  const RATES = [0.75, 1, 1.25, 1.5, 2, 3];
  const speedLabel = (n) => (n === 1 ? '1.0×' : String(n) + '×');

  function setSpeed(n) {
    const v = Number(n);
    if (RATES.indexOf(v) < 0) return;
    play.speed = v;
    // 长按三倍速期间不要覆盖当前播放速率，松手时 endHold 会回到新的 play.speed
    if (!play.holdActive) video.playbackRate = v;
    store.set('mr.speed', v);
    renderToolsMenu();
    toast('倍速 ' + speedLabel(v));
  }

  const ASPECTS = [
    { id: 'contain', label: '适应' },
    { id: 'cover', label: '填充' },
    { id: 'fill', label: '拉伸' },
    { id: 'none', label: '原始' }
  ];
  const ROTATES = [0, 90, 180, 270];
  const SLEEPS = [
    { min: 0, label: '关' }, { min: 15, label: '15分' }, { min: 30, label: '30分' },
    { min: 45, label: '45分' }, { min: 60, label: '60分' }, { min: 90, label: '90分' }
  ];

  /** 读回上次的画面设置。 */
  function loadView() {
    const v = store.get('mr.view', null);
    if (v && typeof v === 'object') {
      if (ASPECTS.some((a) => a.id === v.aspect)) play.view.aspect = v.aspect;
      const r = Number(v.rotate);
      if (ROTATES.indexOf(r) >= 0) play.view.rotate = r;
    }
  }

  /** 应用画面模式与旋转。旋转 90/270 时宽高互换，靠绝对定位 + margin:auto 保持居中。 */
  function applyView() {
    const rot = play.view.rotate || 0;
    video.style.objectFit = play.view.aspect || 'contain';
    if (!rot) {
      video.style.width = '';
      video.style.height = '';
      video.style.transform = '';
      return;
    }
    const box = player.getBoundingClientRect();
    // 播放器还没显示（尺寸为 0）时不量，等 playEpisode 里再算一次
    if (!box.width || !box.height) return;
    const swap = rot === 90 || rot === 270;
    video.style.width = swap ? box.height + 'px' : '';
    video.style.height = swap ? box.width + 'px' : '';
    video.style.transform = 'rotate(' + rot + 'deg)';
  }

  function setView(patch) {
    Object.assign(play.view, patch);
    store.set('mr.view', play.view);
    applyView();
    renderToolsMenu();
  }

  /* 定时停止：到点暂停并保存进度（不关播放器，方便回来接着看） */
  function sleepLeftMs() { return play.sleepAt ? Math.max(0, play.sleepAt - Date.now()) : 0; }

  function updateSleepBadge() {
    const badge = $('sleepBadge');
    const left = sleepLeftMs();
    if (!left) { badge.hidden = true; return; }
    const sec = Math.ceil(left / 1000);
    badge.hidden = false;
    badge.textContent = '定时 ' + String(Math.floor(sec / 60)).padStart(2, '0')
      + ':' + String(sec % 60).padStart(2, '0');
  }

  function setSleep(min) {
    if (play.sleepTimer) { clearInterval(play.sleepTimer); play.sleepTimer = 0; }
    play.sleepAt = min > 0 ? Date.now() + min * 60000 : 0;
    if (play.sleepAt) {
      play.sleepTimer = setInterval(() => {
        updateSleepBadge();
        if (sleepLeftMs() > 0) return;
        clearInterval(play.sleepTimer);
        play.sleepTimer = 0;
        play.sleepAt = 0;
        updateSleepBadge();
        video.pause();
        saveProgress();
        renderToolsMenu();
        toast('定时停止：已暂停播放');
      }, 1000);
    }
    updateSleepBadge();
    renderToolsMenu();
    if (min > 0) toast(min + ' 分钟后自动暂停');
  }

  /** 工具面板：定时 / 画面 / 旋转 三组分段按钮。 */
  function renderToolsMenu() {
    const menu = $('toolsMenu');
    menu.innerHTML = '';
    const group = (title, items, current, onPick) => {
      menu.appendChild(el('div', 'group-title', title));
      const row = el('div', 'row');
      items.forEach((it) => {
        const b = el('button', String(it.value) === String(current) ? 'on' : '', it.label);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(it.value); });
        row.appendChild(b);
      });
      menu.appendChild(row);
    };
    // 计时中不精确等于某个选项，用剩余分钟数就近高亮
    const sleepCur = play.sleepAt ? Math.ceil(sleepLeftMs() / 60000) : 0;
    group('定时停止', SLEEPS.map((s) => ({ value: s.min, label: s.label })),
      sleepCur, (v) => setSleep(Number(v)));
    group('画面', ASPECTS.map((a) => ({ value: a.id, label: a.label })),
      play.view.aspect, (v) => setView({ aspect: v }));
    group('旋转', ROTATES.map((r) => ({ value: r, label: r + '°' })),
      play.view.rotate, (v) => setView({ rotate: Number(v) }));
    group('跨季连播', [{ value: 'off', label: '关' }, { value: 'on', label: '开' }],
      play.crossSeason ? 'on' : 'off', (v) => setCrossSeason(v === 'on'));
    group('倍速', RATES.map((r) => ({ value: r, label: speedLabel(r) })),
      play.speed, (v) => setSpeed(v));
    group('弹幕字号', [{ value: 's', label: '小' }, { value: 'm', label: '中' }, { value: 'l', label: '大' }],
      dm.size, (v) => setDmSize(v));
    group('弹幕透明度', [
      { value: 1, label: '100%' }, { value: 0.8, label: '80%' },
      { value: 0.6, label: '60%' }, { value: 0.4, label: '40%' }
    ], dm.opacity, (v) => setDmOpacity(v));
    menu.appendChild(el('div', 'hint', '底栏图标：弹幕 / 上一集 / 下一集 / 选集 / 全屏 / 工具。'
      + '锁定后控件隐藏、点画面不再暂停；右侧中部可解锁。'));
  }

  /** 跨季连播：本季最后一集放完，自动接下一季第 1 集。 */
  function setCrossSeason(on) {
    play.crossSeason = !!on;
    store.set('mr.crossSeason', play.crossSeason);
    renderToolsMenu();
    toast(play.crossSeason ? '本季看完会自动接下一季' : '已关闭跨季连播');
  }

  /** 锁定状态下临时露出解锁条：平时不挡画面，点一下才出现，2.6s 后自动淡出。 */
  function flashUnlock() {
    if (!play.locked) return;
    player.classList.add('lock-hint');
    clearTimeout(play.hintTimer);
    play.hintTimer = setTimeout(() => {
      if (play.locked) player.classList.remove('lock-hint');
    }, 2600);
  }

  /** 锁定 / 解锁控件（防误触）。 */
  function setLocked(on) {
    play.locked = !!on;
    player.classList.toggle('locked', play.locked);
    $('lockBar').hidden = !play.locked;
    clearTimeout(play.hintTimer);
    if (play.locked) {
      player.classList.remove('idle');
      $('toolsMenu').hidden = true;
      $('qualityMenu').hidden = true;
      $('epSheet').hidden = true;
      flashUnlock();          // 刚锁上先提示一下「怎么解锁」，随后自动消失
    } else {
      player.classList.remove('lock-hint');
    }
  }

  /* ---------------- 长按三倍速 ---------------- */
  // 触屏（以及鼠标）按住画面 420ms 起 3× 快进，松手回到原倍速；
  // 锁定状态下同样可用——这是锁定后唯一的操作，不影响防误触。
  const HOLD_MS = 420;
  const HOLD_RATE = 3;

  /** 落在控件/菜单上的按压不算长按（否则拖进度条、点按钮会误触发）。 */
  function isControlTarget(t) {
    return !!(t && t.closest
      && t.closest('button, .seek, .quality-menu, .tools-menu, .ep-sheet, .lock-bar, .player-top, .player-bottom'));
  }

  function startHold(e) {
    if (e && e.button !== undefined && e.button > 0) return;   // 只认主键/单指
    if (isControlTarget(e && e.target)) return;
    if (video.paused) return;
    clearTimeout(play.holdTimer);
    play.holdTimer = setTimeout(() => {
      if (video.paused) return;
      play.holdActive = true;
      play.holdFired = true;
      video.playbackRate = HOLD_RATE;
      $('speedHoldBadge').hidden = false;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (ignore) { /* 忽略 */ } }
    }, HOLD_MS);
  }

  function endHold() {
    clearTimeout(play.holdTimer);
    if (!play.holdActive) return;
    play.holdActive = false;
    video.playbackRate = play.speed;
    $('speedHoldBadge').hidden = true;
  }

  player.addEventListener('pointerdown', (e) => {
    play.holdFired = false;      // 新手势：重置长按标记
    if (play.locked) flashUnlock();
    startHold(e);
  });
  window.addEventListener('pointerup', endHold);
  window.addEventListener('pointercancel', endHold);
  player.addEventListener('pointerleave', endHold);
  window.addEventListener('blur', endHold);

  /* ---------------- 弹幕 ---------------- */
  // 官方时间轴弹幕：进入某集时向 /danmaku 拉一次（服务端做签名+分页+缓存），
  // 前端只按 currentTime 投放。拿不到时提示「接口不可用」，绝不说成「本集没弹幕」。
  const DM_SIZES = { s: 14, m: 17, l: 21 };
  const DM_TOP = 48;          // 第一条轨道下移，避开顶栏标题与清晰度

  // 官方弹幕把表情写成 [赞] [比心] 这类占位符，客户端自己换图。我们拿不到那套
  // 图片资源，改用 Twemoji 的扁平彩色表情（已下载到 assets/emoji/，本地加载、
  // 不依赖外网，各平台字形一致）。表里没有的 token 保持原样（显示成 [xxx]）。
  const DM_EMOJI = {
    // 点赞/应援
    赞: '👍', 点赞: '👍', 强: '👍', 棒: '👍', 牛: '👍', 给力: '👍',
    鼓掌: '👏', 撒花: '👏', 送花: '💐', 花: '💐', 玫瑰: '🌹',
    比心: '❤️', 爱心: '❤️', 心: '❤️', 送心: '❤️', 两颗心: '💕',
    // 笑/开心
    爽: '😆', 大笑: '😄', 笑: '😄', 笑哭: '😂', 呲牙: '😁', 偷笑: '🤭',
    奸笑: '😏', 调皮: '😜', 坏笑: '😏', 开心: '😄', 兴奋: '🤩',
    // 爱慕/害羞
    爱慕: '😍', 色: '😍', 花痴: '😍', 亲亲: '😘', 亲: '😘',
    害羞: '😊', 微笑: '🙂', 可爱: '🥰', 抱抱: '🤗', 求抱抱: '🥺',
    // 哭/难过
    哭: '😭', 大哭: '😭', 泪奔: '😭', 流泪: '😢', 委屈: '🥺', 难过: '😔',
    崩溃: '😩', 抓狂: '😫', 快哭了: '🥺', 没看够: '🥹',
    // 其他情绪
    捂脸: '🤦', 汗: '😅', 尴尬: '😅', 尬笑: '😬', 饱了: '😌', 无语: '😑',
    白眼: '🙄', 鄙视: '😒',
    晕: '😵', 困: '😴', 生病: '🤒', 吓: '😱', 怒: '😠', 生气: '😠',
    震惊: '😲', 惊呆: '😮', 恐惧: '😨', 撇嘴: '😕', 思考: '🤔', 什么: '🤨',
    注意: '⚠️', 飞吻: '😘',
    酷: '😎', 机智: '🤓', 馋: '😋', 舔屏: '😋', 嘘: '🤫',
    // 动作/道具
    打脸: '🖐', 重拳出击: '👊', 顶帖: '🔝', 吃瓜: '🍉', 耶: '✌️', ok: '👌', OK: '👌', 握手: '🤝',
    祈祷: '🙏', 加油: '💪', 干杯: '🍻', 啤酒: '🍺', 咖啡: '☕', 蛋糕: '🎂',
    红包: '🧧', 礼物: '🎁', 音乐: '🎵', 火: '🔥', 星星: '⭐', 皇冠: '👑',
    钻石: '💎', 太阳: '☀️', 月亮: '🌙',
    // 提示/强调
    灵机一动: '💡', 灵光一闪: '✨', 疑问: '❓', 问号: '❓', 666: '🎉', 庆祝: '🎉'
  };
  const DM_TOKEN = /\[([^[\]]{1,8})\]/g;
  // 主用 Fluent Emoji 3D（assets/emoji3d），缺失时退回 Twemoji（assets/emoji）。
  const DM_EMOJI_3D = 'assets/emoji3d/';
  const DM_EMOJI_TW = 'assets/emoji/';

  /** emoji 字符 → Twemoji 文件名（去掉 FE0F，码点用 - 连接）。 */
  function dmEmojiFile(char) {
    const out = [];
    for (const ch of char) {
      const cp = ch.codePointAt(0);
      if (cp === 0xFE0F) continue;
      out.push(cp.toString(16));
    }
    return out.join('-');
  }

  /** 把 [xxx] 占位符换成表情图片，其余原样输出（用 DOM 节点，不拼 innerHTML）。 */
  function renderDmText(box, text) {
    box.textContent = '';
    let last = 0;
    DM_TOKEN.lastIndex = 0;
    let m = DM_TOKEN.exec(text);
    while (m !== null) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      const emoji = DM_EMOJI[m[1]];
      if (emoji) {
        const file = dmEmojiFile(emoji) + '.svg';
        const img = document.createElement('img');
        img.className = 'dm-emoji';
        img.alt = emoji;
        img.decoding = 'async';
        img.src = DM_EMOJI_3D + file;
        // 图片缺失时先退回 Twemoji，再退回系统 emoji 字符，不让它变成破图标
        img.onerror = () => {
          if (img.dataset.fallback !== 'tw') {
            img.dataset.fallback = 'tw';
            img.src = DM_EMOJI_TW + file;
            return;
          }
          const span = document.createElement('span');
          span.className = 'dm-emoji-text';
          span.textContent = emoji;
          img.replaceWith(span);
        };
        box.appendChild(img);
      } else {
        box.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
      m = DM_TOKEN.exec(text);
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
  }
  const dm = {
    on: store.get('mr.dm', true) !== false,
    size: store.get('mr.dmSize', 'm'),
    opacity: (() => {
      const v = Number(store.get('mr.dmOpacity', 0.9));
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
    })(),
    items: [], idx: 0, last: 0, lanes: [], token: 0,
    raf: 0, notice: '',
    // 内存弹幕缓存：预取后两集，换集时命中直接用，不必等接口回来。
    // 只留最近 8 集（本集 + 后两集 + 几集回看），防止长时间追剧内存上涨。
    cache: new Map(), awaitMeta: false, awaitMetaAt: 0
  };
  const DM_CACHE_MAX = 8;

  const dmFontPx = () => DM_SIZES[dm.size] || DM_SIZES.m;

  /**
   * 新集元数据就绪：把时间轴对齐到新集的起点，恢复投放。
   * 关键：不清屏。上一集尾部的弹幕让它们在 DOM 里自然飞完，
   * 新弹幕从新时间点接上，换集不会「黑一下」。
   */
  function dmAlign() {
    dm.awaitMeta = false;
    const t = video.currentTime || 0;
    dm.idx = dmSeekIndex(t);
    dm.last = t;
  }

  function dmClear() {
    const layer = $('dmLayer');
    if (layer) layer.innerHTML = '';
    dm.lanes = [];
  }

  /** 二分找第一个 time >= t 的下标（跳转后重新定位）。 */
  function dmSeekIndex(t) {
    let lo = 0;
    let hi = dm.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dm.items[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function dmEmit(item) {
    const layer = $('dmLayer');
    if (!layer || !layer.clientWidth) return;
    const now = performance.now();
    const el2 = document.createElement('span');
    renderDmText(el2, item.text);
    el2.style.color = item.color || '#FFFFFF';
    el2.style.fontSize = dmFontPx() + 'px';
    el2.style.opacity = String(dm.opacity);

    if (item.mode === 'top' || item.mode === 'bottom') {
      el2.className = 'dm-item dm-fixed';
      el2.style.top = item.mode === 'top' ? '10%' : '';
      if (item.mode === 'bottom') el2.style.bottom = '18%';
      layer.appendChild(el2);
      setTimeout(() => el2.remove(), 4400);
      return;
    }

    el2.className = 'dm-item';
    const h = dmFontPx() + 10;
    // 只占上半屏，别挡住字幕和底部控件
    const lanes = Math.max(3, Math.min(6, Math.floor((layer.clientHeight * 0.45) / h)));
    if (dm.lanes.length !== lanes) dm.lanes = new Array(lanes).fill(0);

    let lane = -1;
    for (let i = 0; i < lanes; i++) {
      if (dm.lanes[i] <= now) { lane = i; break; }
    }
    if (lane < 0) return;          // 轨道占满就丢弃，宁可少一条也不重叠

    el2.style.top = (DM_TOP + lane * h) + 'px';
    layer.appendChild(el2);
    const w = el2.offsetWidth || item.text.length * dmFontPx();
    const speed = Math.max(80, layer.clientWidth / 8);   // px/s，约 8 秒横穿一屏
    const dur = (layer.clientWidth + w + 24) / speed;
    dm.lanes[lane] = now + ((w + 24) / speed) * 1000;

    el2.style.transform = 'translateX(' + layer.clientWidth + 'px)';
    requestAnimationFrame(() => {
      el2.style.transition = 'transform ' + dur.toFixed(2) + 's linear';
      el2.style.transform = 'translateX(' + (-w - 24) + 'px)';
    });
    setTimeout(() => el2.remove(), dur * 1000 + 200);
  }

  function dmTick() {
    dm.raf = requestAnimationFrame(dmTick);
    if (!dm.on || player.hidden || !dm.items.length) return;
    const t = video.currentTime;
    if (dm.awaitMeta) {
      // 换集后 video 还没切源：currentTime 仍是上一集的旧值。
      // 此帧先不投放，也不清屏——等 loadedmetadata 里 dmAlign() 把时间轴对齐到新集。
      // 上一集最后的弹幕继续飘完，视觉上连贯。
      if (Date.now() - dm.awaitMetaAt < 15000) return;
      dm.awaitMeta = false;          // 兜底：元数据始终不来也不能卡死弹幕
      dm.idx = dmSeekIndex(t);
    } else if (t < dm.last - 1 || t > dm.last + 2.5) {
      // 同一集内用户主动拖进度条/回退（或标签页挂起后回来）才清屏
      dmClear();
      dm.idx = dmSeekIndex(t);
    }
    if (!video.paused) {
      while (dm.idx < dm.items.length && dm.items[dm.idx].time <= t) {
        dmEmit(dm.items[dm.idx]);
        dm.idx += 1;
      }
    }
    dm.last = t;
  }

  /** 弹幕内存缓存：把结果按 vid 存起来，换集命中即秒切。 */
  function dmCachePut(vid, items, notice) {
    dm.cache.delete(vid);
    dm.cache.set(vid, { items, notice: notice || '' });
    while (dm.cache.size > DM_CACHE_MAX) dm.cache.delete(dm.cache.keys().next().value);
  }

  /** 预取后两集弹幕：只写内存缓存，不碰当前正在显示的 dm.items，保证当前集连贯。 */
  async function prefetchDanmaku(vids) {
    if (!dm.on || !detail.seriesId) return;
    for (const vid of vids || []) {
      if (!vid || dm.cache.has(vid)) continue;
      try {
        const r = await api('/danmaku', { series_id: detail.seriesId, vid, limit: 1200 });
        if (!r || r.success !== true || !Array.isArray(r.items)) continue;
        dmCachePut(vid, r.items, r.notice);
      } catch (e) {
        // 预取失败不影响播放：真点开那一集时 loadDanmaku 会重新拉
      }
    }
  }

  /**
   * 进入某集时切换弹幕。
   * 连贯性：换集不清屏——已在屏幕上的弹幕让它们自然飞完（约 8 秒），
   * 新集的弹幕从当前时间点继续投。只有用户主动拖进度条才 dmClear。
   * 缓存命中时用内存里的 items，不等接口；未命中才异步拉，拉到后再对齐时间轴。
   */
  async function loadDanmaku(vid) {
    dm.token += 1;
    const token = dm.token;
    dm.notice = '';
    // 换集：先冻住投放，等新集 loadedmetadata 时把时间轴对齐（见 dmAlign）；
    // 期间上一集的弹幕继续自然飞完，不清屏。
    dm.awaitMeta = true;
    dm.awaitMetaAt = Date.now();
    if (!dm.on || !vid || !detail.seriesId) return;

    const hit = dm.cache.get(vid);
    if (hit) {
      dm.items = hit.items;
      dm.notice = hit.notice;
      return;                    // 命中缓存：零等待、零清屏
    }

    // 未命中：先保留上一集还在飞的弹幕，接口回来后再换数据源
    try {
      const r = await api('/danmaku', { series_id: detail.seriesId, vid, limit: 1200 });
      if (token !== dm.token) return;
      if (!r || r.success !== true) {
        dm.notice = (r && (r.error || r.notice)) || '弹幕接口不可用';
        toast(dm.notice, 2800);
        return;
      }
      const items = Array.isArray(r.items) ? r.items : [];
      dmCachePut(vid, items, r.notice);
      dm.items = items;
      if (r.notice) dm.notice = r.notice;
      if (!dm.items.length && !dm.awaitMeta) toast(r.notice || '本集暂无弹幕');
    } catch (e) {
      if (token === dm.token) dm.notice = '弹幕加载失败';
    }
  }

  function updateDmBtn() {
    const b = $('dmBtn');
    if (!b) return;
    b.classList.toggle('is-off', !dm.on);
    b.title = dm.on ? '弹幕：开（点击关闭）' : '弹幕：关（点击开启）';
  }

  function setDanmaku(on) {
    dm.on = !!on;
    store.set('mr.dm', dm.on);
    updateDmBtn();
    if (!dm.on) { dmClear(); dm.items = []; }
    else if (!player.hidden && currentEp()) loadDanmaku(currentEp().vid);
    renderToolsMenu();
    toast(dm.on ? '弹幕已开启' : '弹幕已关闭');
  }

  function setDmSize(size) {
    dm.size = DM_SIZES[size] ? size : 'm';
    store.set('mr.dmSize', dm.size);
    renderToolsMenu();
    toast('弹幕字号：' + ({ s: '小', m: '中', l: '大' }[dm.size]));
  }

  function setDmOpacity(value) {
    const v = Number(value);
    dm.opacity = Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
    store.set('mr.dmOpacity', dm.opacity);
    renderToolsMenu();
    toast('弹幕透明度：' + Math.round(dm.opacity * 100) + '%');
  }

  requestAnimationFrame(dmTick);

  /* ---------------- 播放器交互 ---------------- */
  function showControls() {
    if (play.locked) return;   // 锁定时不呼出控制栏，也不启动 idle 计时
    player.classList.remove('idle');
    clearTimeout(play.idleTimer);
    play.idleTimer = setTimeout(() => {
      if (!video.paused) {
        player.classList.add('idle');
        closePanels();       // 控制栏都藏了，面板也别单独留着
      }
    }, 2600);
  }

  video.addEventListener('timeupdate', () => {
    if (play.seekDragging) return;
    const d = video.duration || 0;
    const pct = d ? (video.currentTime / d) * 100 : 0;
    $('seekPlayed').style.width = pct + '%';
    $('seekKnob').style.left = pct + '%';
    $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
  });
  video.addEventListener('progress', () => {
    const d = video.duration || 0;
    if (!d || !video.buffered.length) return;
    $('seekBuffer').style.width = ((video.buffered.end(video.buffered.length - 1) / d) * 100) + '%';
  });
  video.addEventListener('play', () => { $('bigPlay').classList.add('hide'); showControls(); });
  video.addEventListener('pause', () => { $('bigPlay').classList.remove('hide'); player.classList.remove('idle'); saveProgress(); });
  video.addEventListener('ended', () => { saveProgress(); nextEpisode(true); });

  $('bigPlay').addEventListener('click', () => video.play().catch(() => {}));
  video.addEventListener('click', () => {
    // 刚才只是「点外面收面板」，不要顺带暂停
    if (play.panelSwallow) { play.panelSwallow = false; return; }
    // 长按三倍速结束后浏览器还会补一个 click，这里吞掉，否则会顺带暂停
    if (play.holdFired) { play.holdFired = false; return; }
    if (play.locked) { flashUnlock(); return; }   // 锁定：点画面不暂停，只露出解锁条
    if (video.paused) video.play().catch(() => {});
    else { video.pause(); }
    showControls();
  });
  player.addEventListener('mousemove', showControls);
  player.addEventListener('touchstart', showControls, { passive: true });

  const seek = $('seek');
  function seekTo(clientX) {
    const rect = seek.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const d = video.duration || 0;
    if (d) {
      video.currentTime = ratio * d;
      $('seekPlayed').style.width = ratio * 100 + '%';
      $('seekKnob').style.left = ratio * 100 + '%';
    }
  }
  seek.addEventListener('pointerdown', (e) => { play.seekDragging = true; seek.setPointerCapture(e.pointerId); seekTo(e.clientX); });
  seek.addEventListener('pointermove', (e) => { if (play.seekDragging) seekTo(e.clientX); });
  seek.addEventListener('pointerup', (e) => { play.seekDragging = false; seekTo(e.clientX); saveProgress(); });

  /* 播放器内选集面板 */
  function renderEpSheet() {
    const grid = $('epSheetGrid');
    if (!grid) return;
    grid.innerHTML = '';
    detail.episodes.forEach((ep) => {
      const b = el('button', 'ep' + (ep.index === play.index ? ' playing' : ''), String(ep.index));
      b.addEventListener('click', () => {
        $('epSheet').hidden = true;
        playEpisode(ep.index);
      });
      grid.appendChild(b);
    });
    $('epSheetTitle').textContent = `选集（共 ${detail.episodes.length} 集）`;
    const cur = grid.querySelector('.ep.playing');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
  }

  /* 播放器浮层（工具 / 清晰度 / 选集）统一收放：
     点面板外面、点画面、控制栏自动隐藏、或放着不动 8 秒，都会自己收起，
     不需要再点一次按钮。 */
  const PANELS = ['toolsMenu', 'qualityMenu', 'epSheet'];
  const PANEL_TOGGLES = '#toolsBtn, #qualityBtn, #epBtn';
  let panelTimer = 0;

  function anyPanelOpen() {
    return PANELS.some((id) => !$(id).hidden);
  }

  function closePanels(except) {
    let closed = false;
    for (const id of PANELS) {
      if (id === except) continue;
      const box = $(id);
      if (!box.hidden) { box.hidden = true; closed = true; }
    }
    if (closed) clearTimeout(panelTimer);
    return closed;
  }

  /** 面板开着时续命：任何操作都从这一刻重新计 8 秒。 */
  function keepPanelAlive() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => { closePanels(); }, 8000);
  }

  $('epBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const sheet = $('epSheet');
    if (sheet.hidden) { renderEpSheet(); sheet.hidden = false; keepPanelAlive(); }
    else sheet.hidden = true;
  });
  $('epSheetClose').addEventListener('click', () => { $('epSheet').hidden = true; });
  $('prevEp').addEventListener('click', () => { if (play.index > 1) playEpisode(play.index - 1); else toast('已经是第一集'); });
  $('nextEp').addEventListener('click', () => nextEpisode(false));
  $('qualityBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('qualityMenu');
    m.hidden = !m.hidden;
    if (!m.hidden) { closePanels('qualityMenu'); keepPanelAlive(); }
  });
  $('toolsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('toolsMenu');
    renderToolsMenu();
    m.hidden = !m.hidden;
    if (!m.hidden) { closePanels('toolsMenu'); keepPanelAlive(); }
  });
  $('lockBtn').addEventListener('click', (e) => { e.stopPropagation(); setLocked(true); });
  $('unlockBtn').addEventListener('click', (e) => { e.stopPropagation(); setLocked(false); });

  // 点面板外面就收起；点在画面上时顺手吞掉随后的 click，
  // 否则「关面板」会连带把视频暂停（用户只想把面板收起来）。
  document.addEventListener('pointerdown', (e) => {
    if (!anyPanelOpen()) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(PANEL_TOGGLES) || t.closest('#toolsMenu, #qualityMenu, #epSheet')) {
      keepPanelAlive();      // 在面板里操作不算「离开」，重新计时
      return;
    }
    if (t.closest('#video')) play.panelSwallow = true;
    closePanels();
  }, true);
  // 旋转后宽高依赖容器尺寸：窗口尺寸/全屏变化都要重算
  window.addEventListener('resize', () => { if (!player.hidden) applyView(); });
  function updateFsBtn() {
    const on = !!document.fullscreenElement;
    $('fsBtn').classList.toggle('is-fs', on);
    $('fsBtn').title = on ? '退出全屏' : '全屏';
  }
  document.addEventListener('fullscreenchange', () => {
    updateFsBtn();
    if (!player.hidden) applyView();
  });
  $('fsBtn').addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      toast('已退出全屏');
    } else if (player.requestFullscreen) {
      player.requestFullscreen().then(() => toast('已进入全屏')).catch(() => toast('当前浏览器不支持全屏'));
    } else {
      toast('当前浏览器不支持全屏');
    }
  });
  $('dmBtn').addEventListener('click', (e) => { e.stopPropagation(); setDanmaku(!dm.on); });
  $('playerBack').addEventListener('click', closePlayer);

  document.addEventListener('keydown', (e) => {
    if (player.hidden) return;
    // 锁定状态只认 Esc（解锁），避免躺着看时压到键盘误操作
    if (play.locked) {
      if (e.key === 'Escape') setLocked(false);
      return;
    }
    if (e.key === 'Escape') closePlayer();
    if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    if (e.key === 'ArrowRight') video.currentTime += 5;
    if (e.key === 'ArrowLeft') video.currentTime -= 5;
  });

  /* ---------------- 事件绑定 ---------------- */
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    [...$('tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
    if (btn.dataset.view === 'mine') { home.view = 'mine'; resetHome('mine'); return; }
    resetHome(btn.dataset.arg);
  });

  $('searchBtn').addEventListener('click', openSearch);
  $('searchBack').addEventListener('click', () => { searchPage.hidden = true; });
  $('searchGo').addEventListener('click', doSearch);
  $('searchInput').addEventListener('input', onSearchInput);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    else if (e.key === 'Escape') hideSuggest();
  });
  $('searchInput').addEventListener('blur', () => setTimeout(hideSuggest, 160));
  $('detailBack').addEventListener('click', () => {
    detailPage.hidden = true;
    document.body.style.overflow = '';   // 回到首页，恢复页面滚动
    history.replaceState(null, '', location.pathname + location.search);
  });
  $('playFirst').addEventListener('click', () => {
    const hist = records.history()[detail.seriesId];
    playEpisode(hist ? hist.index : 1);
  });
  $('favBtn').addEventListener('click', () => {
    const fav = records.favs();
    if (fav[detail.seriesId]) delete fav[detail.seriesId];
    else fav[detail.seriesId] = {
      id: detail.seriesId,
      title: detail.meta ? detail.meta.title : '',
      cover: detail.meta ? detail.meta.cover : '',
      eps: detail.episodes.length,
      ts: Date.now()
    };
    records.setFavs(fav);
    syncFavBtn();
  });
  $('reserveBtn').addEventListener('click', () => {
    // 已检测到下一季：直接跳过去播第 1 集（和看完最后一集的「看下一季」同一行为）
    if (detailNext) {
      const next = detailNext;
      hideNextSeason();
      closePlayer();
      openDetail(next.id, next).then(() => playEpisode(1));
      return;
    }
    // 没有下一季：预约开关
    if (isReserved(detail.seriesId)) {
      cancelReservation(detail.seriesId);
      toast('已取消预约');
    } else {
      const added = reserveSeason(detail.seriesId, detail.meta);
      toast(added ? '已预约，下一季上线时首页会提醒你' : '预约失败');
    }
    syncReserveBtn();
  });
  $('detailIntro').addEventListener('click', () => $('detailIntro').classList.toggle('open'));

  // 无限滚动
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting && home.view !== 'mine' && !home.done) loadHome(); });
  }, { rootMargin: '600px' });
  io.observe(sentinel);

  window.addEventListener('scroll', () => {
    if (home.view === 'mine' || home.done || home.loading) return;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 800) loadHome();
  }, { passive: true });

  window.addEventListener('beforeunload', saveProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

  /* ---------------- 启动 ---------------- */
  /* ---------------- 主题：跟随系统 / 浅色 / 深色 ---------------- */
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let themeMode = store.get('mr.theme', 'auto');
  if (!THEMES.includes(themeMode)) themeMode = 'auto';

  function resolvedTheme() {
    if (themeMode !== 'auto') return themeMode;
    if (!media) return 'dark';
    return media.matches ? 'light' : 'dark';
  }

  function applyTheme() {
    const actual = resolvedTheme();
    document.documentElement.setAttribute('data-theme', actual);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', actual === 'light' ? '#f5f6f8' : '#0b0b0f');

    const btn = $('themeBtn');
    if (btn) {
      btn.title = THEME_LABEL[themeMode] + (themeMode === 'auto' ? `（当前${actual === 'light' ? '浅色' : '深色'}）` : '');
      btn.setAttribute('aria-label', '主题：' + btn.title);
      btn.querySelector('.ic-auto').hidden = themeMode !== 'auto';
      btn.querySelector('.ic-light').hidden = themeMode !== 'light';
      btn.querySelector('.ic-dark').hidden = themeMode !== 'dark';
    }
  }

  function setTheme(mode) {
    themeMode = mode;
    store.set('mr.theme', mode);
    applyTheme();
    toast('主题：' + THEME_LABEL[mode]);
  }

  if (media) {
    const onChange = () => { if (themeMode === 'auto') applyTheme(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  function bootTheme() {
    applyTheme();
    const btn = $('themeBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
        setTheme(next);
      });
    }
  }

  /** 新版本提示横幅：由 index.html 的更新引导脚本派发 mr:update 触发。 */
  function bindUpdateBanner() {
    const banner = $('updateBanner');
    if (!banner) return;
    const show = (version) => {
      banner.hidden = false;
      const txt = banner.querySelector('.ub-text');
      if (txt) txt.textContent = '发现新版本' + (version ? '（' + version + '）' : '') + '，刷新即可使用';
    };
    $('ubRefresh').addEventListener('click', () => location.reload());
    $('ubClose').addEventListener('click', () => { banner.hidden = true; });
    // 顶栏「检查更新」按钮：手动触发，后端从 GitHub 拉取最新前端文件并刷新。
    // 没有后台轮询、没有自动弹窗。
    const ub = $('updateBtn');
    if (ub) ub.addEventListener('click', () => {
      if (typeof window.MR_DO_UPDATE !== 'function') { toast('更新功能不可用'); return; }
      ub.disabled = true;
      toast('正在从 GitHub 更新…', 1500);
      window.MR_DO_UPDATE((ok, info) => {
        ub.disabled = false;
        if (ok) {
          const n = (info && info.files) ? info.files.length : 0;
          const ver = info && info.display ? String(info.display) : (info && info.version ? String(info.version).slice(0, 8) : '');
          // 顶栏版本号立即更新，让用户看得到更新结果
          const vt = $('versionTag');
          if (vt && ver) vt.textContent = ver;
          if (info && info.restart) {
            toast('已更新 ' + n + ' 个文件；后端代码有更新，请重启服务后生效（版本 ' + ver + '）', 6000);
          } else {
            toast('已更新 ' + n + ' 个文件，正在刷新…（版本 ' + ver + '）', 1800);
            setTimeout(() => location.reload(), 900);
          }
        } else {
          toast('更新失败：' + (info === 'network' ? '网络错误' : String(info).slice(0, 40)), 3200);
        }
      });
    });
    const sb = $('seasonNotify');
    if (sb) {
      $('snGo').addEventListener('click', () => { if (sb._go) sb._go(); });
      $('snClose').addEventListener('click', () => { sb.hidden = true; });
    }
    document.addEventListener('mr:update', (e) => {
      show(e && e.detail ? e.detail.version : '');
    });
  }

  async function boot() {
    if (CFG.BRAND) { document.title = CFG.BRAND; $('brandText').textContent = CFG.BRAND; }
    bindUpdateBanner();
    bootTheme();
    await refreshClientConfig(true);
    const savedQ = store.get('mr.quality', '');
    if (savedQ && QUALITIES.includes(savedQ)) play.quality = savedQ;
    const savedSpeed = Number(store.get('mr.speed', 1));
    if (RATES.includes(savedSpeed)) play.speed = savedSpeed;
    $('qualityBtn').textContent = play.quality.replace('p', 'P');
    updateDmBtn();
    updateFsBtn();
    // 画面设置、音量都记住上次的值；定时停止每次重新设，不跨会话继承
    loadView();
    applyView();
    updateSleepBadge();
    play.crossSeason = store.get('mr.crossSeason', false) === true;
    renderToolsMenu();
    const savedVol = Number(store.get('mr.vol', NaN));
    if (savedVol >= 0 && savedVol <= 1) video.volume = savedVol;
    video.addEventListener('volumechange', () => {
      if (!video.muted) store.set('mr.vol', video.volume);
    });
    resetHome('hot');
    routeFromHash();
    maybeCheckReservations();   // 预约的剧若已上线下一季，顶部提醒
  }

  function routeFromHash() {
    const h = location.hash || '';
    let m = /^#\/w\/(\d+)\/(\d+)/.exec(h);
    if (m) {
      openDetail(m[1], null, true).then(() => playEpisode(Number(m[2])));
      return;
    }
    m = /^#\/d\/(\d+)/.exec(h);
    if (m) openDetail(m[1], null, true);
  }
  window.addEventListener('hashchange', routeFromHash);

  boot();
})();

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
      hot: item.hot || '',
      heat: Number(item.heat || 0),
      play: item.play_cnt || item.views || 0,
      tags: item.tags || item.category || [],
      intro: item.abstract || item.intro || item.description || '',
      rank: item.rank || 0
    };
  }

  /* 热度角标：名次与热度同时显示，不再互相吞掉。
     score 是榜单自己的推荐值（如「994万推荐」），hot 是红果热度值，两者都保留。 */
  function badges(d) {
    let s = '';
    if (d.rank) s += `<span class="badge rank">TOP ${d.rank}</span>`;
    if (d.hot) s += `<span class="badge heat">🔥 ${esc(d.hot)}</span>`;
    else if (d.score) s += `<span class="badge heat">${esc(d.score)}</span>`;
    return s;
  }

  function card(item) {
    const d = normalize(item);
    const node = el('div', 'card');
    const tags = Array.isArray(d.tags) ? d.tags : [];
    // 榜单 score 是「xx万推荐」而非评分，文案跟随上游，不再硬加「评分」前缀
    const sub = [d.eps ? `全 ${d.eps} 集` : '', tags.slice(0, 2).join(' / '),
      d.score ? esc(d.score) : ''].filter(Boolean).join(' · ');
    node.innerHTML = `
      <div class="thumb">
        ${d.cover ? `<img loading="lazy" src="${d.cover}" alt="">` : ''}
        ${badges(d)}
        ${d.eps ? `<span class="ep-tag">${d.eps} 集</span>` : ''}
      </div>
      <div class="name">${d.title}</div>
      <div class="sub">${sub}</div>`;
    node.addEventListener('click', () => openDetail(d.id, d));
    return node;
  }

  /* ---------------- 首页 ---------------- */
  const home = { view: 'hot', page: 0, loading: false, done: false, items: [], selections: {} };
  // 榜单状态：content=分类（全部/系列剧/漫剧/真人剧/AI剧），board=官方榜单 ID
  const rankUI = { content: 'all', board: 'ranklist_hot_play_sc', cursor: '', meta: null };
  const grid = $('grid'), status = $('status'), sentinel = $('sentinel');
  const homeHero = $('homeHero'), homeSections = $('homeSections'), topicBar = $('topicBar');
  const rankBar = $('rankBar');
  let homeFeedGen = 0;      // 首页增强区的代际，切 tab 时作废旧请求
  let bannerTimer = 0;      // Banner 自动轮播定时器
  let seasonRowCleanup = null; // 全季横滑轨道的事件清理

  /* 把上游条目数组归一成统一结构（Banner / 横滑轨道用） */
  function toCards(items) {
    return (Array.isArray(items) ? items : []).map(normalize).filter((d) => d.id && d.title);
  }

  /* 沉浸式背景 Banner：图片作页面顶部背景（向下 mask 渐隐），文案浮在图上。
     图片层与文案层分离，切换时两层同步；5 秒自动轮播、悬停暂停、指示点可点。 */
  function renderBanner(host, cards, bgOnly) {
    clearInterval(bannerTimer);
    if (!host) return;
    if (!cards.length) { host.innerHTML = ''; return; }
    document.body.classList.add('hero-bg-view');
    // 分类页只铺背景图，不要文案/标签/立即观看/指示点（bgOnly）
    if (bgOnly) document.body.classList.add('hero-bg-only');
    else document.body.classList.remove('hero-bg-only');
    const box = el('div', 'hero-banner');
    // 背景层：各 slide 的封面图（带渐隐 mask）
    const bg = el('div', 'home-hero-bg');
    bg.innerHTML = cards.map((d, i) => `
      <div class="hero-slide${i === 0 ? ' on' : ''}" data-i="${i}">
        ${d.cover ? `<img loading="${i === 0 ? 'eager' : 'lazy'}" src="${esc(d.cover)}" alt="">` : ''}
      </div>`).join('');
    box.appendChild(bg);
    box.appendChild(el('div', 'hero-scrim'));
    let copy = null, dots = [], chip = null, title = null, meta = null;
    if (!bgOnly) {
      // 遮罩层 + 文案层（文案随轮播切换，避免每张图重复一份）
      copy = el('div', 'hero-copy');
      copy.innerHTML = `
        <span class="hero-chip"></span>
        <h2></h2>
        <div class="hero-meta"></div>
        <button class="hero-play">▶ 立即观看</button>`;
      box.appendChild(copy);
      box.insertAdjacentHTML('beforeend',
        `<div class="hero-dots">${cards.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>`);
      dots = [...box.querySelectorAll('.hero-dots i')];
      chip = copy.querySelector('.hero-chip');
      title = copy.querySelector('h2');
      meta = copy.querySelector('.hero-meta');
    }
    host.innerHTML = '';
    host.appendChild(box);
    const slides = [...bg.querySelectorAll('.hero-slide')];
    let idx = 0, paused = false;
    const go = (n) => {
      idx = ((n % cards.length) + cards.length) % cards.length;
      const d = cards[idx];
      slides.forEach((s, i) => s.classList.toggle('on', i === idx));
      if (!bgOnly) {
        dots.forEach((x, i) => x.classList.toggle('on', i === idx));
        chip.textContent = idx === 0 ? '重磅推荐' : '热播';
        title.textContent = d.title;
        meta.textContent = (d.eps ? '全 ' + d.eps + ' 集' : '')
          + (d.score ? (d.eps ? ' · ' : '') + esc(d.score) + ' 分' : '');
      }
    };
    go(0);
    if (!bgOnly) {
      // 整块可点进详情；指示点单独处理不冒泡
      box.addEventListener('click', (e) => {
        if (e.target.closest('.hero-dots')) return;
        openDetail(cards[idx].id, cards[idx]);
      });
      dots.forEach((d, i) => d.addEventListener('click', (e) => { e.stopPropagation(); go(i); }));
    }
    box.addEventListener('mouseenter', () => { paused = true; });
    box.addEventListener('mouseleave', () => { paused = false; });
    bannerTimer = setInterval(() => { if (!paused && player.hidden) go(idx + 1); }, 5000);
  }

  function hcard(d) {
    const c = el('div', 'hcard');
    c.innerHTML = `
      <div class="thumb">
        ${d.cover ? `<img loading="lazy" src="${esc(d.cover)}" alt="">` : ''}
        ${badges(d)}
        ${d.eps ? `<span class="ep-tag">${d.eps} 集</span>` : ''}
      </div>
      <div class="name">${esc(d.title)}</div>`;
    c.addEventListener('click', () => openDetail(d.id, d));
    return c;
  }

  /* 分区横滑轨道：标题 + 可横向滑动的卡片行，「查看更多」切到对应分类 tab */
  function renderRow(name, arg, cards, hideMore) {
    if (!cards.length) return null;
    const sec = el('div', 'home-section');
    const title = el('div', 'sec-title');
    title.innerHTML = `<h2>${esc(name)}</h2>`
      + (hideMore ? '' : `<span class="more" data-arg="${esc(arg)}">查看更多</span>`);
    const row = el('div', 'hrow');
    cards.forEach((d) => row.appendChild(hcard(d)));
    const more = title.querySelector('.more');
    if (more) more.addEventListener('click', () => switchTab(arg));
    sec.appendChild(title);
    sec.appendChild(row);
    return sec;
  }

  function fmtDay(s) {
    const t = String(s || '');
    if (t.length !== 8) return t;
    const d = new Date();
    const today = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0');
    const md = t.slice(4, 6) + '/' + t.slice(6, 8);
    return t === today ? '今天' : (md);
  }

  async function pickNewReleaseDay(date, row) {
    try {
      const nr = await api('/sdk/new-releases', { date });
      const hrow = row.querySelector('.hrow');
      if (hrow) {
        hrow.innerHTML = '';
        toCards((nr && nr.items || []).map((x) => x.series || x)).slice(0, 10)
          .forEach((d) => hrow.appendChild(hcard(d)));
      }
      row.querySelectorAll('.date-chip').forEach((b) =>
        b.classList.toggle('on', b.dataset.date === String(nr.date || date)));
    } catch (e) { /* 切换失败保留原列表 */ }
  }

  /* 首页增强区：Banner（热播榜前 6）+ 真人剧 / AI漫剧 / AI短剧 三条横滑轨道。
     与主榜单 grid 并行渲染，失败也不影响下方列表。 */
  async function renderHomeFeed(gen) {
    if (!homeHero || !homeSections) return;
    try {
      const [rank, real, comic, ai] = await Promise.all([
        api('/rank', { board: 'hot', limit: 6 }).catch(() => null),
        api('/catalog', { channel: 'real', page: 1, limit: 10 }).catch(() => null),
        api('/catalog', { channel: 'comic', page: 1, limit: 10 }).catch(() => null),
        api('/catalog', { channel: 'ai', page: 1, limit: 10 }).catch(() => null),
      ]);
      if (gen !== homeFeedGen) return;   // 期间切走了视图
      renderBanner(homeHero, toCards(rank && rank.items));
      homeSections.innerHTML = '';
      [
        ['真人剧', 'real', real],
        ['AI漫剧', 'comic', comic],
        ['AI短剧', 'ai', ai],
      ].forEach(([name, arg, data]) => {
        const row = renderRow(name, arg, toCards(data && data.items).slice(0, 10));
        if (row) homeSections.appendChild(row);
      });
      // 今日上新：openhongguo SDK newReleases（第四条轨道，带 7 天日期切换）
      api('/sdk/new-releases', {}).then((nr) => {
        if (gen !== homeFeedGen) return;
        const cards = toCards((nr && nr.items || []).map((x) => x.series || x)).slice(0, 10);
        const row = renderRow('今日上新', 'hot', cards, true);
        if (!row) return;
        const dates = Array.isArray(nr && nr.dates) ? nr.dates : [];
        if (dates.length > 1) {
          const picker = el('div', 'date-chips');
          dates.slice(-7).forEach((dt) => {
            const b = el('button', 'date-chip' + (String(dt) === String(nr.date) ? ' on' : ''), fmtDay(dt));
            b.dataset.date = String(dt);
            b.addEventListener('click', () => pickNewReleaseDay(String(dt), row));
            picker.appendChild(b);
          });
          const title = row.querySelector('.sec-title');
          if (title) title.appendChild(picker);
        }
        homeSections.appendChild(row);
      }).catch(() => {});
      // 书城推荐：openhongguo SDK discover（推荐频道），不阻塞上面四条轨道
      api('/sdk/discover', { limit: 12 }).then((d) => {
        if (gen !== homeFeedGen) return;
        const row = renderRow('书城推荐', 'hot', toCards(d && d.items).slice(0, 10), true);
        if (row) homeSections.appendChild(row);
      }).catch(() => {});
    } catch (e) {
      // 首页增强失败静默降级，主榜单仍可正常浏览
    }
  }

  /* 热播榜二级切换栏：分类（全部/系列剧/漫剧/真人剧/AI剧）+ 该类下的官方榜单。
     数据来自 shortRank 返回的 contents，共 30 个真实榜单，不再只有「推荐榜」。 */
  function renderRankBar(meta) {
    if (!rankBar) return;
    if (home.view !== 'hot' || !meta || !(meta.contents || []).length) {
      rankBar.hidden = true; rankBar.innerHTML = ''; return;
    }
    const groups = meta.contents;
    const g = groups.find((x) => x.id === rankUI.content) || groups[0];
    rankUI.content = g.id;
    if (!(g.boards || []).some((b) => b.id === rankUI.board)) {
      rankUI.board = (g.boards && g.boards[0] && g.boards[0].id) || rankUI.board;
    }
    rankBar.hidden = false;
    rankBar.innerHTML = `
      <div class="rank-line">${groups.map((x) =>
        `<button class="rank-chip${x.id === g.id ? ' on' : ''}" data-content="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>
      <div class="rank-line sub">${(g.boards || []).map((b) =>
        `<button class="rank-chip${b.id === rankUI.board ? ' on' : ''}" data-board="${esc(b.id)}">${esc(b.name)}</button>`).join('')}</div>`;
    rankBar.onclick = (e) => {
      const btn = e.target.closest('.rank-chip');
      if (!btn) return;
      if (btn.dataset.content) {
        const next = groups.find((x) => x.id === btn.dataset.content);
        const first = next && next.boards && next.boards[0];
        reloadRank(btn.dataset.content, first ? first.id : rankUI.board);
      } else if (btn.dataset.board) {
        reloadRank(rankUI.content, btn.dataset.board);
      }
    };
  }

  function reloadRank(content, board) {
    rankUI.content = content; rankUI.board = board; rankUI.cursor = '';
    homeGen += 1;
    home.page = 0; home.loading = false; home.done = false; home.items = [];
    grid.innerHTML = ''; status.textContent = '';
    skeleton();
    loadHome();
  }

  function clearHomeExtras() {
    clearInterval(bannerTimer);
    document.body.classList.remove('hero-bg-view', 'hero-bg-only');
    if (homeHero) homeHero.innerHTML = '';
    if (homeSections) homeSections.innerHTML = '';
    if (topicBar) { topicBar.innerHTML = ''; topicBar.hidden = true; }
    if (rankBar) { rankBar.innerHTML = ''; rankBar.hidden = true; rankBar.onclick = null; }
  }

  /* 分类筛选：直接用 SDK shortFilterPanel 的官方筛选面板（体裁/主题/角色等 7 行），
     选中后走后端 shortFilter 重新取列表，不再拿已加载卡片的 tags 本地凑数。 */
  const FILTER_GENRE = { real: 'short_play', comic: 'comic_series', ai: 'ai_series' };

  async function renderTopicBar() {
    if (!topicBar) return;
    if (home.view === 'index' || home.view === 'hot' || home.view === 'mine') {
      topicBar.innerHTML = ''; topicBar.hidden = true; return;
    }
    try {
      const r = await api('/filters', { genre: FILTER_GENRE[home.view] || 'short_play' });
      const rows = ((r && r.rows) || []).filter((x) => x && x.key && x.key !== 'genre'
        && Array.isArray(x.options) && x.options.length);
      if (!rows.length) { topicBar.innerHTML = ''; topicBar.hidden = true; return; }
      topicBar.hidden = false;
      topicBar.className = 'topic-bar';
      topicBar.innerHTML = rows.map((row) => `
        <div class="filter-row">
          <span class="filter-label">${esc(row.name)}</span>
          <div class="filter-options">${row.options.slice(0, 16).map((o) => {
            const val = String(o.value !== undefined ? o.value : o.key || '');
            const on = (home.selections[row.key] || []).includes(val);
            return `<button class="topic-chip${on ? ' active' : ''}" data-key="${esc(row.key)}" data-val="${esc(val)}">${esc(o.label)}</button>`;
          }).join('')}</div>
        </div>`).join('');
      topicBar.onclick = (e) => {
        const b = e.target.closest('.topic-chip');
        if (!b) return;
        const key = b.dataset.key, val = b.dataset.val;
        const cur = home.selections[key] || [];
        home.selections[key] = cur.includes(val) ? [] : [val];   // 单选，再点一次取消
        reloadCatalog();
      };
    } catch (e) {
      topicBar.innerHTML = ''; topicBar.hidden = true;
    }
  }

  function reloadCatalog() {
    homeGen += 1;
    home.page = 0; home.loading = false; home.done = false; home.items = [];
    grid.innerHTML = ''; status.textContent = '';
    skeleton();
    loadHome();
  }

  function applyTopicFilter() {
    let shown = 0;
    [...grid.children].forEach((node) => {
      const d = node._card;
      const ok = !home.topic || (d && (Array.isArray(d.tags) ? d.tags : []).includes(home.topic));
      node.style.display = ok ? '' : 'none';
      if (ok) shown += 1;
    });
    status.textContent = home.topic
      ? `—「${home.topic}」共 ${shown} 部 —`
      : (home.done ? `— 共 ${home.items.length} 部，已经到底了 —` : '');
  }

  function skeleton(n = 6) {
    grid.innerHTML = '';
    for (let i = 0; i < n; i++) grid.appendChild(el('div', 'skeleton'));
  }

  let homeGen = 0;
  function resetHome(view) {
    // 每次切视图都换一代，丢弃上一代还在飞行的请求结果，
    // 否则重复 reset 会让第二次请求又从 offset=0 开始，拿回重复数据后误判「到底了」
    homeGen += 1;
    homeFeedGen += 1;
    home.started = true;
    home.view = view; home.page = 0; home.loading = false; home.done = false; home.items = [];
    home.topic = ''; home.selections = {};
    // 榜单翻页游标必须清零：否则切走再点回热播榜会从上次的位置续取，
    // 表现为「每次点击热播榜都换一批剧」。content/board 是用户选择，保留不动。
    rankUI.cursor = '';
    grid.innerHTML = ''; status.textContent = '';
    clearHomeExtras();
    if (view === 'mine') return renderMine();
    if (view === 'index') {
      // 首页：只展示 Banner + 三条分区轨道，不再堆下方榜单网格
      home.done = true;
      renderHomeFeed(homeFeedGen);
      return;
    }
    // 热播榜与三个分类：加载网格列表
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
      let rankResult = null;
      if (home.view === 'hot') {
        // 官方榜单每页只有 10~12 条，用 SDK cursor 续页，不再拿 offset×30 硬切
        const params = { board: rankUI.board, limit: 30 };
        if (rankUI.content && rankUI.content !== 'all') params.content = rankUI.content;
        if (rankUI.cursor) params.cursor = rankUI.cursor;
        else params.offset = home.page * 30;
        rankResult = await api('/rank', params);
        items = rankResult.items || [];
        more = !!rankResult.has_more;
      } else {
        const params = { channel: home.view, page: home.page + 1 };
        if (home.selections && Object.keys(home.selections).length) {
          params.selections = JSON.stringify(home.selections);
        }
        const r = await api('/catalog', params);
        items = r.items || [];
        more = !!r.has_more;
      }

      if (gen !== homeGen) return;   // 期间切换了视图，这批数据作废
      if (rankResult) {
        if (rankResult.contents && rankResult.contents.length) rankUI.meta = { contents: rankResult.contents };
        rankUI.cursor = String(rankResult.cursor || '');
        if (home.page === 0) renderRankBar(rankUI.meta);
      }
      if (home.page === 0) {
        grid.innerHTML = '';
        // 各分类页也继承首页的轮播背景：用本分类首批数据渲染 Banner（含文案/立即观看）
        if (homeHero && homeSections) {
          renderBanner(homeHero, toCards(items).slice(0, 6), true);  // 分类页只要背景图
          homeSections.innerHTML = '';
        }
      }
      const seen = new Set(home.items.map((x) => x.id));
      let added = 0;
      items.forEach((it) => {
        const d = normalize(it);
        if (d.id && seen.has(d.id)) return;   // 跨页去重
        if (d.id) seen.add(d.id);
        home.items.push(d);
        const node = card(it);
        node._card = d;                        // 题材筛选时按 tags 过滤用
        grid.appendChild(node);
        added += 1;
      });

      home.page += 1;
      if (added === 0 || !more || home.items.length >= 600) home.done = true;
      if (home.topic) applyTopicFilter();      // 已选题材时，新翻页数据沿用过滤
      else status.textContent = home.items.length === 0
        ? '暂无内容'
        : (home.done ? `— 共 ${home.items.length} 部，已经到底了 —` : '');
      if (home.page === 1) renderTopicBar();   // 首屏数据到位后聚合题材 chips
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
    if (home.done || home.view === 'mine' || home.view === 'index') return;
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
        <button class="text-btn light" id="resetDeviceBtn" title="更换匿名播放设备，取址失败时可点这里">更换播放设备</button>
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
    const rd = $('resetDeviceBtn');
    if (rd) {
      rd.addEventListener('click', async () => {
        rd.disabled = true;
        try {
          await api('/sdk/reset-device', {});
          toast('已更换播放设备，可重新播放试试');
        } catch (e) { toast('更换失败：' + (e.message || '未知错误')); }
        rd.disabled = false;
      });
    }
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

  /* 搜索筛选：openhongguo SDK SearchFilter（真人剧/漫剧/AI剧/影视剧/未看过）。 */
  const SEARCH_FILTERS = [
    ['', '全部'], ['real', '真人剧'], ['comic', '漫剧'],
    ['ai', 'AI剧'], ['film', '影视剧'], ['new', '未看过'],
  ];
  let searchFilter = '';
  function renderSearchFilters() {
    const box = $('searchFilters');
    if (!box) return;
    box.innerHTML = '';
    SEARCH_FILTERS.forEach(([val, label]) => {
      const b = el('button', 'sf-chip' + (searchFilter === val ? ' active' : ''), label);
      b.addEventListener('click', () => {
        if (searchFilter === val) return;
        searchFilter = val;
        renderSearchFilters();
        if ($('searchInput').value.trim()) doSearch();
      });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  /* openhongguo SDK 搜索增强：真实热搜/联想/提示词。接口失败时静默回退到本地默认。 */
  async function loadHotWords() {
    const box = $('hotWords');
    if (!box || box.dataset.live) return;
    box.dataset.live = '1';
    try {
      const r = await api('/sdk/hot', {});
      const words = (r && r.guesses) || [];
      const boardWords = (r && r.boards && r.boards[0] && r.boards[0].items) || [];
      const merged = [...new Set([...words, ...boardWords])].slice(0, 20);
      if (!merged.length) return;
      box.innerHTML = '';
      merged.forEach((w) => {
        const b = el('button', 'word', w);
        b.addEventListener('click', () => { $('searchInput').value = w; doSearch(); });
        box.appendChild(b);
      });
      box.dataset.init = '1';
    } catch (e) { /* 保留本地默认热词 */ }
  }
  /* openhongguo SDK searchCues：搜索框提示词轮播（用户没输入、没聚焦时才换） */
  let cueTimer = 0;
  async function loadSearchCues() {
    if (cueTimer) return;
    try {
      const r = await api('/sdk/cues', {});
      const cues = (r && r.items || []).map(String).filter((s) => s && s !== '书名');
      if (!cues.length) return;
      let i = 0;
      const input = $('searchInput');
      cueTimer = setInterval(() => {
        if (!$('searchPage').hidden && document.activeElement !== input && !input.value) {
          input.placeholder = cues[i % cues.length];
        }
        i += 1;
      }, 3500);
    } catch (e) { /* 提示词失败不影响搜索 */ }
  }

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

  /** SDK 联想词是纯文本，点选后直接按该词搜索（不是打开详情）。 */
  function renderTextSuggest(words) {
    const box = $('suggestList');
    box.innerHTML = '';
    words.slice(0, 10).forEach((w) => {
      const text = String(w || '').trim();
      if (!text) return;
      const row = el('button', 'sg-row');
      row.innerHTML = '<span class="sg-ph-text"></span>'
        + `<span class="sg-info"><span class="sg-name">${esc(text)}</span></span>`
        + '<span class="sg-go">›</span>';
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        hideSuggest();
        $('searchInput').value = text;
        pushSearchHist(text);
        renderSearchHist();
        doSearch();
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
      // SDK 联想词优先：纯文本，点选后按词搜索
      let words = [];
      try {
        const r = await api('/sdk/suggest', { q });
        if (seq !== suggestSeq) return;
        words = (r && r.items) || [];
      } catch (e) { /* 回落 /search */ }
      if (words.length) {
        renderTextSuggest(words);
        return;
      }
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
    document.body.classList.remove('hero-bg-view');
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
    loadHotWords(); // 异步替换为 SDK 真实热搜（失败则用本地默认）
    loadSearchCues(); // SDK 搜索框提示词轮播
    renderSearchFilters(); // SDK 筛选 chips
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
    renderSearchFilters();
    try {
      const params = { q, limit: 40 };
      if (searchFilter) params.filter = searchFilter;
      const r = await api('/search', params);
      const items = r.results || [];
      const fk = SEARCH_FILTERS.find(([v]) => v === searchFilter);
      searchStatus.textContent = items.length
        ? `共 ${items.length} 个结果${fk && searchFilter ? '（' + fk[1] + '）' : ''}`
        : '没有找到相关短剧';
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

  /* 演员主页：SDK person + personWorks。详情页演员 chip 点进来。 */
  const personPage = $('personPage');
  let personCursor = '', personLoading = false, personId = '';

  async function openPerson(userId, name) {
    if (!userId || !personPage) return;
    personId = String(userId);
    detailPage.hidden = true;
    personPage.hidden = false;
    document.body.style.overflow = 'hidden';
    personPage.scrollTop = 0;
    $('personName').textContent = name || '演员主页';
    $('personHead').innerHTML = '<span class="muted">加载中…</span>';
    $('personGrid').innerHTML = '';
    $('personStatus').textContent = '';
    $('personCount').textContent = '';
    personCursor = '';
    try {
      const p = await api('/sdk/person', { user_id: personId });
      if (personId !== String(userId)) return;
      const tags = (Array.isArray(p.tags) ? p.tags : (p.labels || []))
        .map((t) => `<span class="chip">${esc(typeof t === 'string' ? t : (t.name || t.text || ''))}</span>`).join('');
      $('personHead').innerHTML = `
        <div class="ph-avatar">${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : '👤'}</div>
        <div class="ph-info"><h2>${esc(p.name || name || '演员')}</h2>
          <p>${esc(p.description || '')}</p>
          <div class="chips">${tags}</div>
          <div class="ph-stat">粉丝 ${fmtCount(p.followers || 0)} · 获赞 ${fmtCount(p.likes || 0)}</div>
        </div>`;
    } catch (e) {
      $('personHead').innerHTML = `<div class="ph-info"><h2>${esc(name || '演员')}</h2></div>`;
    }
    await loadPersonWorks();
  }

  async function loadPersonWorks() {
    if (personLoading || !personId) return;
    personLoading = true;
    const uid = personId;
    try {
      const r = await api('/sdk/person-works', { user_id: uid, cursor: personCursor, limit: 30 });
      if (uid !== personId) return;
      const grid = $('personGrid');
      (r.items || []).forEach((it) => grid.appendChild(card(it)));
      personCursor = String(r.cursor || r.next_offset || '');
      $('personCount').textContent = grid.children.length ? `${grid.children.length} 部` : '';
      $('personStatus').innerHTML = r.has_more && personCursor
        ? '<button class="text-btn" id="personMore">加载更多</button>' : '— 已全部显示 —';
      const more = $('personMore');
      if (more) more.addEventListener('click', loadPersonWorks);
    } catch (e) { $('personStatus').textContent = '暂无作品'; }
    personLoading = false;
  }

  async function openDetail(seriesId, seed, keepHash) {
    if (!seriesId) return;
    document.body.classList.remove('hero-bg-view');
    if (!keepHash) history.replaceState(null, '', '#/d/' + seriesId);
    detail = { seriesId, meta: null, episodes: [] };
    detailNext = null;              // 切剧先清掉上一部的下一季状态
    detailNextToken += 1;           // 让上一部未完成的探测结果作废
    const sh = $('seasonsHead'); const sl = $('seasonList');
    if (sh) sh.hidden = true;
    if (sl) { sl.hidden = true; sl.innerHTML = ''; }   // 先清空全季，避免闪上一部
    if (seasonRowCleanup) { seasonRowCleanup(); seasonRowCleanup = null; }
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
    // 相关推荐：切剧先清空，避免闪上一部的推荐
    recommendToken += 1;
    const rh = $('recommendHead'); const rg = $('recommendGrid');
    if (rh) rh.hidden = true;
    if (rg) { rg.hidden = true; rg.innerHTML = ''; }

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
      const celebs = Array.isArray(m.celebrities) ? m.celebrities : [];
      $('detailChips').innerHTML = chips.map((c, i) => `<span class="chip${i === 0 ? ' accent' : ''}">${c}</span>`).join('')
        + celebs.map((c) => `<button class="chip actor-chip" data-uid="${esc(c.user_id)}">${esc(c.name || '演员')} ›</button>`).join('');
      $('detailChips').querySelectorAll('.actor-chip').forEach((b) => {
        b.addEventListener('click', () => openPerson(b.dataset.uid, b.textContent.replace(/\s*›$/, '')));
      });
      $('detailIntro').textContent = m.abstract || (seed && seed.intro) || '暂无简介';
      $('epCount').textContent = `${detail.episodes.length} 集`;
      renderEpisodes();
      syncFavBtn();
      syncReserveBtn();
      probeDetailNext(seriesId);    // 有下一季就把按钮升级成「看第X季 →」
      renderSeasons();              // 列出官方同系列全部季（多个同季版本都列，用户自选）
      // 打开详情页就把「大概率要点的那一集」丢给后端预取（有观看记录则续播那集，
      // 否则第 1 集）：等用户真去点播放时缓存多半已经就绪，首播不用再等解密。
      // 后端有并发去重与缓存，重复进详情页不会重复下载。
      const resumeIdx = (records.history()[detail.seriesId] || {}).index;
      const likely = detail.episodes.find((ep) => ep.index === (resumeIdx || 1))
        || detail.episodes[0];
      if (likely) prewarm(likely.vid, play.quality);
      loadRecommend(seriesId);
    } catch (e) {
      $('detailIntro').textContent = '加载失败：' + (e.message || '');
    }
  }

  let recommendToken = 0;

  /** 相关推荐：openhongguo SDK seriesRecommend，失败则不显示（不影响详情主体）。 */
  async function loadRecommend(seriesId) {
    const head = $('recommendHead'); const box = $('recommendGrid');
    if (!head || !box) return;
    const token = ++recommendToken;
    try {
      const r = await api('/sdk/recommend', { series_id: seriesId });
      if (token !== recommendToken || detail.seriesId !== seriesId) return;
      const items = (r && r.items) || [];
      if (!items.length) return;
      if (r.title) $('recommendTitle').textContent = r.title;
      box.innerHTML = '';
      items.slice(0, 12).forEach((it) => box.appendChild(card(it)));
      head.hidden = false;
      box.hidden = false;
    } catch (e) { /* 推荐非核心，失败静默 */ }
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
    // 已经找到下一季：按钮变成「看X季 →」，不再误导用户去预约一个已存在的季。
    // 文案直接沿用该季标题里的写法（二季 / 第二季 / 第2季），和命名风格一致。
    if (detailNext) {
      const m = String(detailNext.title || '').match(/(第?\s*[0-9零〇一二两三四五六七八九十百]+\s*[季部])\s*$/);
      const label = m ? ('看' + m[1].replace(/\s/g, '')) : '看下一季';
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
  /** 去掉季号 + 标点空白后的「标题主干」，用于判定是否同一系列。 */
  /**
   * 去掉标题末尾的季标记（“…第二季”、“…3”），留主干。
   * 对齐 beilunyang/openhongguo 的 seasonBaseTitle：只剥季号 + 去标点空白，
   * 不做任何「去尾的/之」的硬编码——结尾差异交给 sameSeasonBase 的前缀匹配处理。
   */
  function seasonStem(title) {
    return String(title || '').trim()
      .replace(/第?\s*[0-9零〇一二两三四五六七八九十百]+\s*季\s*$/, '')
      .replace(/[\p{P}\p{Z}\s]/gu, '');
  }

  /**
   * 判定两个标题是否同一系列。移植自 openhongguo sdk/series.go:
   *   candBase := seasonBaseTitle(item.Title)
   *   if candBase != base && !HasPrefix(candBase, base) && !HasPrefix(base, candBase) { continue }
   * 即归一化主干后做双向前缀匹配，容忍「…修仙」/「…修仙的」这类结尾差异，
   * 避免用严格相等时差一个「的」就把整部剧的全季全过滤掉。
   */
  function sameSeasonBase(titleA, titleB) {
    const a = seasonStem(titleA);
    const b = seasonStem(titleB);
    if (a === '' || b === '') return false;
    return a === b || a.startsWith(b) || b.startsWith(a);
  }

  /**
   * 季号写法分类。官方同一系列的命名风格统一，不同写法是不同的剧：
   *   'plain'      二季      （省略「第」+ 中文数字）
   *   'plain-ar'   2季       （省略「第」+ 阿拉伯数字）
   *   'di'         第二季    （带「第」+ 中文数字）
   *   'di-ar'      第2季     （带「第」+ 阿拉伯数字）
   * 「…考试二季」的续集只能是「…考试三季」；「…考试第二季」的续集才是「…考试第三季」。
   * 返回 null 表示标题里没有季号（不做风格限制）。
   */
  function seasonStyle(title) {
    const m = String(title || '').match(/(第)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*季\s*$/);
    if (!m) return null;
    const hasDi = !!m[1];
    const arabic = /^[0-9]+$/.test(m[2]);
    if (!hasDi) return arabic ? 'plain-ar' : 'plain';
    return arabic ? 'di-ar' : 'di';
  }

  /**
   * 全季横滑轨道：鼠标拖拽 + 左右箭头 + 边缘渐隐。
   * 触屏继续走浏览器原生横向滚动，不抢纵向页面手势。
   */
  function enableSeasonRow(wrap) {
    if (seasonRowCleanup) { seasonRowCleanup(); seasonRowCleanup = null; }
    const row = wrap && wrap.querySelector('.season-hrow');
    if (!row) return;
    const left = wrap.querySelector('.season-arrow.left');
    const right = wrap.querySelector('.season-arrow.right');
    const ac = new AbortController();
    let dragging = false, moved = false, startX = 0, startLeft = 0, suppressUntil = 0;

    const measure = () => {
      const max = Math.max(0, row.scrollWidth - row.clientWidth);
      wrap.classList.toggle('can-l', row.scrollLeft > 2);
      wrap.classList.toggle('can-r', row.scrollLeft < max - 2);
    };
    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      startX = e.clientX; startLeft = row.scrollLeft;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 5) return;
        moved = true;
        row.classList.add('dragging');
        row.style.scrollSnapType = 'none';
      }
      row.scrollLeft = startLeft - dx;
      e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      if (moved) suppressUntil = performance.now() + 200;
      dragging = false; moved = false;
      row.classList.remove('dragging');
      row.style.scrollSnapType = '';
      measure();
    };
    row.addEventListener('scroll', measure, { passive: true, signal: ac.signal });
    row.addEventListener('mousedown', onDown, { signal: ac.signal });
    row.addEventListener('click', (e) => {
      if (performance.now() >= suppressUntil) return;
      e.preventDefault(); e.stopPropagation();
    }, true, { signal: ac.signal });
    window.addEventListener('mousemove', onMove, { signal: ac.signal });
    window.addEventListener('mouseup', onUp, { signal: ac.signal });
    window.addEventListener('blur', onUp, { signal: ac.signal });
    const nudge = (dir) => row.scrollBy({
      left: dir * Math.max(140, row.clientWidth * 0.8), behavior: 'smooth'
    });
    if (left) left.addEventListener('click', () => nudge(-1), { signal: ac.signal });
    if (right) right.addEventListener('click', () => nudge(1), { signal: ac.signal });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(row);
      Array.from(row.children).forEach((c) => ro.observe(c));
    }
    measure();
    seasonRowCleanup = () => { ac.abort(); if (ro) ro.disconnect(); };
  }

  /**
   * 从官方「相关作品」里挑下一季。
   * 严格判定（移植自 hongguoTV RelatedWorks.nextSeason）：
   *  - 季号 = 当前季号 + 1（season_index 优先，其次标题里的季号）
   *  - 标题主干完全相同
   *  - 已上线（非待上线）
   *  - 唯一候选才认（多个同 stem 候选说明数据不可靠，宁可不给也不给错）
   */
  function pickNextFromOfficial(items, cur, sid, curTitle) {
    if (seasonStem(cur.base || '') === '') return null;
    const want = cur.num + 1;
    // 当前剧季号写法（第X季 / X季）。标题里没有季号时为 null，不做限制。
    const curStyle = seasonStyle(curTitle || '');
    const cands = [];
    for (const it of items || []) {
      if (!it || it.upcoming) continue;
      if (String(it.series_id) === String(sid)) continue;
      const idx = Number(it.season_index) > 0 ? Number(it.season_index) : 0;
      const fromTitle = parseSeason(it.title);
      const index = idx > 0 ? idx : (fromTitle ? fromTitle.num : 0);
      if (index !== want) continue;
      if (!sameSeasonBase(it.title, cur.base)) continue;
      // 写法必须一致：「…考试二季」的续集应是「…考试三季」，不是「…考试第三季」
      if (curStyle !== null && seasonStyle(it.title) !== curStyle) continue;
      cands.push({
        id: String(it.series_id), title: it.title,
        cover: it.cover || '', episodes: it.episode_cnt || 0,
      });
    }
    return cands.length === 1 ? cands[0] : null;
  }

  /**
   * 详情页「全季」区块：用官方 related 数据列出同一系列的所有季，点击切换。
   * 上游数据里同一季号可能有多个不同剧（如「…考试第三季」和「…考试三季」），
   * 所以不自动挑，全部列出来让用户自己选，避免预约/连播给错剧。
   */
  async function renderSeasons() {
    const head = $('seasonsHead');
    const list = $('seasonList');
    if (!head || !list) return;
    head.hidden = true; list.hidden = true; list.innerHTML = '';
    const sid = detail.seriesId;
    if (!sid) return;
    const meta = detail.meta || {};
    const cur = currentSeason(meta);
    if (cur === null) return;
    if (seasonStem(cur.base || '') === '') return;

    let items = [];
    try {
      const r = await api('/series-seasons', { series_id: sid });
      if (r && r.ok === true && Array.isArray(r.items)) items = r.items;
    } catch (e) { return; }
    if (detail.seriesId !== sid) return;   // 已经切到别的剧

    // 照 beilunyang/openhongguo 的 Seasons() 主路径：
    // 官方「系列剧」行(from=single_col_same_ip_series)是服务端按 album_id 权威分组的
    // 结果，返回什么季就全收，前端不再按标题/stem/style 过滤。之前做标题过滤是错的：
    // 官方认为同系列的剧，标题可能「他/她」一字之差（如
    // 「公路求生榜一说她要走到公路尽头第三季」的其它季叫「…说他要走到公路尽头」），
    // 用标题前缀匹配会把它们全过滤掉，导致详情页全季不显示。
    // 标题过滤只属于「搜索兜底」路径（拿不到官方数据时），不适用于这里。
    const rows = [];
    const seenIds = new Set();
    rows.push({
      id: String(sid), title: meta.title || '', cover: meta.cover || '',
      season_index: cur.num, season: '', upcoming: false, now: true,
      episodes: (detail.episodes || []).length,
    });
    seenIds.add(String(sid));
    for (const it of items) {
      if (!it || seenIds.has(String(it.series_id))) continue;
      seenIds.add(String(it.series_id));
      const ps = parseSeason(it.title);
      const idx = Number(it.season_index) > 0 ? Number(it.season_index) : (ps ? ps.num : 0);
      rows.push({
        id: String(it.series_id), title: it.title, cover: it.cover || '',
        season_index: idx, season: it.season || '', upcoming: !!it.upcoming, now: false,
        episodes: it.episode_cnt || 0,
      });
    }
    if (rows.length < 2) return;   // 只有一季就不用显示
    rows.sort((a, b) => {
      const ai = a.season_index > 0 ? a.season_index : Infinity;
      const bi = b.season_index > 0 ? b.season_index : Infinity;
      return ai - bi;
    });

    head.hidden = false;
    const cnt = $('seasonCount');
    if (cnt) cnt.textContent = rows.length + ' 季';
    // 折叠：记住上次状态（默认展开）。点标题行展开/收起。
    let collapsed = false;
    try { collapsed = store.get('mr.seasonsCollapsed', false) === true; } catch (e) { /* 忽略 */ }
    list.hidden = collapsed;
    head.classList.toggle('collapsed', collapsed);
    head.onclick = () => {
      const next = !list.hidden;
      list.hidden = next;
      head.classList.toggle('collapsed', next);
      try { store.set('mr.seasonsCollapsed', next); } catch (e) { /* 忽略 */ }
    };
    if (seasonRowCleanup) { seasonRowCleanup(); seasonRowCleanup = null; }
    list.innerHTML = '';
    const wrap = el('div', 'season-hrow-wrap');
    const row = el('div', 'season-hrow');
    wrap.appendChild(row);
    wrap.appendChild(el('button', 'season-arrow left', '‹'));
    wrap.appendChild(el('button', 'season-arrow right', '›'));
    list.appendChild(wrap);

    rows.forEach((r) => {
      const node = el('div', 'season-item' + (r.now ? ' now' : ''));
      const coverHtml = r.cover
        ? `<img class="si-cover" loading="lazy" src="${esc(r.cover)}" alt="">`
        : '<div class="si-cover-ph">📺</div>';
      const label = /季/.test(String(r.season || '')) ? String(r.season)
        : (r.season_index > 0 ? `第${r.season_index}季` : '季');
      const sub = r.now ? '正在看'
        : (r.upcoming ? '待上线' : label + (r.episodes ? ' · ' + r.episodes + '集' : ''));
      node.title = r.now ? '当前观看的这一季' : r.title;
      node.innerHTML = `
        <div class="season-cover">
          ${coverHtml}
          <span class="badge season">${esc(label)}</span>
        </div>
        <div class="si-t">${esc(r.title)}</div>
        <div class="si-m">${sub}</div>`;
      if (!r.now) {
        node.addEventListener('click', () => {
          hideNextSeason();
          closePlayer();
          openDetail(r.id, { id: r.id, title: r.title, cover: r.cover }).then(() => playEpisode(1));
        });
      }
      row.appendChild(node);
    });
    enableSeasonRow(wrap);
  }

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
      let officialOk = false;

      // 1) 官方「相关作品」优先：权威分组，能区分标题相似的不同的剧。
      try {
        const r = await api('/series-seasons', { series_id: sid, refresh: force ? '1' : '0' });
        if (r && r.ok === true) {
          officialOk = true;
          next = pickNextFromOfficial(r.items, cur, sid, meta.title);
        }
      } catch (e) { /* 接口不可用，走下面的搜索兜底 */ }

      // 2) 只有官方接口「不可用」时才回退搜索。官方明确返回但没有下一季
      //    （officialOk=true, next=null）就相信官方，不再用标题猜——否则又会误判。
      if (!officialOk) {
        try {
          const r = await api('/search', { q: cur.base, limit: 30 });
          let bestNum = Infinity;
          for (const it of r.results || []) {
            const d = normalize(it);
            if (!d.id || d.id === sid) continue;
            const s = parseSeason(d.title);
            if (s === null || s.num <= cur.num || s.num >= bestNum) continue;
            if (!sameSeasonBase(d.title, cur.base)) continue;
            bestNum = s.num;
            next = d;
          }
        } catch (e) {
          next = null;
        }
      }

      // 找到后异步预取下一季第 1 集（不阻塞返回）
      if (next !== null) {
        seasonDetail(next.id, meta.album_id).then((info) => {
          if (info && info.firstVid) prewarm(info.firstVid, play.quality);
        }).catch(() => {});
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
      const curNum = r.num || 1;
      let found = null;
      let officialOk = false;
      // 官方「相关作品」优先：避免把标题相似的不同剧当成下一季
      try {
        const resp = await api('/series-seasons', { series_id: sid });
        if (resp && resp.ok === true) {
          officialOk = true;
          const next = pickNextFromOfficial(resp.items, { base: r.base, num: curNum }, sid, r.title);
          if (next) {
            found = { seriesId: next.id, title: next.title, num: curNum + 1, cover: next.cover, reserved: r };
          }
        }
      } catch (e) { /* 接口不可用，走搜索兜底 */ }
      if (!officialOk) {
        try {
          const res = await api('/search', { q: r.base, limit: 30 });
          let best = Infinity;
          for (const it of res.results || []) {
            const d = normalize(it);
            if (!d.id) continue;
            const s = parseSeason(d.title);
            if (s === null || s.num <= curNum || s.num >= best) continue;
            if (!sameSeasonBase(d.title, r.base)) continue;
            best = s.num;
            found = { seriesId: d.id, title: d.title, num: s.num, cover: d.cover, reserved: r };
          }
        } catch (e) { /* 单部查询失败不影响其它 */ }
      }
      if (found && found.num > (r.notifiedNum || 0)) hits.push(found);
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
    group('弹幕行数', DM_ROWS_OPTIONS.map((n) => ({ value: n, label: n + ' 行' })),
      dm.rows, (v) => setDmRows(v));
    group('弹幕速度', [{ value: 'fast', label: '快' }, { value: 'medium', label: '中' }, { value: 'slow', label: '慢' }],
      dm.speed, (v) => setDmSpeed(v));
    // 透明度：滑轨（拖动实时生效，松手才 toast + 重建，避免打断拖动）
    menu.appendChild(el('div', 'group-title', '弹幕透明度'));
    const opRow = el('div', 'row tools-opacity');
    const opRng = el('input');
    opRng.type = 'range'; opRng.min = '10'; opRng.max = '100'; opRng.step = '5';
    opRng.value = String(Math.round(dm.opacity * 100));
    const opVal = el('span', 'val', Math.round(dm.opacity * 100) + '%');
    opRng.addEventListener('input', () => {
      opVal.textContent = opRng.value + '%';
      setDmOpacityLive(Number(opRng.value) / 100);
    });
    opRng.addEventListener('change', () => setDmOpacity(Number(opRng.value) / 100));
    opRow.appendChild(opRng); opRow.appendChild(opVal);
    menu.appendChild(opRow);
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
  // 弹幕滚动速度档位：全屏横穿秒数（越小越快），对齐参考项目 快/中/慢 三档
  const DM_SPEED_MS = { fast: 6, medium: 8, slow: 12 };
  const DM_ROWS_OPTIONS = [1, 3, 5];
  const dm = {
    on: store.get('mr.dm', true) !== false,
    size: store.get('mr.dmSize', 'm'),
    opacity: (() => {
      const v = Number(store.get('mr.dmOpacity', 0.9));
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
    })(),
    // 同时显示行数与滚动速度（设置页可调，播放器实时生效）
    rows: (() => {
      const n = Number(store.get('mr.dmRows', 3));
      return DM_ROWS_OPTIONS.includes(n) ? n : 3;
    })(),
    speed: (() => {
      const s = store.get('mr.dmSpeed', 'medium');
      return DM_SPEED_MS[s] ? s : 'medium';
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

  /**
   * 弹幕离屏移除：绑定动画 finished，暂停播放时动画 pause，finished 不会完成，
   * 弹幕就会真正定格在画面上（setTimeout 是墙钟，暂停时仍会把弹幕移除掉）。
   * 拿不到动画才退回 setTimeout。
   */
  function dmArmRemoval(node, fallbackMs) {
    requestAnimationFrame(() => {
      const anims = node.getAnimations ? node.getAnimations() : [];
      if (anims.length && anims[0].finished) {
        anims[0].finished.then(() => node.remove()).catch(() => {});
        if (video.paused) anims.forEach((a) => { try { a.pause(); } catch (_) {} });
      } else {
        setTimeout(() => node.remove(), fallbackMs);
      }
    });
  }

  /** 视频暂停/恢复时，冻结/继续画面上所有在飞的弹幕动画。 */
  function dmFreeze(freeze) {
    const layer = $('dmLayer');
    if (!layer) return;
    for (const node of layer.children) {
      const anims = node.getAnimations ? node.getAnimations() : [];
      for (const a of anims) {
        try { if (freeze) a.pause(); else a.play(); } catch (_) {}
      }
    }
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
      dmArmRemoval(el2, 4400);
      return;
    }

    el2.className = 'dm-item';
    const h = dmFontPx() + 10;
    // 用户设定行数优先；同时不超过上半屏可容纳的轨道数（别挡字幕和底部控件）
    const cap = Math.max(1, Math.min(6, Math.floor((layer.clientHeight * 0.45) / h)));
    const lanes = Math.min(dm.rows, cap);
    if (dm.lanes.length !== lanes) dm.lanes = new Array(lanes).fill(0);

    let lane = -1;
    for (let i = 0; i < lanes; i++) {
      if (dm.lanes[i] <= now) { lane = i; break; }
    }
    if (lane < 0) return;          // 轨道占满就丢弃，宁可少一条也不重叠

    el2.style.top = (DM_TOP + lane * h) + 'px';
    layer.appendChild(el2);
    const w = el2.offsetWidth || item.text.length * dmFontPx();
    const crossSec = DM_SPEED_MS[dm.speed] || DM_SPEED_MS.medium;
    const speed = Math.max(80, layer.clientWidth / crossSec);   // px/s，按设定档位横穿一屏
    const dur = (layer.clientWidth + w + 24) / speed;
    dm.lanes[lane] = now + ((w + 24) / speed) * 1000;

    el2.style.transform = 'translateX(' + layer.clientWidth + 'px)';
    requestAnimationFrame(() => {
      el2.style.transition = 'transform ' + dur.toFixed(2) + 's linear';
      el2.style.transform = 'translateX(' + (-w - 24) + 'px)';
    });
    dmArmRemoval(el2, dur * 1000 + 200);
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

  /** 拖动透明度滑轨时实时生效：不重建菜单（否则会打断拖动），只改状态+已上屏弹幕。 */
  function setDmOpacityLive(value) {
    const v = Number(value);
    dm.opacity = Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
    store.set('mr.dmOpacity', dm.opacity);
    const layer = $('dmLayer');
    if (layer) for (const n of layer.children) n.style.opacity = String(dm.opacity);
  }

  function setDmOpacity(value) {
    setDmOpacityLive(value);
    renderToolsMenu();
    toast('弹幕透明度：' + Math.round(dm.opacity * 100) + '%');
  }

  function setDmRows(value) {
    const n = Number(value);
    dm.rows = DM_ROWS_OPTIONS.includes(n) ? n : 3;
    dm.lanes = [];                       // 行数变了，重建轨道避免旧状态串位
    store.set('mr.dmRows', dm.rows);
    renderToolsMenu();
    toast('弹幕行数：' + dm.rows + ' 行');
  }

  function setDmSpeed(value) {
    dm.speed = DM_SPEED_MS[value] ? value : 'medium';
    store.set('mr.dmSpeed', dm.speed);
    renderToolsMenu();
    toast('弹幕速度：' + ({ fast: '快', medium: '中', slow: '慢' }[dm.speed]));
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
  video.addEventListener('play', () => {
    $('bigPlay').classList.add('hide'); showControls();
    dmFreeze(false);   // 恢复播放：画面上冻住的弹幕继续飞
  });
  video.addEventListener('pause', () => {
    $('bigPlay').classList.remove('hide'); player.classList.remove('idle'); saveProgress();
    dmFreeze(true);    // 暂停播放：弹幕动画一起冻结，不再滚
  });
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
  function switchTab(arg) {
    const btn = [...$('tabs').children].find((b) => (b.dataset.arg || '') === arg
      || (arg === 'mine' && b.dataset.view === 'mine'));
    if (btn) [...$('tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
    if (arg === 'mine') { home.view = 'mine'; resetHome('mine'); return; }
    resetHome(arg);
  }
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    [...$('tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
    if (btn.dataset.view === 'mine') { home.view = 'mine'; resetHome('mine'); return; }
    resetHome(btn.dataset.arg);
  });

  $('searchBtn').addEventListener('click', openSearch);
  $('searchBack').addEventListener('click', () => {
    searchPage.hidden = true;
    if (home.view === 'index') document.body.classList.add('hero-bg-view');
  });
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
    if (home.view === 'index') document.body.classList.add('hero-bg-view');
    history.replaceState(null, '', location.pathname + location.search);
  });
  $('personBack').addEventListener('click', () => {
    personPage.hidden = true;
    detailPage.hidden = false;
    document.body.style.overflow = 'hidden';
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

  /**
   * 后端更新后服务自动重启：等它「先断后起」再刷新页面。
   * 探测 /health：
   *   1) 先等旧进程退出（连续若干次探测失败）——最多 25s；
   *   2) 再等新进程就绪（探测成功）——最多 90s；
   * 两段都满足就 reload；任一段超时则提示手动刷新，绝不让页面永久转圈。
   */
  function waitForRestart() {
    const cfg = window.MR_CONFIG || {};
    const API = (cfg.API_BASE || '').replace(/\/+$/, '');
    const health = API + '/health';
    const deadline1 = Date.now() + 25000;   // 等旧进程退出
    const deadline2 = Date.now() + 25000 + 90000; // 等新进程起来（绝对时间）
    let downSeen = 0;   // 连续失败次数
    (async function step() {
      let ok = false;
      try {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 2000) : 0;
        const r = await fetch(health, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
        if (timer) clearTimeout(timer);
        ok = r.ok;
      } catch (e) { ok = false; }
      const now = Date.now();
      if (downSeen < 3) {
        // 阶段一：等旧进程退出（连续 3 次探测失败视为已断）
        if (!ok) downSeen += 1; else downSeen = 0;
        if (downSeen >= 3) {
          toast('服务已停止，正在等待重启…', 2500);
          downSeen = 3; // 进入阶段二标记
          return setTimeout(step, 500);
        }
        if (now < deadline1) return setTimeout(step, 400);
        // 超时仍未断：可能助手没杀掉旧进程，保险起见直接刷新一次
        toast('更新完成，正在刷新…', 1800);
        return setTimeout(() => location.reload(), 600);
      }
      // 阶段二：等新进程就绪
      if (ok) {
        toast('服务已重启，正在刷新…', 1500);
        return setTimeout(() => location.reload(), 500);
      }
      if (now < deadline2) return setTimeout(step, 600);
      toast('自动重启超时，请手动刷新页面', 5000);
    })();
  }

  /** 自动检测版本变化：每 30 秒比对 /version 内容哈希，发现新版提示刷新。
   *  坑：顶栏版本号是语义版本（v2.1.1），/version 返回的是内容哈希，
   *  拿顶栏文本当初始值比，两者永远不等 → 每次打开页面都弹、刷新后又弹。
   *  改为把「已确认的哈希」落到 localStorage，同一版本只提示一次。 */
  const SEEN_HASH_KEY = 'mr.seenHash';
  function markVersionSeen(hash) {
    store.set(SEEN_HASH_KEY, String(hash || ''));
  }
  function startVersionWatch() {
    let seen = String(store.get(SEEN_HASH_KEY, '') || '');
    setInterval(async () => {
      try {
        const r = await fetch(`${API}/version?t=` + Date.now(), { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        const hash = String(j.version || '');
        if (!hash) return;
        if (!seen) { seen = hash; markVersionSeen(hash); return; }  // 首次只记录，不打扰
        if (hash === seen) return;                                 // 已是当前版本
        seen = hash;
        markVersionSeen(hash);                                     // 先记下，避免同一版反复弹
        const banner = $('updateBanner');
        if (banner) {
          const txt = banner.querySelector('.ub-text');
          if (txt) txt.textContent = '发现新版本（' + (j.display || hash.slice(0, 8)) + '），刷新即可使用';
          banner.hidden = false;
        }
      } catch (e) { /* 检测失败不影响使用 */ }
    }, 30000);
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
          // 手动更新后同步「已确认哈希」，否则刷新回来又被版本轮询判成新版本弹一次
          if (info && info.version) markVersionSeen(info.version);
          if (info && info.restarting) {
            // 后端代码有更新，服务正在自动重启：等它起来再刷新，全程无需手动操作。
            toast('已更新 ' + n + ' 个文件，服务正在自动重启，请稍候…（版本 ' + ver + '）', 5000);
            waitForRestart();
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
    startVersionWatch();
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
    resetHome('index');
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

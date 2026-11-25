'use strict';
/**
 * openhongguo SDK -> 现有前端数据契约适配层。
 *
 * 前端 app.js 早已约定一套字段（series_id/episode_cnt/cover/abstract/has_more…），
 * SDK 返回的是 snake_case 的另一套。这里做纯数据转换 + 翻页/批量聚合，让前端
 * 零改动即可切换到 SDK 数据源，同时为新增能力（演员/榜单/分类等）提供接口。
 *
 * 所有函数返回普通对象（不是 Json.obj 包装），由 server.js 决定如何落地。
 */
const Ohg = require('./ohg');

/* ---------------- 通用转换 ---------------- */

/** 热度值格式化：71266914 -> "7126万"，用于卡片角标。 */
function formatHeat(n) {
  const v = Number(n || 0);
  if (v <= 0) return '';
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 10000) return Math.round(v / 10000) + '万';
  return String(v);
}

/**
 * SDK 封面 URL 规范化：SDK 给的是带签名的 .heic（浏览器不支持），
 * 提取图片 hash 换成公开的 byteimg jpg 模板。失败时原样返回。
 *   https://p3-reading-sign.fqnovelpic.com/novel-pic/<hash>~tplv-...heic?签名
 *   -> https://p6-novel.byteimg.com/novel-pic/<hash>~tplv-shrink:640:0.image
 */
function cover(url) {
  const s = String(url || '');
  if (!s) return '';
  if (!/\.heic(\?|$)/i.test(s)) return s; // 非 heic 直接透传
  const m = /(?:novel-pic|novel-pic-r)\/([0-9a-fA-F]+)~/.exec(s);
  if (!m) return s;
  const path = s.includes('/novel-pic-r/') ? 'novel-pic-r' : 'novel-pic';
  return 'https://p6-novel.byteimg.com/' + path + '/' + m[1] + '~tplv-shrink:640:0.image';
}

/** SDK SeriesSummary -> 前端卡片 series 对象。 */
function toSeries(s) {
  if (!s) return null;
  return {
    series_id: String(s.id || s.series_id || ''),
    title: String(s.title || ''),
    episode_cnt: Number(s.episode_count || s.episode_cnt || 0),
    score: '',
    play_cnt: Number(s.play_count || 0),
    hot: '',
    copyright: '',
    cover: cover(s.cover_url),
    tags: Array.isArray(s.tags) ? s.tags.slice() : (s.category ? [s.category] : []),
    abstract: String(s.description || ''),
    vid: '',
    duration: 0,
    horiz_cover: '',
    author: String(s.author || ''),
    category: String(s.category || ''),
  };
}

/** 把 SDK 榜单条目（可能扁平或嵌套 series）映射成前端 series 对象。 */
function toRankItem(it, i) {
  const src = (it && (it.series || it.item)) || it || {};
  const row = toSeries(src) || {};
  // position 是榜单全局序号；rank 在部分子榜里会并列重复，不能拿来当名次
  row.rank = Number(it && (it.position || it.rank) || (i + 1));
  if (it && it.score !== undefined) row.score = String(it.score);
  if (src.play_count !== undefined) row.play_cnt = Number(src.play_count || 0);
  if (it && it.copyright) row.copyright = String(it.copyright);
  // 官方角标（新剧/预告）、榜单升降、平台推荐行：SDK 有值就原样透传，
  // 前端按需展示；没有就保持 undefined，不占字段。
  if (it && it.tag) row.tag = String(it.tag);
  if (it && it.change && typeof it.change === 'object') {
    row.change = { kind: Number(it.change.kind || 0), places: Number(it.change.places || 0) };
  }
  if (it && it.promoted) row.promoted = true;
  return row;
}

/** SDK Episode -> 前端 episode 对象（vid 就是 episode.id）。 */
function toEpisode(e) {
  if (!e) return null;
  return {
    index: Number(e.number || 0),
    vid: String(e.id || ''),
    title: String(e.title || ('第' + (e.number || 0) + '集')),
    duration: Number(e.duration_seconds || 0),
    cover: cover(e.cover_url),
    comment_count: Number(e.comment_count || 0),
    digged_count: Number(e.digg_count || 0),
    playable: e.playable !== false,
  };
}

/** 分集分页：SDK 一次一页，这里翻到拿满 limit 或到底。 */
async function allEpisodes(seriesId, limit) {
  const cap = limit > 0 ? limit : 100000;
  const out = [];
  let cursor = '';
  let pages = 0;
  while (pages < 200 && out.length < cap) {
    const opts = cursor ? { cursor } : {};
    const page = await Ohg.listEpisodes(String(seriesId), opts);
    for (const e of (page.items || [])) out.push(toEpisode(e));
    pages++;
    if (!page.has_more || !page.cursor || (page.items || []).length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

/** 搜索分页：用 searchAll 去重翻页，凑够 limit。 */
async function searchItems(query, limit, filters, fast) {
  const cap = limit > 0 ? limit : 20;
  const out = [];
  const opts = {};
  if (Array.isArray(filters) && filters.length > 0) opts.filters = filters;
  const raw = [];
  // 上游搜索翻页极慢（实测 10条3.6s / 20条7.3s / 30条11.2s，第4页单页就要20s，
  // 40条要31.5s），用户会以为搜索卡死。限制 2 页（约20条）把首屏压到 7s 内；
  // fast=1（联想补封面）只取 1 页，尽快出带封面的卡片。
  for await (const s of Ohg.searchAll(String(query), opts, { maxPages: fast ? 1 : 2 })) {
    raw.push(s);
    if (raw.length >= cap) break;
  }
  // SDK 的搜索结果不带封面/标签/热度，用 getSeriesBatch 一次批量补齐（避免逐部 getSeries）。
  const items = await enrichByBatch(raw);
  // 搜索结果会混入话题/UGC 条目（无 series_id、补不到封面），它们不可播放，
  // 直接过滤，否则前端会出现一整片空白封面的卡片。
  return items.filter((x) => x && x.series_id && x.cover);
}

/**
 * 用 getSeriesBatch 给只有 id 的条目补封面/标签/简介/热度。
 * SDK 返回顺序不保证与入参一致，必须按 id 归位，否则封面和热度会串到别的剧上。
 * 返回数组严格与入参等长同序；缺失项用 toSeries(raw) 兜底，绝不返回空数组导致列表塌陷。
 */
async function enrichByBatch(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ids = list.map((s) => String(s && (s.id || s.series_id) || '')).filter((x) => x !== '');
  if (ids.length === 0) return list.map((s) => toSeries(s));
  try {
    const rows = await Ohg.getSeriesBatch(ids);
    const byId = new Map();
    (rows || []).forEach((d) => {
      const s = (d && d.series) || {};
      const id = String(s.id || s.series_id || '');
      if (!id) return;
      const row = toSeries(s);
      const detailRows = Array.isArray(s.rows) ? s.rows : [];
      row.tags = detailRows.filter((r) => r && r.text).map((r) => String(r.text)).slice(0, 8);
      // 热度/播放量：SDK getSeriesBatch 带 heat 与 play_count，前端据此显示与排序
      row.heat = Number(s.heat || (d && d.heat) || 0);
      row.play_cnt = Number(s.play_count || (d && d.play_count) || 0);
      row.hot = formatHeat(row.heat);
      byId.set(id, row);
    });
    return list.map((s) => {
      const id = String(s && (s.id || s.series_id) || '');
      return byId.get(id) || toSeries(s);
    });
  } catch (e) {
    return list.map((s) => toSeries(s));
  }
}

/** SDK 原始 series 列表 -> 带热度的前端 row 列表（统一入口，所有列表都走这里）。 */
async function enrichRows(raw) {
  const list = (Array.isArray(raw) ? raw : []).filter(Boolean);
  if (!list.length) return [];
  return enrichByBatch(list.map((s) => ({ id: s.id || s.series_id || '' })));
}

/**
 * 给已经成形的前端 row 补热度，但保留 row 上的榜单特有字段（rank/score/role/copyright）。
 * 官方榜单必须保持自己的名次和评分，只叠加红果热度值。
 */
async function fillHeat(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return [];
  const enriched = await enrichByBatch(list.map((r) => ({ id: r.id || r.series_id || '' })));
  return list.map((r, i) => {
    const e = enriched[i];
    if (!e || !e.heat) return r;
    return Object.assign({}, r, {
      cover: r.cover || e.cover,
      tags: (Array.isArray(r.tags) && r.tags.length) ? r.tags : e.tags,
      abstract: r.abstract || e.abstract,
      heat: e.heat,
      play_cnt: e.play_cnt || Number(r.play_cnt || 0),
      hot: e.hot,
    });
  });
}

/** 非官方榜单的列表按热度降序；热度相同保持上游原顺序（稳定排序）。 */
function sortByHeat(items) {
  return items.map((x, i) => ({ x, i }))
    .sort((a, b) => (Number(b.x.heat || 0) - Number(a.x.heat || 0)) || (a.i - b.i))
    .map((o) => o.x);
}

/**
 * 用户选了官方排序（最新上架/最高热度/最高收藏/时间范围）时，
 * SDK 已经按该规则排好，绝不能再按 heat 重排，否则三个选项看起来完全一样。
 * 只有默认「全部推荐」才按红果热度降序。
 */
function hasOfficialSort(sel) {
  if (!sel || typeof sel !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(sel, 'sort')
    || Object.prototype.hasOwnProperty.call(sel, 'online_time');
}
async function orderItems(raw, sel) {
  const enriched = await enrichRows(raw);
  return hasOfficialSort(sel) ? enriched : sortByHeat(enriched);
}

/**
 * 给分类列表补展示名次，前端据此显示 TOP1/TOP2 角标。
 * 默认（无官方排序）已经按热度降序，名次即热度排名；选了官方排序则按展示顺序编号。
 * rankOffset 用于翻页续号，让第 2 页从 31 开始而不是又从 1 开始。
 */
function withRank(items, rankOffset) {
  const start = Number(rankOffset) > 0 ? Number(rankOffset) : 0;
  return items.map((x, i) => Object.assign({}, x, { rank: start + i + 1 }));
}

/* ---------------- 搜索 / 发现 ---------------- */

async function search(query, limit, filters, fast) {
  const items = await searchItems(query, limit, filters, fast);
  return {
    query: String(query),
    count: items.length,
    results: items,
    has_more: items.length >= (limit > 0 ? limit : 30),
    next_offset: items.length,
  };
}

async function suggest(prefix) {
  const rows = await Ohg.suggest(String(prefix || ''));
  return (rows || []).map((r) => (typeof r === 'string' ? r : String(r.text || r.keyword || '')))
    .filter((s) => s !== '');
}

async function hotSearch() {
  const h = await Ohg.hotSearch();
  const flat = (arr) => (Array.isArray(arr) ? arr : []).map((x) =>
    (typeof x === 'string' ? x : (x.word || x.text || x.title || ''))).filter((s) => s !== '');
  // rows 保留官方角标（新剧/预告）与名次；items 继续给字符串，兼容旧调用方。
  const rows = (arr) => (Array.isArray(arr) ? arr : []).map((x) => {
    if (typeof x === 'string') return { title: x };
    return {
      title: String(x.title || x.word || x.text || ''),
      series_id: String(x.series_id || ''),
      tag: x.tag ? String(x.tag) : '',
      position: Number(x.position || 0),
      heat: String(x.heat || ''),
      score: String(x.search_score || ''),
    };
  }).filter((x) => x.title);
  return {
    guesses: flat(h && h.guesses),
    boards: (h && Array.isArray(h.boards) ? h.boards : []).map((b) => {
      const list = rows(b.items || b.words || b.list);
      return {
        name: String(b.name || b.title || ''),
        items: list.map((x) => x.title),
        rows: list,
      };
    }),
  };
}

async function searchCues() {
  const rows = await Ohg.searchCues();
  return (rows || []).map((s) => String(s)).filter((s) => s !== '');
}

async function discover(limit) {
  const cap = limit > 0 ? limit : 30;
  const out = [];
  const raw = [];
  for await (const s of Ohg.discoverAll({}, { maxPages: 10 })) {
    raw.push(s);
    if (raw.length >= cap) break;
  }
  const items = sortByHeat(await enrichByBatch(raw));
  return { count: items.length, items, has_more: items.length >= cap, next_offset: items.length };
}

async function newReleases(query) {
  const page = await Ohg.newReleases(query || {});
  const rawItems = Array.isArray(page.items) ? page.items : [];
  const enriched = await enrichRows(rawItems.map((n) => n.series || n));
  const items = rawItems.map((n, i) => ({
    date: String(n.date || page.date || ''),
    series: enriched[i] || toSeries(n.series || n),
    reason: String(n.reason || n.label || ''),
  }));
  return { date: page.date || '', dates: page.dates || [], count: items.length, items,
    has_more: page.has_more === true, next_offset: 0 };
}

/* ---------------- 详情 / 分集 / 弹幕 / 全季 ---------------- */

async function detail(seriesId) {
  const [s, eps] = await Promise.all([
    Ohg.getSeries(String(seriesId)),
    allEpisodes(seriesId, 0),
  ]);
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const category = rows.filter((r) => r && (r.kind === 3 || r.text))
    .map((r) => String(r.text || '')).filter((t) => t !== '');
  // 演员：SDK 把 actor_ids 藏在 kind=33 行的 schema client_extra 里，
  // 解开后前端就能点演员名进主页看他的全部作品。
  const celebrities = [];
  rows.filter((r) => r && r.kind === 33).forEach((r) => {
    let ids = [];
    try {
      const u = new URL(String(r.schema || ''));
      const extra = JSON.parse(u.searchParams.get('client_extra') || '{}');
      if (Array.isArray(extra.actor_ids)) ids = extra.actor_ids;
    } catch (e) { /* schema 解析失败就跳过这行 */ }
    const names = String(r.text || '').replace(/^演员·/, '')
      .split(/[\s、,，]+/).filter((t) => t !== '');
    ids.forEach((id, i) => celebrities.push({ user_id: String(id), name: names[i] || '' }));
  });
  return {
    meta: {
      series_id: String(s.id || seriesId),
      title: String(s.title || ''),
      abstract: String(s.description || ''),
      cover: cover(s.cover_url),
      episode_cnt: Number(s.episode_count || eps.length || 0),
      status: String(s.right_text || (s.status === 1 ? '完结' : '连载中')),
      play_cnt: Number(s.play_count || 0),
      heat: Number(s.heat || 0),
      hot: formatHeat(s.heat),
      followed_cnt: Number(s.follow_count || 0),
      create_time: s.created_at ? Math.floor(new Date(s.created_at).getTime() / 1000) : 0,
      category,
      tags: category.slice(),
      celebrities,
      album_id: String(s.related_album_id || ''),
      season_index: Number(s.season_index || 0),
      is_multi_season: s.is_multi_season === true,
      content_type: Number(s.content_type || 0),
      platform: Number(s.platform || 0),
      novel: s.novel || null,
    },
    episodes: eps,
  };
}

async function episodes(seriesId, limit) {
  const d = await detail(seriesId);
  return { meta: d.meta, episodes: limit > 0 ? d.episodes.slice(0, limit) : d.episodes };
}

async function batch(seriesIds) {
  const ids = (Array.isArray(seriesIds) ? seriesIds : []).map(String).filter((s) => s !== '');
  const rows = await Ohg.getSeriesBatch(ids);
  return { count: rows.length, items: rows.map((d) => ({
    meta: {
      series_id: String(d.series.id || ''), title: String(d.series.title || ''),
      cover: cover(d.series.cover_url), episode_cnt: Number(d.series.episode_count || 0),
      heat: Number(d.series.heat || 0), hot: formatHeat(d.series.heat),
    },
    episodes: (d.episodes || []).map(toEpisode),
  })) };
}

async function danmaku(seriesId, episodeId, limit) {
  const rows = [];
  let cursor = '';
  let pages = 0;
  const cap = limit > 0 ? limit : 1200;
  let total = 0;
  while (pages < 200 && rows.length < cap) {
    const opts = { pageSize: Math.min(cap, 500) };
    if (cursor) opts.cursor = cursor;
    const page = await Ohg.listDanmaku(String(seriesId), String(episodeId), opts);
    if (page.total) total = Number(page.total);
    for (const d of (page.items || [])) {
      rows.push({ id: String(d.id || ''), text: String(d.text || ''),
        time: Number(d.offset_ms || 0) / 1000, offset_ms: Number(d.offset_ms || 0),
        color: '#FFFFFF', mode: 'scroll' });
    }
    pages++;
    if (!page.has_more || !page.cursor || (page.items || []).length === 0) break;
    cursor = page.cursor;
  }
  const truncated = rows.length >= cap;
  return {
    success: true, source: 'openhongguo', series_id: String(seriesId), episode_id: String(episodeId),
    items: rows, count: rows.length, total, truncated,
    notice: truncated ? ('弹幕较多，本次仅载入前 ' + rows.length + ' 条') : '',
  };
}

/** 全季：SDK seasons() 是权威数据，全收，按 index 排序。 */
async function seasons(seriesId) {
  const album = await Ohg.seasons(String(seriesId));
  const items = (album.seasons || []).map((s) => ({
    series_id: String(s.series_id || ''),
    title: String(s.title || ''),
    cover: cover(s.cover_url),
    episode_cnt: Number(s.episode_count || 0),
    season_index: Number(s.index || 0),
    season: '第' + (s.index || 0) + '季',
    status: s.status,
    upcoming: !(s.status === 1 || (s.episode_count || 0) > 0),
    content_type: 1004,
  })).sort((a, b) => a.season_index - b.season_index);
  return { ok: true, series_id: String(seriesId), album_id: String(album.id || ''),
    season_count: Number(album.season_count || items.length), items };
}

async function album(albumId) {
  const a = await Ohg.getAlbum(String(albumId));
  return { id: String(a.id || ''), title: String(a.title || ''),
    season_count: Number(a.season_count || 0),
    seasons: (a.seasons || []).map((s) => ({
      series_id: String(s.series_id || ''), title: String(s.title || ''),
      cover: cover(s.cover_url), episode_cnt: Number(s.episode_count || 0),
      season_index: Number(s.index || 0),
    })) };
}

async function recommend(seriesId) {
  const r = await Ohg.seriesRecommend(String(seriesId));
  const items = sortByHeat(await enrichRows(r.items || []));
  return { title: String(r.cell_title || ''), items };
}

/* ---------------- 榜单 / 筛选 / 分类 ---------------- */

// 前端短名 -> 官方榜单 ID。hot 必须映射到真正的「热播榜」，
// 旧的空参数拿到的是「推荐榜」，两者内容不同，这是"榜单剧看着乱"的根因。
const BOARD_ALIAS = {
  recommend: 'ranklist_hot_sc', hot: 'ranklist_hot_play_sc', new: 'ranklist_new_rank_sc',
  prestige: 'ranklist_prestige', subscribe: 'ranklist_subscribe',
  search: 'ranklist_hot_search_sc', chase: 'ranklist_chase_update',
  must: 'ranklist_must_watch', followed: 'ranklist_followed',
};

/** 榜单分组元数据：5 个分类 × 若干官方子榜，供前端做二级切换。带 10 分钟缓存。 */
let rankMetaCache = null;
let rankMetaAt = 0;
async function rankMeta() {
  if (rankMetaCache && Date.now() - rankMetaAt < 10 * 60e3) return rankMetaCache;
  const r = await Ohg.shortRank({});
  rankMetaCache = {
    contents: (r.contents || []).map((c) => ({
      id: String(c.id || ''), name: String(c.name || ''),
      boards: (c.boards || []).map((b) => ({
        id: String(b.id || ''), name: String(b.name || ''), selected: b.selected === true,
      })),
    })),
    default_content: String(r.content || 'all'), default_board: String(r.board || ''),
  };
  rankMetaAt = Date.now();
  return rankMetaCache;
}

async function rank(board, limit, offset, content, cursor) {
  // 官方榜单保持上游名次顺序，只叠加红果热度值，不自行重排。
  // board 既可是前端短名（hot/recommend/…），也可是官方 ID（ranklist_hot_play_sc）。
  const b = String(board || 'hot');
  const boardId = BOARD_ALIAS[b] || b;
  const q = { board: boardId };
  if (content && content !== 'all') q.content = String(content);
  if (cursor) q.cursor = String(cursor);
  const r = await Ohg.shortRank(q);
  let items = await fillHeat((r.items || []).map(toRankItem));
  const off = Number(offset || 0);
  // cursor 翻页时上游已定位，不能再按 offset 切；只有旧式 offset 模式才切片。
  if (!cursor && off > 0) items = items.slice(off);
  if (limit > 0) items = items.slice(0, limit);
  // 从 contents 里找当前榜单的显示名，找不到则用短名
  let label = b;
  for (const c of (r.contents || [])) {
    const hit = (c.boards || []).find((x) => String(x.id) === boardId);
    if (hit) { label = String(hit.name || b); break; }
  }
  return { board: boardId, name: label,
    content: String(r.content || content || 'all'), board_id: String(r.board || boardId),
    contents: (r.contents || []).map((c) => ({
      id: String(c.id || ''), name: String(c.name || ''),
      boards: (c.boards || []).map((x) => ({ id: String(x.id || ''), name: String(x.name || '') })),
    })),
    items, has_more: r.has_more === true,
    next_offset: cursor ? off : off + items.length, cursor: String(r.cursor || '') };
}

async function rankGroups() {
  const rows = await Ohg.rankGroups();
  return { groups: (rows || []).map((r) => ({ id: String(r.id || ''),
    name: String(r.name || ''), type: r.type, size: r.size })) };
}

async function rankRows(cellId, offset, limit) {
  const r = await Ohg.rankRows(String(cellId), Number(offset || 0));
  let items = await fillHeat((r.items || []).map(toRankItem));
  if (limit > 0) items = items.slice(0, limit);
  return { items, has_more: r.has_more === true, next_offset: Number(r.next_offset || 0),
    list_name: String(r.list_name || '') };
}

async function ranking(activityId, rankListId, limit) {
  const r = await Ohg.ranking(String(activityId), String(rankListId));
  let items = await fillHeat((r.items || []).map(toRankItem));
  if (limit > 0) items = items.slice(0, limit);
  return { list_name: String(r.list_name || ''), items, has_more: r.has_more === true,
    next_offset: Number(r.next_offset || 0),
    lists: (r.lists || []).map((x) => ({ id: String(x.id || ''), name: String(x.name || '') })) };
}

async function filterPanel(genre) {
  const rows = await Ohg.shortFilterPanel(genre ? String(genre) : undefined);
  return { genre: String(genre || ''), name: '筛选',
    rows: (rows || []).map((r) => ({ key: String(r.key || ''), name: String(r.name || ''),
      options: (r.options || []).map((o) => ({ value: String(o.value || o.key || ''),
        label: String(o.name || o.label || '') })) })) };
}

async function shortFilter(query, limit) {
  const page = await Ohg.shortFilter(query || {});
  const raw = (page.items || []).slice(0, limit > 0 ? limit : 30);
  const items = await orderItems(raw, query && query.selections);
  return { count: items.length, items, has_more: page.has_more === true,
    next_offset: 0, cursor: String(page.cursor || '') };
}

/** 首页分类频道（real/comic/ai）分页：映射到 SDK shortFilter 的三个 genre。 */
const CHANNEL_GENRE = { real: 'short_play', comic: 'comic_series', ai: 'ai_series' };

/** 频道游标缓存：分页时用上一页 cursor 续取，避免每页从头翻（大幅提速）。 */
const catalogCursors = new Map();

async function catalog(channel, pageNum, perPage, selections) {
  const ch = String(channel || 'real');
  const genre = CHANNEL_GENRE[ch] || 'short_play';
  const size = perPage > 0 ? perPage : 30;
  const page = Number(pageNum) > 0 ? Number(pageNum) : 1;
  const sel = (selections && typeof selections === 'object' && !Array.isArray(selections))
    ? selections : {};
  const q = { selections: Object.assign({ genre: [genre] }, sel) };

  // 单页请求（首页首屏只需 10 张）：默认补热度后按热度降序，让首页 tab 显示
  // 本体裁最热的剧；一旦用户选了官方排序则完全尊重 SDK 的顺序。
  if (size <= 18) {
    const r = await Ohg.shortFilter(q);
    const finalItems = withRank(await orderItems(r.items || [], sel), 0);
    const names = { real: '真人剧', comic: 'AI漫剧', ai: 'AI短剧' };
    return { channel: ch, name: names[ch] || ch, page, total_pages: 999,
      has_more: r.has_more === true, items: finalItems.slice(0, size) };
  }

  // 多页请求（分类页滚动）：用缓存的游标续取，一次 SDK 调用拿一页。
  // ⚠️ 关键：shortFilter 返回的 cursor 指向「下一页」，必须存到 page+1 的 key。
  // 旧代码存回当前 page，导致下次重新点进分类（page=1）读到第 2 页的游标，
  // 每点一次就往后跳一页——这正是「每次点击都刷新出不一样的剧」的根因。
  const selKey = JSON.stringify(sel);
  const keyPrefix = ch + ':' + selKey + ':';
  const cursor = catalogCursors.get(keyPrefix + page);
  if (cursor) q.cursor = cursor;
  const r = await Ohg.shortFilter(q);
  const finalItems = withRank(await orderItems(r.items || [], sel), (page - 1) * size).slice(0, size);
  // 只缓存"下一页"入口；page=1 永远没有预置游标，重新进入必从第一页开始。
  if (r.cursor) catalogCursors.set(keyPrefix + (page + 1), r.cursor);
  const names = { real: '真人剧', comic: 'AI漫剧', ai: 'AI短剧' };
  return { channel: ch, name: names[ch] || ch, page, total_pages: 999,
    has_more: r.has_more === true, items: finalItems };
}

async function categories(categoryId) {
  const page = await Ohg.categories(String(categoryId || ''));
  return { category_id: String(page.category_id || ''), category_name: String(page.category_name || ''),
    description: String(page.description || ''),
    tabs: (page.tabs || []).map((t) => ({ value: t.value, name: String(t.name || '') })),
    default_tab: page.default_tab,
    filters: (page.filters || []).map((r) => ({ key: String(r.key || ''), name: String(r.name || ''),
      options: (r.options || []).map((o) => ({ value: String(o.value || o.key || ''),
        label: String(o.name || o.label || '') })) })) };
}

async function categoryLanding(categoryId, options, limit) {
  const page = await Ohg.categoryLanding(String(categoryId || ''), options || {});
  const raw = (page.items || []).slice(0, limit > 0 ? limit : 30);
  const items = sortByHeat(await enrichRows(raw));
  return { category_id: String(page.category_id || ''), category_name: String(page.category_name || ''),
    tabs: (page.tabs || []).map((t) => ({ value: t.value, name: String(t.name || '') })),
    filters: (page.filters || []).map((r) => ({ key: String(r.key || ''), name: String(r.name || '') })),
    count: items.length, items, has_more: page.has_more === true,
    next_offset: Number(page.next_offset || 0) };
}

async function person(userId) {
  const p = await Ohg.person(String(userId));
  return { user_id: String(p.user_id || ''), name: String(p.name || ''),
    description: String(p.description || ''), avatar: String(p.avatar_url || ''),
    tags: p.tags || [], labels: p.labels || [],
    followers: Number(p.followers || 0), likes: Number(p.likes || 0) };
}

/**
 * 演员榜：同时给出 actor_id（详情 client_extra.actor_ids 里的值）与 user_id
 * （person / personWorks 真正需要的账号 id）。详情里拿到的是 actor_id，
 * 直接传给 personWorks 只会得到占位名和空作品，必须先经此映射。
 */
let celebritiesCache = null;
let celebritiesAt = 0;
const CELEB_TTL = 30 * 60 * 1000;
async function celebrities() {
  if (celebritiesCache && Date.now() - celebritiesAt < CELEB_TTL) return celebritiesCache;
  const r = await Ohg.shortRank({ content: 'ranklist_celebrity', board: '', cursor: '' });
  const items = (r.items || []).filter((it) => it && (it.actor_id || it.user_id)).map((it) => ({
    actor_id: String(it.actor_id || ''), user_id: String(it.user_id || ''),
    name: String(it.actor || ''), avatar: String(it.avatar_url || ''),
    score: String(it.score || ''), position: Number(it.position || 0),
    // 演员榜的名次变动（0新上榜/1上升/2下降/3不变）
    change: it.change && typeof it.change === 'object'
      ? { kind: Number(it.change.kind || 0), places: Number(it.change.places || 0) }
      : null,
  }));
  celebritiesCache = { items, count: items.length };
  celebritiesAt = Date.now();
  return celebritiesCache;
}

async function personWorks(userId, cursor, limit) {
  const page = await Ohg.personWorks(String(userId), cursor || '');
  const raw = Array.isArray(page.items) ? page.items : [];
  const enriched = await enrichRows(raw);
  let items = enriched.map((row, i) => Object.assign({}, row, {
    role: String(raw[i] && raw[i].role || ''),
  }));
  if (limit > 0) items = items.slice(0, limit);
  return { items, has_more: page.has_more === true, next_offset: String(page.cursor || '') };
}

module.exports = {
  toSeries, toEpisode,
  search, suggest, hotSearch, searchCues, discover, newReleases,
  detail, episodes, batch, danmaku, seasons, album, recommend,
  rank, rankMeta, rankGroups, rankRows, ranking,
  filterPanel, shortFilter, catalog, categories, categoryLanding,
  person, personWorks, celebrities,
};

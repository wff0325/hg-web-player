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
  row.rank = Number(it && (it.rank || it.position) || (i + 1));
  if (it && it.score !== undefined) row.score = String(it.score);
  if (src.play_count !== undefined) row.play_cnt = Number(src.play_count || 0);
  if (it && it.copyright) row.copyright = String(it.copyright);
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
async function searchItems(query, limit, filters) {
  const cap = limit > 0 ? limit : 30;
  const out = [];
  const opts = {};
  if (Array.isArray(filters) && filters.length > 0) opts.filters = filters;
  const raw = [];
  for await (const s of Ohg.searchAll(String(query), opts, { maxPages: 20 })) {
    raw.push(s);
    if (raw.length >= cap) break;
  }
  // SDK 的搜索结果不带封面/标签，用 getSeriesBatch 一次批量补齐（避免逐部 getSeries）。
  const enriched = await enrichByBatch(raw);
  return raw.map((s, i) => enriched[i] || toSeries(s));
}

/** 用 getSeriesBatch 给只有 id 的搜索结果补封面/标签/简介。失败时返回空数组，调用方回退。 */
async function enrichByBatch(raw) {
  const ids = raw.map((s) => String(s && (s.id || s.series_id) || '')).filter((x) => x !== '');
  if (ids.length === 0) return [];
  try {
    const rows = await Ohg.getSeriesBatch(ids);
    return (rows || []).map((d) => {
      const s = (d && d.series) || {};
      const row = toSeries(s);
      const detailRows = Array.isArray(s.rows) ? s.rows : [];
      row.tags = detailRows.filter((r) => r && r.text).map((r) => String(r.text)).slice(0, 8);
      return row;
    });
  } catch (e) {
    return [];
  }
}

/* ---------------- 搜索 / 发现 ---------------- */

async function search(query, limit, filters) {
  const items = await searchItems(query, limit, filters);
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
  return {
    guesses: flat(h && h.guesses),
    boards: (h && Array.isArray(h.boards) ? h.boards : []).map((b) => ({
      name: String(b.name || b.title || ''),
      items: flat(b.items || b.words || b.list),
    })),
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
  const enriched = await enrichByBatch(raw);
  const items = raw.map((s, i) => enriched[i] || toSeries(s));
  return { count: items.length, items, has_more: items.length >= cap, next_offset: items.length };
}

async function newReleases(query) {
  const page = await Ohg.newReleases(query || {});
  const items = (page.items || []).map((n) => ({
    date: String(n.date || page.date || ''),
    series: toSeries(n.series || n),
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
  return {
    meta: {
      series_id: String(s.id || seriesId),
      title: String(s.title || ''),
      abstract: String(s.description || ''),
      cover: cover(s.cover_url),
      episode_cnt: Number(s.episode_count || eps.length || 0),
      status: String(s.right_text || (s.status === 1 ? '完结' : '连载中')),
      play_cnt: Number(s.play_count || 0),
      followed_cnt: Number(s.follow_count || 0),
      create_time: s.created_at ? Math.floor(new Date(s.created_at).getTime() / 1000) : 0,
      category,
      tags: category.slice(),
      celebrities: [],
      album_id: String(s.related_album_id || ''),
      season_index: Number(s.season_index || 0),
      is_multi_season: s.is_multi_season === true,
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
  return { title: String(r.cell_title || ''), items: (r.items || []).map(toSeries) };
}

/* ---------------- 榜单 / 筛选 / 分类 ---------------- */

const BOARD_MAP = {
  recommend: '', hot: '', new: '',
};

async function rank(board, limit, offset) {
  // SDK shortRank 提供短剧榜（含演员榜）；rankRows/ranking 提供书城经典榜。
  // 先按短剧榜取，前端 board=hot/recommend/new 映射到查询参数。
  const q = {};
  const r = await Ohg.shortRank(q);
  let items = (r.items || []).map(toRankItem);
  const off = Number(offset || 0);
  if (off > 0) items = items.slice(off);
  if (limit > 0) items = items.slice(0, limit);
  return { board: String(board || 'hot'), name: String(board === 'new' ? '上新榜' : '热播榜'),
    items, has_more: r.has_more === true, next_offset: off + items.length };
}

async function rankGroups() {
  const rows = await Ohg.rankGroups();
  return { groups: (rows || []).map((r) => ({ id: String(r.id || ''),
    name: String(r.name || ''), type: r.type, size: r.size })) };
}

async function rankRows(cellId, offset, limit) {
  const r = await Ohg.rankRows(String(cellId), Number(offset || 0));
  let items = (r.items || []).map(toRankItem);
  if (limit > 0) items = items.slice(0, limit);
  return { items, has_more: r.has_more === true, next_offset: Number(r.next_offset || 0),
    list_name: String(r.list_name || '') };
}

async function ranking(activityId, rankListId, limit) {
  const r = await Ohg.ranking(String(activityId), String(rankListId));
  let items = (r.items || []).map(toRankItem);
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
  const items = (page.items || []).slice(0, limit > 0 ? limit : 30).map(toSeries);
  return { count: items.length, items, has_more: page.has_more === true,
    next_offset: 0, cursor: String(page.cursor || '') };
}

/** 首页分类频道（real/comic/ai）分页：映射到 SDK shortFilter 的三个 genre。 */
const CHANNEL_GENRE = { real: 'short_play', comic: 'comic_series', ai: 'ai_series' };
async function catalog(channel, pageNum, perPage) {
  const ch = String(channel || 'real');
  const genre = CHANNEL_GENRE[ch] || 'short_play';
  const size = perPage > 0 ? perPage : 30;
  const want = (Number(pageNum) > 0 ? Number(pageNum) : 1) * size;
  const out = [];
  let cursor = '';
  let guard = 0;
  while (out.length < want && guard < 20) {
    const q = { selections: { genre: [genre] } };
    if (cursor) q.cursor = cursor;
    const r = await Ohg.shortFilter(q);
    for (const s of (r.items || [])) out.push(toSeries(s));
    guard++;
    if (!r.has_more || !r.cursor || (r.items || []).length === 0) break;
    cursor = r.cursor;
  }
  const start = want - size;
  const items = out.slice(Math.max(0, start), want);
  const enriched = await enrichByBatch(items.map((x) => ({ id: x.series_id })));
  const finalItems = items.map((x, i) => enriched[i] || x);
  const names = { real: '真人剧', comic: 'AI漫剧', ai: 'AI短剧' };
  return { channel: ch, name: names[ch] || ch, page: Number(pageNum) > 0 ? Number(pageNum) : 1,
    total_pages: 999, has_more: out.length >= want, items: finalItems };
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
  const items = (page.items || []).slice(0, limit > 0 ? limit : 30).map(toSeries);
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

async function personWorks(userId, cursor, limit) {
  const page = await Ohg.personWorks(String(userId), cursor || '');
  let items = (page.items || []).map((w) => ({
    series_id: String(w.series_id || w.id || ''), title: String(w.title || ''),
    cover: cover(w.cover_url), episode_cnt: Number(w.episode_count || 0),
    role: String(w.role || ''),
  }));
  if (limit > 0) items = items.slice(0, limit);
  return { items, has_more: page.has_more === true, next_offset: String(page.cursor || '') };
}

module.exports = {
  toSeries, toEpisode,
  search, suggest, hotSearch, searchCues, discover, newReleases,
  detail, episodes, batch, danmaku, seasons, album, recommend,
  rank, rankGroups, rankRows, ranking,
  filterPanel, shortFilter, catalog, categories, categoryLanding,
  person, personWorks,
};

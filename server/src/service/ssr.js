'use strict';
/**
 * 官网 SSR 数据源（对应 minireel 的 HongguoWebFallback）。
 *
 * 为什么需要：App 的 search/tab/v 分类接口对 device_id 敏感、易被风控，
 * 官网分类页 /category/<route>?page=N 是服务端渲染的，免签名、稳定、字段齐全。
 * 本模块只做「取 HTML -> 抠 _ROUTER_DATA -> 归一化」三件事。
 */
const Http = require('../util/http');

const BASE = 'https://hongguoduanju.com';
const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Mobile Safari/537.36';

/** 频道 -> 官网路由（与 minireel DramaChannel.route 一致）。 */
const CHANNELS = {
  real: { route: 'real-drama', name: '真人剧' },
  comic: { route: 'comic-drama', name: '漫剧' },
  ai: { route: 'ai-drama', name: 'AI剧' },
  animation: { route: 'comic', name: '动漫' },
};

/** 抠出 window._ROUTER_DATA 的 JSON 对象（按括号配平，跳过字符串内的括号）。 */
function routerData(html) {
  const m = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(html);
  if (!m || html[m.index + m[0].length] !== '{') throw new Error('剧库数据暂时不可用');
  const start = m.index + m[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      return JSON.parse(html.substring(start, i + 1));
    }
  }
  throw new Error('剧库数据格式变化');
}

/** 从 loaderData 里按前缀取第一个非空对象。 */
function loader(data, prefixes) {
  const all = (data && data.loaderData) || {};
  for (const key of Object.keys(all)) {
    if (prefixes.some((p) => key.startsWith(p))) {
      const v = all[key];
      if (v && typeof v === 'object') return v;
    }
  }
  return {};
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

function text(v, keys, fallback = '') {
  for (const k of keys) {
    const val = v && v[k];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number') return String(val);
  }
  return fallback;
}

function tags(v) {
  const raw = v && v.tags;
  if (Array.isArray(raw)) {
    return raw.map((x) => (x && typeof x === 'object' ? text(x, ['name', 'tag_name', 'text']) : String(x)))
      .map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') return raw.split(/[,/，、]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 官网一条剧 -> 前端统一结构。 */
function normalize(row) {
  const video = (row && row.video_data) || {};
  const d = Object.assign({}, row || {}, video);
  const sid = text(d, ['series_id_str', 'series_id', 'keyword']);
  if (!sid) return null;
  return {
    series_id: sid,
    title: text(d, ['series_title', 'series_name', 'title', 'name'], sid),
    cover: text(d, ['series_cover', 'cover']),
    abstract: text(d, ['series_intro', 'video_desc']),
    episode_cnt: Number(text(d, ['episode_cnt'], '0')) || 0,
    remark: text(d, ['episode_right_text']),
    tags: tags(d),
    category: text(d, ['category_name', 'category']),
    score: text(d, ['score']),
    play_cnt: Number(text(d, ['series_play_cnt', 'play_cnt'], '0')) || 0,
  };
}

async function fetchHtml(url) {
  const res = await Http.send({
    url,
    method: 'GET',
    timeoutMs: 15000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: BASE + '/' },
  });
  if (res.status !== 200) throw new Error('官网 HTTP ' + res.status);
  return res.text();
}

/**
 * 分类列表。
 * @param {string} channel real|comic|ai|animation
 * @param {number} page 1 起
 */
async function catalog(channel, page) {
  const ch = CHANNELS[channel] || CHANNELS.real;
  const p = Math.max(1, Math.min(200, Number(page) || 1));
  const html = await fetchHtml(`${BASE}/category/${ch.route}?page=${p}`);
  const data = routerData(html);
  const pageData = loader(data, ['category_page', 'category_']);
  const rows = asList(pageData.recommendList);
  const items = rows.map(normalize).filter(Boolean);
  const pg = pageData.pagination || {};
  const totalPages = Number(pg.totalPages) || 0;
  return {
    channel,
    name: ch.name,
    page: p,
    total_pages: totalPages,
    has_more: totalPages ? p < totalPages : items.length >= 20,
    items,
  };
}

/**
 * 官网榜单（App 榜单接口失效时的兜底）。
 * 榜单数据不在 loaderData 里，而在 data-fn-name="r" 的 script 标签 data-fn-args 中。
 */
async function rank(board, page) {
  const map = {
    hot: 'hot-drama', real: 'hot-real-drama', comic: 'hot-comic-drama', ai: 'hot-ai-drama',
  };
  const path = map[board] || map.hot;
  const p = Math.max(1, Math.min(200, Number(page) || 1));
  const html = await fetchHtml(`${BASE}/rank/${path}?page=${p}`);
  let rows = null;
  const re = /<script\b[^>]*?data-fn-name="r"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const arg = /data-fn-args=(?:"([^"]*)"|'([^']*)')/.exec(m[0]);
    if (!arg) continue;
    let args;
    try { args = JSON.parse(decodeEntities(arg[1] || arg[2] || '')); } catch { continue; }
    if (Array.isArray(args) && typeof args[0] === 'string' && args[0].indexOf('rank_') === 0
      && args[1] === 'content' && args[2] && Array.isArray(args[2].rankList)) {
      rows = args[2].rankList;
      break;
    }
  }
  if (!rows) {
    const data = routerData(html);
    const key = Object.keys((data && data.loaderData) || {}).find((k) => k.indexOf('rank_') === 0) || '';
    rows = asList(((data.loaderData || {})[key] || {}).content && data.loaderData[key].content.rankList);
  }
  return {
    board,
    page: p,
    items: (rows || []).map((r) => normalize(Object.assign({}, r, {
      series_id: r.seriesId || r.id,
      series_title: r.title,
      series_cover: r.cover || r.series_cover,
      series_intro: r.description,
      series_play_cnt: r.playCnt,
      episode_right_text: r.heatText,
    }))).filter(Boolean),
  };
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|amp|lt|gt);/g, (all, ent) => {
    const named = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
    if (named[ent]) return named[ent];
    const code = ent[1] === 'x' || ent[1] === 'X'
      ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : all;
  });
}

/**
 * 剧集详情 + 分集列表（官网 SSR，稳定且字段完整）。
 * 返回 { meta, episodes:[{index, vid}] }，与 App 接口 /episodes 结构对齐。
 */
async function detail(seriesId) {
  const sid = String(seriesId || '').trim();
  if (!/^\d{1,32}$/.test(sid)) throw new Error('剧集编号无效');
  const html = await fetchHtml(`${BASE}/detail?series_id=${sid}`);
  const data = routerData(html);
  const pageData = loader(data, ['detail_page', 'detail_']);
  const sd = pageData.seriesDetail || {};
  if (!sd || Object.keys(sd).length === 0) throw new Error('暂时无法获取这部短剧的分集');
  const returned = text(sd, ['series_id']);
  if (returned && returned !== sid) throw new Error('未返回所选短剧');

  const vids = asList(sd.vid_list);
  const episodes = [];
  const seen = new Set();
  vids.forEach((v, i) => {
    const vid = typeof v === 'object' && v !== null
      ? text(v, ['vid', 'video_id', 'id']) : String(v || '').trim();
    if (!/^\d{1,32}$/.test(vid) || seen.has(vid)) return;
    seen.add(vid);
    episodes.push({ index: i + 1, vid, title: '', duration: 0, cover: '' });
  });
  if (!episodes.length) throw new Error('这部短剧暂时没有可播放的分集');

  const base = normalize(Object.assign({}, sd, { episode_cnt: episodes.length }));
  return {
    meta: {
      series_id: sid,
      title: base.title,
      abstract: base.abstract,
      cover: base.cover,
      episode_cnt: episodes.length,
      status: base.remark || '',
      play_cnt: base.play_cnt,
      category: base.tags,
      tags: base.tags,
      celebrities: asList(sd.celebrities).map((c) => ({
        演员: text(c, ['nickname', 'name']),
        角色: text(c, ['sub_title', 'role']),
        头像: text(c, ['avatar']),
      })).filter((c) => c.演员),
    },
    episodes,
    source: 'ssr',
  };
}

module.exports = { catalog, rank, detail, CHANNELS, routerData, normalize };

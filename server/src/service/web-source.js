'use strict';
/**
 * 官网网页版数据源（免签）。
 *
 * 对应原 Java service/WebSource.java。
 *
 * 红果短剧官网 hongguoduanju.com 的页面是服务端渲染的：
 *  - /search/{keyword}      内嵌 _ROUTER_DATA.searchList（搜索结果）
 *  - /player/{series_id}    内嵌 vid_list（完整分集 vid 列表）与 series_name
 *
 * 播放直链历史上也在 /player/{sid}/{vid} 页内（main_url，明文 MP4），
 * 但官网改版后 SSR 已不再输出该字段，仅剩 360p 预览 contentUrl
 * （付费集下载即 404），故播放取址不再走官网，统一由 AppSource 负责
 * （见 Stream.videoTrack）。官网数据现仅用于搜索与分集列表。
 *
 * 移植参考：jackotom/hongguo-drama src/native/hongguo.js（GPL-3.0）。
 */
const Http = require('../util/http');
const Json = require('../util/json');
const Log = require('../util/log');

const SITE_ORIGIN = 'https://hongguoduanju.com';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ==================== 公开接口 ====================

/**
 * 官网搜索。
 *
 * @param {string} keyword 关键词
 * @returns {Promise<Array<object>>} 结果列表，每项含 series_id / series_title /
 *   series_intro / cover / episode_cnt；搜索失败或空结果返回空列表
 */
async function search(keyword, maxPagesArg) {
  const out = [];
  const kw = keyword === null || keyword === undefined ? '' : String(keyword).trim();
  if (kw === '') return out;
  const maxPages = Math.max(1, Math.min(maxPagesArg || 3, 5));
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    let list = [];
    let hasMore = false;
    try {
      // 官网搜索页的 XHR 接口：免签（a_bogus 可省）。
      // 一页 10 条且会把同剧各季散落在不同页（第二季常常在第 2 页），
      // 所以按 page 翻几页再合并，否则「持械入宋」只能搜到 9 季。
      const url = SITE_ORIGIN + '/api/search/result?aid=8662&query='
        + Http.urlencode(kw) + '&page=' + page;
      const res = await Http.send({
        url,
        method: 'GET',
        timeoutMs: 15000,
        headers: {
          'User-Agent': WEB_UA,
          Accept: 'application/json, text/plain, */*',
          Referer: SITE_ORIGIN + '/search/' + Http.urlencode(kw),
        },
      });
      if (res.status !== 200) break;
      const j = Json.optObj(JSON.parse(res.text()));
      if (j === null) break;
      list = Json.optArr(j.searchList);
      hasMore = j.hasMore === true || j.has_more === true;
    } catch (e) {
      Log.warn('官网搜索失败(' + kw + ' p' + page + '): ' + e.message);
      break;
    }
    for (const item of list) {
      const cell = Json.optObj(item);
      if (cell === null) continue;
      let vd = Json.optObj(cell.video_data);
      if (vd === null) vd = cell;
      const sid = Json.optStr(vd.series_id, '');
      if (sid === '' || seen.has(sid)) continue;
      seen.add(sid);
      const row = Json.obj();
      row.series_id = sid;
      row.series_title = Json.optStr(vd.series_title, Json.optStr(cell.name, ''));
      row.series_intro = Json.optStr(vd.series_intro, '');
      row.cover = normalizeVideoUrl(Json.optStr(vd.series_cover, ''));
      row.episode_cnt = Json.optInt(vd.episode_cnt, 0);
      // 标签（官网叫 category_list，如 脑洞/穿越/古代）
      const tags = [];
      for (const c of Json.optArr(vd.category_list)) {
        const cobj = Json.optObj(c) || {};
        const name = Json.optStr(cobj.name, '');
        if (name !== '' && tags.indexOf(name) < 0) tags.push(name);
      }
      row.tags = tags;
      row.remark = Json.optStr(vd.episode_right_text, '');
      out.push(row);
    }
    if (!hasMore || list.length === 0) break;
  }
  return out;
}

/**
 * 官网分集列表。
 *
 * @param {string} seriesId 剧 id
 * @returns {Promise<object|null>} {series_id, series_title, cover, total,
 *   web_accessible_episodes, episodes:[{vid, vid_index, title, web_available}]}；
 *   失败返回 null
 */
async function episodes(seriesId) {
  const sid = seriesId === null || seriesId === undefined ? '' : String(seriesId).trim();
  if (sid === '') return null;
  try {
    const html = await fetchHtml(SITE_ORIGIN + '/player/' + Http.urlencode(sid));
    const m = /"vid_list"\s*:\s*\[([^\]]*)\]/.exec(html);
    if (!m) return null;
    const vids = [];
    for (const s of m[1].split(',')) {
      const v = s.trim().replace(/^"|"$/g, '');
      if (/^\d+$/.test(v)) vids.push(v);
    }
    if (vids.length === 0) return null;

    let title = pickJsonString(html, 'series_name');
    if (title === '') title = '未命名短剧';
    const cover = normalizeVideoUrl(pickJsonString(html, 'series_cover'));
    const am = /"accessible_episode_cnt"\s*:\s*(\d+)/.exec(html);
    const accessible = am ? Math.min(parseInt(am[1], 10), vids.length) : null;

    const eps = [];
    for (let i = 0; i < vids.length; i++) {
      const e = Json.obj();
      e.vid = vids[i];
      e.vid_index = i + 1;
      e.title = '';
      e.series_id = sid;
      e.series_title = title;
      e.cover = cover;
      e.web_available = accessible === null ? true : i < accessible;
      eps.push(e);
    }
    const out = Json.obj();
    out.series_id = sid;
    out.series_title = title;
    out.cover = cover;
    out.total = eps.length;
    out.web_accessible_episodes = accessible === null ? -1 : accessible;
    out.episodes = eps;
    out.source = 'web';
    return out;
  } catch (e) {
    // 不再单独输出日志：调用方（client.getEpisodes）在官网兜底也失败时
    // 会输出汇总日志，此处抛出失败原因供其合并，避免双失败刷成两行
    throw e;
  }
}

// ==================== 内部工具 ====================

/** 拉取官网页面 HTML（桌面 UA + 站内 Referer）。 */
async function fetchHtml(url) {
  const res = await Http.send({
    url,
    method: 'GET',
    timeoutMs: 30000,
    headers: {
      'User-Agent': WEB_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: SITE_ORIGIN + '/',
    },
  });
  if (!res.ok()) throw new Error('HTTP ' + res.status);
  return res.text();
}

/** 从 HTML 内嵌 JSON 里取一个字符串字段（处理 \u002F / \u0026 转义）。 */
function pickJsonString(text, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('"' + esc + '"\\s*:\\s*"([^"]*)"').exec(text);
  return m ? normalizeVideoUrl(m[1]) : '';
}

/** 去掉 HTML/JSON 转义与 Range 参数，还原可直接下载的地址。 */
function normalizeVideoUrl(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/([?&])Range=[^&]*/g, '$1')
    .replace(/[?&]$/g, '');
}

/** 从 openIdx 处的开括号做起平衡扫描，返回匹配闭括号下标（尊重字符串与转义）。 */
function matchBracket(s, openIdx, open, close) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

module.exports = {
  search,
  episodes,
  fetchHtml,
  pickJsonString,
  normalizeVideoUrl,
  matchBracket,
  SITE_ORIGIN,
  WEB_UA,
};

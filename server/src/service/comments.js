// 详情页「热评」：复用弹幕的官方 commentapi 签名请求，取某一集按点赞排序的热门评论。
//
// 与弹幕的区别：弹幕按时间轴投放（要 offset_time），热评只看文本 + 点赞数 + 时间，
// 按 digg_count 降序取前 N 条。上游不返回昵称/头像（user_info.base_info 为空），
// 所以用脱敏 user_id 当占位昵称，前端据此渲染。
//
// 任何异常都转成 { success:false, items:[] }，不抛出；前端静默降级不影响详情页主体。
'use strict';

const Danmaku = require('./danmaku');

const CACHE_TTL = 10 * 60 * 1000;   // 热评分钟级不变，缓存 10 分钟
const MAX_ITEMS = 12;
const cache = new Map();
const pending = new Map();

function asText(v) { return v === null || v === undefined ? '' : String(v); }

function parseComments(payload, limit) {
  const rows = (payload && payload.data && payload.data.data_list) || [];
  const out = [];
  const seen = new Set();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw.comment;
    if (!c || typeof c !== 'object') continue;
    const common = c.common && typeof c.common === 'object' ? c.common : {};
    if (asText(common.status) !== '1') continue;   // 1 = 正常展示
    const content = common.content && typeof common.content === 'object' ? common.content : {};
    const text = asText(content.text).trim();
    if (!text || text.length > 200 || seen.has(text)) continue;
    seen.add(text);
    const stat = c.stat && typeof c.stat === 'object' ? c.stat : {};
    const userInfo = common.user_info && typeof common.user_info === 'object' ? common.user_info : {};
    const uid = asText(userInfo.user_id);
    const ts = Number(common.create_timestamp) || 0;
    out.push({
      text,
      likes: Math.max(0, Number(stat.digg_count) || 0),
      replies: Math.max(0, Number(stat.reply_count) || 0),
      uid,
      ts,
      date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '',
    });
  }
  out.sort((a, b) => b.likes - a.likes);
  return out.slice(0, Math.min(limit > 0 ? limit : MAX_ITEMS, MAX_ITEMS));
}

async function fetchHotComments(options) {
  const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const seriesId = asText(opt.seriesId).trim();
  const vid = asText(opt.vid).trim();
  const bookId = asText(opt.bookId).trim() || seriesId;
  const limit = opt.limit === undefined ? MAX_ITEMS : opt.limit;
  if (!/^\d{6,30}$/.test(vid)) {
    return { success: false, items: [], error: '仅红果来源的剧集支持热评' };
  }

  const key = seriesId + ':' + vid;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.result;
  if (pending.has(key)) return pending.get(key);

  const task = (async () => {
    try {
      const payload = await Danmaku.requestWindow({ vid, bookId, start: 0, duration: 3600000 });
      const items = parseComments(payload, limit);
      const result = { success: true, source: 'official', series_id: seriesId,
        episode_id: vid, items, total: items.length,
        notice: items.length ? '' : '暂无热评' };
      cache.set(key, { result, expires: Date.now() + CACHE_TTL });
      return result;
    } catch (e) {
      const msg = e && e.message ? e.message : '热评暂不可用';
      // 失败结果短 TTL，避免每次刷新都打上游
      const result = { success: false, source: 'official', series_id: seriesId,
        episode_id: vid, items: [], total: 0, error: msg, notice: msg };
      cache.set(key, { result, expires: Date.now() + 15000 });
      return result;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}

module.exports = { fetchHotComments, parseComments };

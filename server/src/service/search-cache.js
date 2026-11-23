'use strict';
/**
 * 搜索结果的磁盘持久化缓存。
 *
 * 背景：搜索是整站最慢的接口——冷词要跨境打 App 签名搜索 + 官网搜索，
 * 实测 6~9 秒；命中缓存只有 0.002 秒。原来的缓存在 Safeguards 里是纯内存、
 * 只活 10 分钟、进程重启就丢，用户每次搜新词都要等一遍。
 *
 * 本模块把「搜过的结果」落盘，重启后仍在，命中就是秒回。配合每小时预热
 * （server.js 的 scheduleSearchWarmup），既加速又能让新剧及时进缓存——
 * 缓存 TTL 略大于预热周期，预热时强制刷新，避免下一季上线后仍吃到旧数据。
 *
 * 文件格式：{ key: { v: <值>, at: <毫秒时间戳> } }
 * 写入用「临时文件 + rename」原子替换，避免写一半崩溃把文件截断。
 * 内存里维护 Map 提供读取，写盘做了节流（dirty 标记 + 定时器），
 * 不让每次搜索都触发一次磁盘 IO。
 */
const fs = require('fs');
const path = require('path');
const Config = require('../util/config');
const Log = require('../util/log');

const FILE_NAME = 'search-cache.json';

let dataDir = null;     // 缓存文件所在目录
let dirOverridden = false;  // setDir 显式指定过目录（测试/自检用），init 不覆盖
let enabled = true;
let ttlMs = 2 * 3600 * 1000;   // 默认 2 小时（略大于 1 小时预热周期）
let maxEntries = 600;          // 条目上限，超出按最后访问时间淘汰
const store = new Map();       // key -> { v, at, used }
let dirty = false;
let flushTimer = null;

function configPath() {
  if (dataDir !== null) return path.join(dataDir, FILE_NAME);
  const dd = Config.str('runtime.data_dir', null);
  const base = (dd !== null) ? dd : 'server';
  return path.resolve(base, FILE_NAME);
}

/** 初始化：读配置 + 从磁盘加载。可重复调用（测试里切目录）。 */
function init() {
  enabled = Config.bool('runtime.search_cache.enabled', true);
  const hours = Config.num('runtime.search_cache.ttl_hours', 2);
  ttlMs = (hours > 0 ? hours : 2) * 3600 * 1000;
  maxEntries = Math.max(50, Math.round(Config.num('runtime.search_cache.max_entries', 600)));
  if (!dirOverridden) {
    dataDir = null;
    dataDir = path.dirname(configPath());
  }
  const p = configPath();
  store.clear();
  dirty = false;
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const now = Date.now();
      for (const k of Object.keys(raw || {})) {
        const e = raw[k];
        if (!e || typeof e !== 'object' || !('v' in e)) continue;
        const at = Number(e.at) || 0;
        if (ttlMs > 0 && now - at > ttlMs) continue;   // 启动即丢弃过期项
        store.set(k, { v: e.v, at, used: at });
      }
      Log.info('搜索缓存已加载 ' + store.size + ' 条（' + path.basename(p) + '）');
    }
  } catch (e) {
    Log.warn('搜索缓存加载失败，将重新生成：' + e.message);
  }
  ensureFlushTimer();
  return store.size;
}

/**
 * 读取。返回命中值，未命中/过期返回 null。
 * forceRefresh=true 时视为未命中（预热强制拉新用）。
 */
function get(key, forceRefresh) {
  if (!enabled) return null;
  const k = String(key);
  const e = store.get(k);
  if (e === undefined) return null;
  if (forceRefresh !== true) {
    if (ttlMs > 0 && Date.now() - e.at > ttlMs) return null;
    e.used = Date.now();
    return e.v;
  }
  return null;
}

/** 写入（仅内存，标脏由定时器落盘）。 */
function set(key, val) {
  if (!enabled) return false;
  const k = String(key);
  const now = Date.now();
  store.set(k, { v: val, at: now, used: now });
  dirty = true;
  if (store.size > maxEntries) trim();
  return true;
}

/** 按最后访问时间淘汰最旧的条目。 */
function trim() {
  const excess = store.size - maxEntries;
  if (excess <= 0) return;
  const keys = Array.from(store.entries())
    .sort((a, b) => (a[1].used || a[1].at) - (b[1].used || b[1].at))
    .slice(0, excess)
    .map((x) => x[0]);
  for (const k of keys) store.delete(k);
  dirty = true;
}

/** 写盘（同步、原子）。返回是否真的写了。 */
function flush(force) {
  if (!enabled || (!dirty && force !== true)) return false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const p = configPath();
    const tmp = p + '.tmp';
    const out = {};
    for (const [k, e] of store) out[k] = { v: e.v, at: e.at };
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, p);
    dirty = false;
    return true;
  } catch (e) {
    Log.warn('搜索缓存写盘失败：' + e.message);
    return false;
  }
}

function ensureFlushTimer() {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => { flush(false); }, 30 * 1000);
  if (flushTimer.unref) flushTimer.unref();
}

/** 清空（自检/测试用）。 */
function clear() {
  store.clear();
  dirty = true;
}

function stats() {
  let expired = 0;
  const now = Date.now();
  for (const e of store.values()) {
    if (ttlMs > 0 && now - e.at > ttlMs) expired++;
  }
  return {
    enabled,
    entries: store.size,
    expired,
    ttl_hours: Math.round(ttlMs / 3600000 * 10) / 10,
    max_entries: maxEntries,
    file: path.basename(configPath()),
    dirty,
  };
}

module.exports = {
  init, get, set, flush, clear, stats,
  setEnabled(v) { enabled = v !== false; },
  setDir(d) {
    if (d) { dataDir = path.resolve(d); dirOverridden = true; }
    else { dataDir = null; dirOverridden = false; }
  },
};

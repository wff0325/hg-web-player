'use strict';
/**
 * 基于 node:http/https 的 HTTP 客户端（对应原 Java util/Http.java）。
 *
 * 关键行为对齐：
 *  - 默认跟随重定向
 *  - 默认不自动压缩（不主动发 accept-encoding，交给对端决定）
 *  - 超时抛异常而非静默返回
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

/** 响应结果。 */
class Resp {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body || Buffer.alloc(0);
    this.headers = headers || {};
  }

  text() { return this.body.toString('utf8'); }

  header(name) {
    const v = this.headers[String(name).toLowerCase()];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? (v.length ? v[0] : null) : String(v);
  }

  ok() { return this.status >= 200 && this.status < 300; }
}

/**
 * 发起请求。
 * @param {object} req { method, url, headers, body, timeoutMs, followRedirect }
 * @returns {Promise<Resp>}
 */
function send(req) {
  const follow = req.followRedirect !== false;
  return sendOnce(req, follow ? 5 : 0);
}

function sendOnce(req, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + req.url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https，当前协议不支持：' + req.url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = req.method || 'GET';
    const headers = Object.assign({}, req.headers || {});
    const body = req.body || null;
    const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    if (body && !hasLen) headers['content-length'] = String(body.length);

    const r = mod.request(u, {
      method,
      headers,
      timeout: req.timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const loc = res.headers.location;
        if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          let m = method;
          if (res.statusCode === 303 || m === 'POST') m = 'GET';
          const nextUrl = new URL(loc, u).toString();
          const nh = Object.assign({}, headers);
          let nb = body;
          if (m === 'GET') {
            nb = null;
            for (const k of Object.keys(nh)) {
              const kl = k.toLowerCase();
              if (kl === 'content-length' || kl === 'content-type') delete nh[k];
            }
          }
          resolve(sendOnce({ ...req, method: m, url: nextUrl, body: nb, headers: nh }, redirectsLeft - 1));
          return;
        }
        resolve(new Resp(res.statusCode, buf, res.headers));
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** 与 JS encodeURIComponent 等价（保留 A-Za-z0-9 - _ . ! ~ * ' ( )）。 */
function urlencode(s) {
  return encodeURIComponent(String(s));
}

function urldecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch (e) {
    return String(s);
  }
}

/** 解析查询串为对象（对齐 URLSearchParams：重复键取最后一个）。 */
function parseQuery(qs) {
  const out = {};
  if (qs === null || qs === undefined || qs === '') return out;
  for (const pair of String(qs).split('&')) {
    if (pair === '') continue;
    const i = pair.indexOf('=');
    if (i < 0) {
      out[urldecode(pair)] = '';
    } else {
      out[urldecode(pair.slice(0, i))] = urldecode(pair.slice(i + 1));
    }
  }
  return out;
}

/** 把多行文本按逗号切分成去空白列表；null/空返回 null。 */
function splitCsv(v) {
  if (v === null || v === undefined || v === '') return null;
  const out = [];
  for (const s of String(v).split(',')) {
    const t = s.trim();
    if (t !== '') out.push(t);
  }
  return out;
}

/**
 * 把响应体**流式**写入文件（不把整个响应读进内存）。
 *
 * 为什么需要：大文件用 send() 会把整份 body 缓冲到堆里，
 * 27MB 的分集峰值就接近 30MB，多集预热并发时堆会明显上涨。
 * 这里改成 pipe 到文件，峰值只跟单个数据块（默认 64KB）有关。
 *
 * @returns {Promise<{status:number, bytes:number}>}
 */
function sendToFile(url, destPath, opts = {}) {
  const follow = opts.followRedirect !== false;
  return sendToFileOnce(url, destPath, opts, follow ? 5 : 0);
}

function sendToFileOnce(url, destPath, opts, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('非法 URL: ' + url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: Object.assign({}, opts.headers || {}),
      timeout: opts.timeoutMs || 120000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch (e) {
          reject(new Error('重定向地址非法'));
          return;
        }
        resolve(sendToFileOnce(next, destPath, opts, redirectsLeft - 1));
        return;
      }
      if (status >= 400) {
        res.resume();
        reject(new Error('下载失败 HTTP ' + status));
        return;
      }
      const ws = fs.createWriteStream(destPath);
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve({ status, bytes }));
      res.pipe(ws);
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 下载一个字节区间，**边收边写**到文件的指定偏移。
 *
 * 与 sendToFile 的区别：用 Range 请求 + `flags:'r+'` 的写流直接落在目标偏移上，
 * 既不把整块读进内存，也不影响其它连接同时写别的位置。
 *
 * @returns {Promise<number>} 实际写入的字节数（可能小于请求区间，由调用方续传）
 */
function fetchRangeToFile(url, destPath, start, end, opts, redirectsLeft) {
  const left = (redirectsLeft === undefined) ? 5 : redirectsLeft;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('非法 URL: ' + url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers || {}, {
      range: 'bytes=' + start + '-' + end,
    });
    const req = mod.request(u, {
      method: 'GET', headers, timeout: opts.timeoutMs || 120000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && left > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch (e) {
          reject(new Error('重定向地址非法'));
          return;
        }
        resolve(fetchRangeToFile(next, destPath, start, end, opts, left - 1));
        return;
      }
      if (status === 200) {
        // 服务端忽略了 Range：交给调用方回退到单连接整份下载，别在这里半途而废
        res.resume();
        reject(new Error('RANGE_UNSUPPORTED'));
        return;
      }
      if (status !== 206) {
        res.resume();
        reject(new Error('分块下载失败 HTTP ' + status));
        return;
      }
      let bytes = 0;
      const ws = fs.createWriteStream(destPath, { flags: 'r+', start });
      res.on('data', (c) => { bytes += c.length; });
      res.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve(bytes));
      res.pipe(ws);
    });
    req.on('timeout', () => { req.destroy(new Error('分块下载超时')); });
    req.on('error', reject);
    req.end();
  });
}

/** 单块下载（含续传：CDN 少给字节时从断点继续要）。 */
async function fetchChunk(url, destPath, start, end, opts) {
  let pos = start;
  let attempt = 0;
  while (pos <= end) {
    if (attempt++ >= 4) throw new Error('分块重试次数用尽');
    const got = await fetchRangeToFile(url, destPath, pos, end, opts);
    if (got <= 0) throw new Error('分块无数据');
    pos += got;
  }
  return pos - start;
}

/**
 * 多连接分块下载同一文件。
 *
 * 为什么需要：红果的媒体 CDN 在跨境/高延迟链路上单连接只有 0.3~0.6MB/s，
 * 吞吐被 RTT 与丢包卡住（本地实测同文件单连接 12~14MB/s）。把文件切成 N 段
 * 并发拉取，通常能拿到 2~5 倍，且不改动任何协议。
 *
 * 行为约定：
 *  - 先用 `Range: bytes=0-0` 探测总大小；服务端返回 200（忽略 Range）时
 *    直接整份落盘，等价于单连接；
 *  - 文件小于 minParallelBytes 时也走单连接（分块收益抵不过建连开销）；
 *  - 任一分块失败会整体失败，由调用方决定是否重试。
 *
 * @param {string} url 媒体地址
 * @param {string} destPath 目标路径（会被覆盖）
 * @param {object} [opts] {headers, timeoutMs, connections, minParallelBytes}
 * @returns {Promise<{status:number, bytes:number, connections:number}>}
 */
async function sendToFileParallel(url, destPath, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const want = Math.max(1, Math.min(8, opts.connections || 4));
  const minBytes = opts.minParallelBytes || 1048576;
  const headers = Object.assign({}, opts.headers || {});

  // 探测总大小：只要 1 个字节
  const probe = await send({
    url, method: 'GET', timeoutMs: Math.min(timeoutMs, 20000),
    headers: Object.assign({}, headers, { range: 'bytes=0-0' }),
  });
  if (probe.status === 200) {
    // 不支持 Range：把探测拿到的整份直接落盘
    fs.writeFileSync(destPath, probe.body);
    return { status: 200, bytes: probe.body.length, connections: 1 };
  }
  if (probe.status !== 206) throw new Error('下载失败 HTTP ' + probe.status);

  const range = probe.header('content-range') || '';
  const total = Number((/\/(\d+)\s*$/.exec(range) || [])[1] || 0);
  if (!total || want === 1 || total < minBytes) {
    // 拿不到总长度或文件太小：回退单连接（这里已消耗 1 字节，重新拉整份最省事）
    const out = await sendToFile(url, destPath, { headers, timeoutMs });
    return { status: out.status, bytes: out.bytes, connections: 1 };
  }

  // 预分配，保证各连接可以写到自己的偏移
  fs.writeFileSync(destPath, Buffer.alloc(0));
  const fd = fs.openSync(destPath, 'r+');
  try { fs.ftruncateSync(fd, total); } finally { fs.closeSync(fd); }

  const chunk = Math.ceil(total / want);
  const jobs = [];
  for (let i = 0; i < want; i++) {
    const start = i * chunk;
    const end = Math.min(total - 1, start + chunk - 1);
    if (start > end) break;
    jobs.push(fetchChunk(url, destPath, start, end, { headers, timeoutMs }));
  }
  try {
    await Promise.all(jobs);
  } catch (e) {
    if (String(e && e.message) === 'RANGE_UNSUPPORTED') {
      const out = await sendToFile(url, destPath, { headers, timeoutMs });
      return { status: out.status, bytes: out.bytes, connections: 1 };
    }
    throw e;
  }
  const size = fs.statSync(destPath).size;
  if (size !== total) throw new Error('分块下载不完整：' + size + '/' + total);
  return { status: 206, bytes: total, connections: jobs.length };
}

module.exports = {
  sendToFile, sendToFileParallel, Resp, send, urlencode, urldecode, parseQuery, splitCsv };

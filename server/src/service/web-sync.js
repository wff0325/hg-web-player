'use strict';
/**
 * 前端在线更新：把 GitHub 仓库里的前端文件**全量**同步到本地 web 目录。
 *
 * 源地址默认 wff0325/hg-web-player，可用配置覆盖：
 *   web.sync.repo / HG_WEB_REPO      owner/repo
 *   web.sync.branch / HG_WEB_BRANCH  分支（默认 main）
 *   web.sync.token / HG_WEB_TOKEN    私有仓库 token（公开仓库留空）
 *
 * 全量同步流程：
 *   1. Git Trees API 递归列出仓库里所有 blob（一个请求拿到完整文件清单，
 *      含子目录/emoji/以后新增的文件，无需手改 manifest）。
 *   2. 取最新 commit sha，用 raw.githubusercontent.com/<sha>/<path> 拉每个文件
 *      ——sha 固定，绕过 raw CDN 缓存，也不占 Contents API 配额。
 *   3. 全部下载校验通过后，原子替换本地文件。
 *   4. 对照上次同步清单，删除「上次同步过、这次仓库里已没有」的旧文件。
 *
 * 安全约束：
 * - 路径白名单校验，阻止 .. / 绝对路径；
 * - DENY 名单里的敏感/本地文件（config.js 等）永不覆盖、永不删除；
 * - 用 commit sha 拉取，避免拿到缓存旧内容。
 */

const fs = require('fs');
const path = require('path');
const Http = require('../util/http');
const Config = require('../util/config');
const Log = require('../util/log');

const OWNER_REPO = () => Config.str('web.sync.repo', 'wff0325/hg-web-player');
const BRANCH = () => Config.str('web.sync.branch', 'main');
const TOKEN = () => Config.str('web.sync.token', '');

/** 永不覆盖/删除：真实密钥、本地状态、同步清单自身、文档。 */
const DENY = new Set([
  'config.js',
  'apikeys.json',
  'server/config/config.json',
  '.sync-manifest.json',
]);

/** 是否命中保护名单：整路径匹配，或 basename 匹配（兼容 web/config.js 这种带前缀路径）。 */
function isDenied(rel) {
  const s = String(rel).replace(/\\/g, '/');
  if (DENY.has(s)) return true;
  if (DENY.has(s.split('/').pop())) return true;
  if (s.startsWith('server/config/')) return true;   // 密钥/设备身份/运行配置整个目录保护
  return false;
}

/** 判断文件是否可同步（路径安全 + 不在 DENY）。 */
function safeRel(rel) {
  const s = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (s === '' || s.includes('..') || s.startsWith('.git/') || isDenied(s)) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(s)) return null;   // 不允许空格/中文/特殊字符
  return s;
}

function apiHeaders() {
  const h = { 'User-Agent': 'hg-web-sync', Accept: 'application/vnd.github+json' };
  const tok = TOKEN();
  if (tok !== '') h.Authorization = 'token ' + tok;
  return h;
}

/** 取最新 commit sha（raw URL 用它固定版本，绕开 CDN 缓存）。 */
async function latestSha() {
  const url = 'https://api.github.com/repos/' + OWNER_REPO() + '/commits/'
    + encodeURIComponent(BRANCH()) + '?t=' + Date.now();
  const res = await Http.send({ url, method: 'GET', timeoutMs: 20000, headers: apiHeaders() });
  if (res.status !== 200) throw new Error('取 commit HTTP ' + res.status + '：' + res.text().slice(0, 120));
  const j = JSON.parse(res.text());
  if (!j.sha) throw new Error('commit 响应无 sha');
  return j.sha;
}

/** 递归列出仓库所有 blob 的相对路径。 */
async function listTree(sha) {
  const url = 'https://api.github.com/repos/' + OWNER_REPO() + '/git/trees/'
    + encodeURIComponent(sha) + '?recursive=1&t=' + Date.now();
  const res = await Http.send({ url, method: 'GET', timeoutMs: 30000, headers: apiHeaders() });
  if (res.status !== 200) throw new Error('取 tree HTTP ' + res.status + '：' + res.text().slice(0, 120));
  const j = JSON.parse(res.text());
  if (!j.tree || !Array.isArray(j.tree)) throw new Error('tree 响应无 tree');
  if (j.truncated) Log.warn('web-sync：仓库 tree 被截断，部分文件可能未同步');
  return j.tree.filter((n) => n.type === 'blob').map((n) => String(n.path));
}

/** 从 raw 按固定 sha 拉一个文件（返回 Buffer，支持 SVG/二进制）。 */
async function rawFile(sha, rel) {
  const url = 'https://raw.githubusercontent.com/' + OWNER_REPO() + '/' + sha + '/'
    + rel.split('/').map(encodeURIComponent).join('/');
  const res = await Http.send({ url, method: 'GET', timeoutMs: 30000,
    headers: { 'User-Agent': 'hg-web-sync', Accept: '*/*' } });
  if (res.status !== 200) throw new Error('拉取 ' + rel + ' HTTP ' + res.status);
  return res.body;
}

/** 读上次同步清单（项目根目录下，记录上次从仓库同步了哪些文件）。 */
function readPrev(root, webRoot) {
  const p = path.join(root, '.sync-manifest.json');
  const old = webRoot ? path.join(webRoot, '.sync-manifest.json') : null;
  const out = [];
  for (const f of [old, p]) {          // 先读旧位置（web/）再读新位置，合并去重
    if (!f) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(j.files)) for (const x of j.files) out.push(String(x));
    } catch (e) { /* 不存在或损坏则跳过 */ }
  }
  return Array.from(new Set(out));
}

function writePrev(root, files) {
  const p = path.join(root, '.sync-manifest.json');
  fs.writeFileSync(p, JSON.stringify({ files }, null, 2), 'utf8');
}

/**
 * 把仓库相对路径映射到本地绝对路径。
 * 仓库根即项目根：web/... → <root>/web/...，server/... → <root>/server/...，
 * 其余（如 manifest.json）落在项目根。
 */
function destOf(root, rel) {
  const dest = path.resolve(root, '.' + '/' + rel);
  if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error('路径越界：' + rel);
  return dest;
}

/**
 * 全量同步（前端 + 后端）。
 * @param {string} webDir 本地 web 目录绝对路径（其父目录视为项目根）
 * @returns {Promise<{ok, files, deleted, bytes, sha, restart}>}
 */
async function sync(webDir) {
  const webRoot = path.resolve(webDir);
  const root = path.dirname(webRoot);          // 项目根
  const sha = await latestSha();
  const listed = await listTree(sha);

  const rels = [];
  for (const f of listed) {
    const s = safeRel(f);
    if (s === null) { Log.info('web-sync 跳过 ' + f); continue; }
    rels.push(s);
  }
  if (rels.length === 0) throw new Error('仓库里没有可同步的文件');

  // 阶段一：全部下载到内存校验（sha 固定，不怕缓存）
  const pending = [];
  let total = 0;
  for (const rel of rels) {
    const buf = await rawFile(sha, rel);
    if (buf.length < 2) throw new Error('拉取 ' + rel + ' 内容过短，疑似空响应');
    total += buf.length;
    pending.push({ rel, buf });
  }

  // 阶段二：原子落盘（前端和后端按路径各自归位）
  const written = [];
  let backendChanged = false;
  for (const p of pending) {
    const dest = destOf(root, p.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.sync.tmp';
    fs.writeFileSync(tmp, p.buf);
    fs.renameSync(tmp, dest);
    written.push(p.rel);
    // 后端目录（server/src/...）有更新 → 需重启进程才生效
    if (p.rel.startsWith('server/src/')) backendChanged = true;
  }

  // 阶段三：删除「上次同步过、这次仓库已无」的旧文件（敏感文件永不删）
  const prev = readPrev(root, webRoot);
  const now = new Set(rels);
  const deleted = [];
  for (const rel of prev) {
    if (now.has(rel) || safeRel(rel) === null || isDenied(rel)) continue;
    // 旧清单是相对 web 的路径（assets/app.js），新版是 web/assets/app.js。
    // 兼容：旧格式的裸路径映射到 web 目录，避免删错位置。
    const mapped = (!rel.startsWith('web/') && !rel.startsWith('server/')) ? 'web/' + rel : rel;
    if (now.has(mapped)) continue;
    const dest = destOf(root, mapped);
    try {
      if (fs.existsSync(dest)) { fs.unlinkSync(dest); deleted.push(mapped); }
    } catch (e) { Log.warn('web-sync 删除失败 ' + mapped + '：' + String(e.message || e)); }
  }
  writePrev(root, rels);

  return { ok: true, files: written, deleted, bytes: total, sha, restart: backendChanged };
}

module.exports = { sync, safeRel, DENY, latestSha, listTree };

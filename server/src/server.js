'use strict';
/**
 * 红果短剧 Web 服务。
 *
 * 移植自 server/src/server.js（Node.js 版），语义以 Java
 * com.hongguo.api.Server 为权威规格，改用 Node 内置 http 模块，零第三方依赖。
 *
 * 路由与原版保持一致：/ /health /api-key /search /rank /latest /filters
 *                  /browse /episodes /play /stream /video_url /img
 *                  /download /prewarm /stats /metrics/batch /admin/keys
 *                  /danmaku（官方时间轴弹幕，后加）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const KeyStore = require('./core/keystore');
const Safeguards = require('./core/safeguards');
const Client = require('./service/client');
const Ssr = require('./service/ssr');
const Download = require('./service/download');
const Res = require('./service/res');
const Stream = require('./service/stream');
const Danmaku = require('./service/danmaku');
const Comments = require('./service/comments');
const OhgData = require('./service/ohg-data');
const Ohg = require('./service/ohg');
const WebSync = require('./service/web-sync');
const Http = require('./util/http');
const Json = require('./util/json');
const Config = require('./util/config');
const Log = require('./util/log');

/** 免鉴权路径。 */
const EXEMPT = new Set(['/', '/ui', '/img', '/favicon.ico', '/health', '/api-key', '/client-config', '/version']);

/** 显示用语义版本：读项目根 version.json 的 version 字段（如 v1.0）。
 *  每次实质更新手动改该文件即可；读不到时回退 v1.0。 */
function displayVersion(webDir) {
  try {
    const root = path.dirname(path.resolve(webDir));
    const j = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
    const v = String(j.version || '').trim();
    return v === '' ? 'v1.0' : v;
  } catch (e) { return 'v1.0'; }
}

/** 前端资源版本：用 app.js + app.css 的内容哈希生成，改了文件版本号自动变。
 *  缓存 8 秒，避免高频轮询反复读盘；哈希只取前 12 位，够判断新旧。 */
let webVersionCache = { at: 0, value: null };
function webVersion(webDir) {
  const now = Date.now();
  if (webVersionCache.value !== null && now - webVersionCache.at < 8000) return webVersionCache.value;
  const crypto = require('crypto');
  const h = crypto.createHash('sha1');
  for (const f of ['assets/app.js', 'assets/app.css']) {
    try {
      h.update(fs.readFileSync(path.join(webDir, f)));
    } catch (e) { h.update(f + ':missing'); }
  }
  const ver = h.digest('hex').slice(0, 12);
  webVersionCache = { at: now, value: ver };
  return ver;
}

/** 触发空闲清理的桶数量阈值：HG_RATE_BUCKETS_MAX，默认 4096。 */
const RATE_BUCKETS_MAX = Config.num('runtime.rate_buckets_max', 4096);

/** 桶空闲多久后回收：HG_RATE_BUCKET_IDLE_MS，默认 10 分钟。 */
const RATE_BUCKET_IDLE_MS = Config.num('runtime.rate_bucket_idle_ms', 600) * 1000;

/** 图片代理允许的域名。 */
const IMG_HOSTS = ['fqnovelpic.com', 'byteimg.com', 'qznovelvod.com', 'douyinpic.com', 'pstatp.com'];

/**
 * 图片字节缓存（访问序 LRU + 字节上限）。
 *
 * 历史问题：只按「条数 < 1000」判断能否写入，却从不淘汰，且完全不考虑单张
 * 图片的字节大小（HEIC 封面可达数百 KB）。现在改为 LRU + 字节上限。
 */
const imgCache = new Map(); // url -> Buffer（Map 头部为最旧）

/** 图片缓存当前字节数。 */
let imgCacheBytes = 0;

/** 图片缓存字节上限：HG_IMG_CACHE_MAX_MB，默认 64MB。 */
const IMG_CACHE_MAX_BYTES = Config.num('runtime.cache.img_max_mb', 64) * 1024 * 1024;

/** 单张图片上限：HG_IMG_MAX_KB，默认 4MB，超限不缓存。 */
const IMG_MAX_BYTES = Config.num('runtime.cache.img_max_kb', 4096) * 1024;

function imgCacheGet(url) {
  const hit = imgCache.get(url);
  if (hit === undefined) return null;
  // 访问序 LRU：命中后移到队尾
  imgCache.delete(url);
  imgCache.set(url, hit);
  return hit;
}

function imgCachePut(url, data) {
  if (data.length > IMG_MAX_BYTES) return; // 过大不入缓存
  const old = imgCache.get(url);
  if (old !== undefined) {
    imgCache.delete(url);
    imgCacheBytes -= old.length;
  }
  imgCache.set(url, data);
  imgCacheBytes += data.length;
  // 超过上限时按 LRU 裁剪
  while (imgCacheBytes > IMG_CACHE_MAX_BYTES && imgCache.size > 0) {
    const firstKey = imgCache.keys().next().value;
    const v = imgCache.get(firstKey);
    imgCache.delete(firstKey);
    imgCacheBytes -= v.length;
  }
}

class Server {
  constructor() {
    this.keys = KeyStore.store();

    // 管理口令优先级：环境变量 > apikeys.json 的 admin_token > 首次生成并写回文件。
    // 不设环境变量时以文件为准，重启后沿用同一个值（早期版本每次启动
    // 随机生成，重启即失效，脚本化的管理调用无法稳定使用）。
    const tok = Log.env('ADMIN_TOKEN', null);
    let fresh = false;
    if (tok !== null && tok !== undefined && tok !== '') {
      this._adminToken = tok;
    } else {
      this._adminToken = this.keys.ensureAdminToken();
      fresh = this.keys.adminTokenFresh();
    }
    this._adminTokenFresh = fresh;
    this.ratePerMin = Log.envInt('RATE_PER_MIN', 120);

    const wd = Log.env('WEB_DIR', null);
    this.webDir = (wd !== null && wd !== undefined) ? wd : path.join(process.cwd(), 'web');

    this.startTime = Date.now();
    this.buckets = new Map();
    this.stats = { requests: 0, errors: 0, risk: 0, authFail: 0 };
    this.httpServer = null;
  }

  /** 管理口令。 */
  adminToken() { return this._adminToken; }

  /** 本次启动的管理口令是否为新生成（控制台据此决定是否提示）。 */
  adminTokenFresh() { return this._adminTokenFresh; }

  /**
   * 首次启动自动签发一把本地链路密钥，避免用户手动配置。
   * 已有密钥时返回 null（不打扰）。
   */
  ensureBootstrap() {
    return this.keys.ensureBootstrap();
  }

  // ==================== 启动 ====================

  /**
   * 创建并启动 HTTP 服务。
   * 返回 Promise，resolve 出底层 http.Server（listen 成功后）。
   */
  /**
   * 定时轮换链路密钥。周期取 runtime.key_rotate_hours（默认 24 小时，<=0 关闭）。
   * 旧密钥在 runtime.key_grace_minutes（默认 30 分钟）内仍可用，
   * 前端每次启动/401 时会重新拉 /client-config，所以不会中断播放。
   */
  scheduleKeyRotation() {
    // 用浮点解析，允许 HG_KEY_ROTATE_HOURS=0.05 这种「几分钟」级别的调试值
    const rawEnv = Log.env('HG_KEY_ROTATE_HOURS', null);
    const parsed = rawEnv === null ? NaN : parseFloat(String(rawEnv).trim());
    const hours = Number.isFinite(parsed) ? parsed : Config.num('runtime.key_rotate_hours', 24);
    if (!(hours > 0)) return;
    const due = () => {
      const at = Date.parse(this.keys.rotatedAt());
      if (Number.isNaN(at)) return true;
      return Date.now() - at >= hours * 3600 * 1000;
    };
    const tick = () => {
      try {
        if (due()) this.keys.rotate('auto');
      } catch (e) {
        Log.warn('密钥轮换失败: ' + (e && e.message ? e.message : e));
      }
    };
    tick();
    const timer = setInterval(tick, Math.min(hours * 3600 * 1000, 10 * 60 * 1000));
    if (timer.unref) timer.unref();
  }

  /**
   * 同步完成后自动重启：拉起独立助手 → 关闭本服务 → 进程退出。
   * 助手会等本进程退出、端口释放后用同一套参数重新拉起服务，
   * 这样后端代码（server/src/*）的更新无需用户手动重启即可生效。
   * 只在 web-sync 报告后端有变化时调用；前端同步会据此轮询等待。
   */
  scheduleAutoRestart() {
    if (this._restarting) return;
    this._restarting = true;
    const cp = require('child_process');
    const helper = path.join(__dirname, 'restart-helper.js');
    const host = this.bindHost || '127.0.0.1';
    const port = this.bindPort || Config.num('api.port', 8000);
    const cwd = process.cwd();
    const script = path.join(__dirname, 'main.js');
    // 透传原始启动参数（去掉 node 与入口脚本本身），例如 --watch 等
    const extraArgs = process.argv.slice(2).filter((a) => a.indexOf('--sync-web') < 0);
    const args = [helper,
      '--old-pid', String(process.pid),
      '--port', String(port),
      '--cwd', cwd,
      '--script', script,
      '--args', extraArgs.join(',')];
    try {
      const child = cp.spawn(process.execPath, args, {
        cwd, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      Log.info('后端已更新，正在自动重启服务（新进程由重启助手拉起）');
    } catch (e) {
      Log.warn('启动重启助手失败，请手动重启：' + String(e && e.message || e));
      this._restarting = false;
      return;
    }
    // 给响应和助手一点时间，然后关闭监听并退出；进程退出后由助手重新拉起。
    setTimeout(() => {
      try { if (this.httpServer) this.httpServer.close(); } catch (e) { /* 忽略 */ }
      setTimeout(() => process.exit(0), 300);
    }, 400);
  }

  start(host, port) {
    this.bindHost = host;
    this.bindPort = port;
    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        Log.error('未捕获的处理异常: ' + (e && e.message ? e.message : e), e);
        try { Res.fail(req, res, 500, 'internal error'); } catch (e2) { /* headers sent */ }
      });
    });
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.scheduleKeyRotation();
      this.httpServer.listen(port, host, () => {
        Log.info('红果短剧 Web API  http://' + host + ':' + port);
        Log.info('前端页面        http://' + host + ':' + port + '/ui');
        resolve(this.httpServer);
      });
    });
  }

  /**
   * 签名后端状态（/health 与 /stats 用）。
   *
   * 保持原「数组 + ready 字段」的形状：早期版本这里列的是外部 unidbg
   * 签名服务地址，现已改为进程内 PureSign 纯代码计算，恒就绪。
   */
  static signBackends() {
    const m = Json.obj();
    m.url = 'local';
    m.ready = true;
    m.probe = 'pure-sign';
    return [m];
  }

  // ==================== 主处理 ====================

  async handle(req, res) {
    try {
      const rawUrl = req.url || '/';
      const qIdx = rawUrl.indexOf('?');
      const rawPath = qIdx >= 0 ? rawUrl.substring(0, qIdx) : rawUrl;
      const rawQuery = qIdx >= 0 ? rawUrl.substring(qIdx + 1) : null;
      let pathname;
      try {
        pathname = Http.urldecode(rawPath);
      } catch (e) {
        pathname = rawPath;
      }
      // 部署在子路径（如 Passenger 的 /api）时剥掉前缀
      const basePath = (process.env.BASE_PATH || '/api').replace(/\/+$/, '');
      if (basePath && pathname.startsWith(basePath + '/')) {
        pathname = pathname.slice(basePath.length);
      } else if (basePath && pathname === basePath) {
        pathname = '/';
      }
      const method = req.method;
      const q = Http.parseQuery(rawQuery);

      // CORS 预检
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'content-type,x-api-key,x-admin-token,range',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/client-config') {
        // 把当前密钥与分享码直接下发给前端，避免手改 config.js 后对不上导致 401。
        // 这是本地链路口令（等同静态文件里那个），不是强安全边界。
        const m = Json.obj();
        m.ok = true;
        m.api_key = this.keys.currentKey();
        m.sharecode = Config.str('server.sharecode', '');
        m.brand = Config.str('server.brand', '');
        m.default_quality = Config.str('server.default_quality', '');
        m.rotate_hours = Config.num('runtime.key_rotate_hours', 24);
        m.rotated_at = this.keys.rotatedAt();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(m));
        return;
      }

      // 静态资源优先：前端页面与 JS/CSS 不参与 API 鉴权
      if (method === 'GET' && Res.isStaticPath(pathname)) {
        await Res.serveStatic(req, res, pathname, this.webDir, webVersion(this.webDir), displayVersion(this.webDir));
        return;
      }

      // 鉴权：管理/统计自行校验；静态资源与健康检查免鉴权
      if (!EXEMPT.has(pathname) && !pathname.startsWith('/admin')
          && pathname !== '/stats') {
        let key = header(req, 'x-api-key');
        if (key === null || key === '') key = q.api_key !== undefined ? q.api_key : '';
        if (!this.keys.isValid(key)) {
          this.stats.authFail++;
          Res.fail(req, res, 401, '缺少或无效的 api_key'
            + '（请在客户端配置本地链路密钥；首次访问可先请求 /api-key）');
          return;
        }
        if (!this.rateLimit(key)) {
          Res.fail(req, res, 429, '超过限流 ' + this.ratePerMin + '/分钟');
          return;
        }
        this.stats.requests++;
      }

      await this.route(req, res, method, pathname, q);

    } catch (e) {
      this.stats.errors++;
      if (e instanceof Safeguards.RiskControlError) this.stats.risk++;
      const isAuth = e instanceof Safeguards.AuthExpiredError;
      const m = Json.obj();
      m.detail = String(e && e.message !== null && e.message !== undefined ? e.message : e);
      if (e instanceof Safeguards.ApiError) {
        if (e.safeResponse !== null && e.safeResponse !== undefined) m.safe_response = e.safeResponse;
        if (e.diagnostic !== null && e.diagnostic !== undefined) m.response = e.diagnostic;
        if (e.modelShape !== null && e.modelShape !== undefined) m.model_shape = e.modelShape;
      }
      Res.json(req, res, isAuth ? 401 : 502, m);
    }
  }

  /**
   * 限流。
   *
   * key 为 api_key；每个桶保存最近 60s 的时间戳。桶数超阈值时顺带淘汰空闲桶。
   */
  rateLimit(key) {
    const now = Date.now();
    if (this.buckets.size > RATE_BUCKETS_MAX) this.sweepBuckets(now);

    let arr = this.buckets.get(key);
    if (arr === undefined) {
      arr = [];
      this.buckets.set(key, arr);
    }
    // 原地压缩：保留最近 60s 内的记录
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      if (t > now - 60000) arr[n++] = t;
    }
    arr.length = n;
    if (n >= this.ratePerMin) {
      // 已超限
      return false;
    }
    arr.push(now);
    return true;
  }

  /** 淘汰空闲超时的桶。 */
  sweepBuckets(now) {
    for (const [k, arr] of this.buckets) {
      let newest = 0;
      for (const t of arr) if (t > newest) newest = t;
      if (now - newest > RATE_BUCKET_IDLE_MS) this.buckets.delete(k);
    }
  }

  checkAdmin(req, q) {
    let tok = header(req, 'x-admin-token');
    if (tok === null || tok === '') tok = q.admin_token !== undefined ? q.admin_token : '';
    return tok !== '' && tok === this._adminToken;
  }

  // ==================== 路由分发 ====================

  /** openhongguo SDK 新能力路由（/sdk/*）。返回 true 表示已处理。 */
  async sdkRoute(req, res, method, pathname, q) {
    if (!pathname.startsWith('/sdk/')) return false;
    const sub = pathname.slice('/sdk/'.length);
    const int = (v, def) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    };
    try {
      let data;
      switch (sub) {
        case 'suggest':
          data = { items: await OhgData.suggest(q.q !== undefined ? q.q : '') }; break;
        case 'hot':
          data = await OhgData.hotSearch(); break;
        case 'cues':
          data = { items: await OhgData.searchCues() }; break;
        case 'discover':
          data = await OhgData.discover(int(q.limit, 30)); break;
        case 'new-releases':
          data = await OhgData.newReleases(q.date ? { date: q.date } : {}); break;
        case 'album':
          data = await OhgData.album(String(q.album_id || q.id || '')); break;
        case 'recommend':
          data = await OhgData.recommend(String(q.series_id || q.id || '')); break;
        case 'rank-meta':
          data = await OhgData.rankMeta(); break;
        case 'rank-groups':
          data = await OhgData.rankGroups(); break;
        case 'rank-rows':
          data = await OhgData.rankRows(String(q.cell_id || q.id || ''), int(q.offset, 0), int(q.limit, 30)); break;
        case 'ranking':
          data = await OhgData.ranking(String(q.activity_id || ''), String(q.rank_list_id || q.list || ''), int(q.limit, 30)); break;
        case 'categories':
          data = await OhgData.categories(String(q.category_id || q.id || '')); break;
        case 'category-landing': {
          const opts = {};
          if (q.tab !== undefined) opts.tab = String(q.tab);
          if (q.cursor !== undefined) opts.cursor = String(q.cursor);
          data = await OhgData.categoryLanding(String(q.category_id || q.id || ''), opts, int(q.limit, 30));
          break;
        }
        case 'person':
          data = await OhgData.person(String(q.user_id || q.id || '')); break;
        case 'person-works':
          data = await OhgData.personWorks(String(q.user_id || q.id || ''), q.cursor || '', int(q.limit, 30)); break;
        case 'celebrities':
          data = await OhgData.celebrities(); break;
        case 'filter-panel':
          data = await OhgData.filterPanel(String(q.genre || 'short_play')); break;
        case 'reset-device':
          await Ohg.resetDevice();
          data = { ok: true, note: '已更换匿名设备' }; break;
        default:
          Res.fail(req, res, 404, '未知的 SDK 接口：' + sub);
          return true;
      }
      Res.json(req, res, 200, data);
    } catch (e) {
      const ne = Ohg.normalizeError(e);
      Res.fail(req, res, ne.code === 'CONTENT_UNAVAILABLE' ? 404 : 502,
        ne.code + ': ' + ne.message);
    }
    return true;
  }

  async route(req, res, method, pathname, q) {
    // ---- openhongguo SDK 新能力（/sdk/*） ----
    if (await this.sdkRoute(req, res, method, pathname, q)) return;

    // ---- 无需鉴权的基础接口 ----
    if (method === 'GET' && pathname === '/') {
      const m = Json.obj();
      m.service = '红果短剧 Web API';
      m.ui = '/ui';
      m.managed = Client.MANAGED;
      m.endpoints = [
        '/search?q=', '/rank?board=recommend|hot|new&limit=',
        '/latest?genre=short_play|comic_series|ai_series&only_today=true',
        '/filters?genre=short_play',
        '/browse?genre=ai_series&theme=玄幻&sort=hot_score&days=7',
        '/episodes?series_id=', '/play?series_id=&ep=1-10',
        '/stream?series_id=&ep=1', '/stream?vid=&quality=1080p',
        '/prewarm?vid=', '/stats',
        '/download/task（POST {series_id,start,end} 批量下载剧集）',
      ];
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      const m = Json.obj();
      m.ok = true;
      m.uptime_s = Math.floor((Date.now() - this.startTime) / 1000);
      m.sign_backends = Server.signBackends();
      m.api_host = Client.HOST;
      m.ffmpeg = Stream.ffmpegAvailable();
      m.ffmpeg_path = Stream.ffmpegBin();
      m.transcode = Stream.transcodeEnabled();
      m.h264_encoder = Stream.h264EncoderName();
      // 不传 dir 时 diskFreeBytes 会默认取缓存目录（旧写法两个分支都是 undefined，
      // 导致 /health 的 disk_free_mb 恒为 null）
      const free = Stream.diskFreeBytes();
      m.disk_free_mb = free === null ? null : Math.round(free / 1048576);
      m.sdk_cache = Ohg.cacheStats();
      // PR#25 SDK 取址修复：重签 video_model/v1 的次数（0 失败才算健康）
      m.sdk_v1_patch = Ohg.patchInfo ? Ohg.patchInfo() : null;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/version') {
      const m = Json.obj();
      m.ok = true;
      m.version = webVersion(this.webDir);        // 内容哈希（缓存失效用）
      m.display = displayVersion(this.webDir);    // 语义版本（显示用，如 v1.0）
      Res.json(req, res, 200, m, Res.headers('application/json', 'no-cache'));
      return;
    }

    // 前端在线更新：从 GitHub 拉取前端文件覆盖本地（用 api_key 鉴权即可，
    // 源仓库固定且公开，内容由站点所有者控制）。前端顶栏「检查更新」按钮调用。
    if (method === 'POST' && pathname === '/sync-web') {
      let tok = header(req, 'x-api-key');
      if (tok === null || tok === '') tok = q.api_key !== undefined ? q.api_key : '';
      if (!this.keys.isValid(tok)) {
        Res.fail(req, res, 401, '需要有效的 api_key');
        return;
      }
      webVersionCache = { at: 0, value: null };   // 让版本号立即失效重算
      try {
        const r = await WebSync.sync(this.webDir);
        const m = Json.obj();
        m.ok = true;
        m.files = r.files;
        m.deleted = r.deleted;
        m.bytes = r.bytes;
        m.sha = String(r.sha || '').slice(0, 8);
        m.version = webVersion(this.webDir);
        m.display = displayVersion(this.webDir);
        m.restart = r.restart === true;   // 后端文件有更新，需重启进程生效
        // 后端有变化：本进程会自动重启，告诉前端进入「等待重启」流程
        m.restarting = m.restart;
        // 关键：必须等响应真正 flush 到 socket（finish 事件）再重启，
        // 否则 process.exit 会 reset 连接，前端拿到空响应误判为更新失败。
        if (m.restart) {
          res.once('finish', () => setTimeout(() => this.scheduleAutoRestart(), 300));
        }
        Res.json(req, res, 200, m);
      } catch (e) {
        Res.fail(req, res, 502, '更新失败：' + String((e && e.message) || e));
      }
      return;
    }

    if (method === 'GET' && pathname === '/api-key') {
      let k = this.keys.firstEnabled();
      if (k === null) {
        const nk = this.keys.generate('auto');
        k = this.keys.get(nk);
      }
      const m = Json.obj();
      m.api_key = k.key;
      m.note = k.note;
      m.rate_per_min = this.ratePerMin;
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 数据接口 ----
    if (method === 'GET' && (pathname === '/search' || pathname === '/search/page')) {
      const query = q.q !== undefined ? q.q : '';
      if (query === '') {
        Res.fail(req, res, 400, '缺少 q');
        return;
      }
      const lim = q.limit;
      const searchOff = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      const searchLimit = (lim === null || lim === undefined || lim === '')
        ? 0 : Number.parseInt(lim, 10);
      // 数据源：openhongguo SDK。前端契约不变（query/count/results/has_more/next_offset）。
      // filter=real|comic|ai|film 映射到 SDK SearchFilter（白名单，防注入）。
      const FILTER_MAP = {
        real: 'content_type_short_play', comic: 'content_type_dynamic_comic',
        ai: 'content_type_ai_dynamic_comic', film: 'content_type_long_video',
        new: 'search_range_unread',
      };
      const fk = String(q.filter || '');
      const filters = Object.prototype.hasOwnProperty.call(FILTER_MAP, fk)
        ? [FILTER_MAP[fk]] : [];
      const m = Json.obj();
      const pg = await OhgData.search(query, searchLimit || 40, filters);
      m.query = pg.query;
      m.count = pg.count;
      m.results = pg.results;
      m.has_more = pg.has_more;
      m.next_offset = searchOff + pg.next_offset;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/rank') {
      const board = q.board !== undefined ? q.board : 'hot';
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '30', 10);
      const offset = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      // board 支持短名与官方 ID；content 切换「全部/系列剧/漫剧/真人剧/AI剧」。
      const pg = await OhgData.rank(board, limit, offset,
        q.content !== undefined ? q.content : '', q.cursor !== undefined ? q.cursor : '');
      const m = Json.obj();
      m.board = pg.board;
      m.name = pg.name;
      m.content = pg.content;
      m.board_id = pg.board_id;
      m.contents = pg.contents;
      m.items = pg.items;
      m.has_more = pg.has_more;
      m.next_offset = pg.next_offset;
      m.cursor = pg.cursor;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/latest') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      const onlyToday = q.only_today !== 'false';
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '120', 10);
      const refresh = q.refresh === 'true' || q.no_cache === 'true';
      const mode = genre === 'short_play'
        ? (onlyToday ? '今日上新' : '最新上架')
        : '7天内上新·最新上架';
      const m = Json.obj();
      m.genre = genre;
      m.name = Client.GENRE_NAMES[genre];
      m.mode = mode;
      m.only_today = onlyToday;
      // offset>0 或带 seen 走分页路径；前端把已看过的 series_id 以逗号串回传，
      // 上游据此去重，因此续页内容不会与前面重复
      const offset = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      const seenRaw = q.seen;
      let seen = null;
      if (seenRaw !== undefined && seenRaw !== null && seenRaw !== '') {
        seen = seenRaw.split(',');
      }
      if (offset > 0 || seen !== null) {
        const pg = await Client.latestPage(genre, onlyToday, limit, refresh, seen, offset);
        m.count = pg.items.length;
        m.items = pg.items;
        m.has_more = pg.hasMore;
        m.next_offset = pg.nextSkip;
      } else {
        const items = await Client.latest(genre, onlyToday, limit, refresh);
        m.count = items.length;
        m.items = items;
      }
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/debug/mem') {
      // 临时诊断：报告内存，并按 mb 参数申请内存看是否被 LVE 杀掉
      const mb = Number.parseInt(q.mb !== undefined ? q.mb : '0', 10) || 0;
      const before = process.memoryUsage();
      const hold = [];
      for (let i = 0; i < mb; i++) hold.push(Buffer.alloc(1024 * 1024, 1));
      const after = process.memoryUsage();
      const m = Json.obj();
      m.rss_mb_before = Math.round(before.rss / 1048576);
      m.rss_mb_after = Math.round(after.rss / 1048576);
      m.heap_mb = Math.round(after.heapUsed / 1048576);
      m.allocated_mb = hold.length;
      m.node = process.version;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/catalog') {
      // 数据源：openhongguo SDK shortFilter。channel=real|comic|ai，page 从 1 开始。
      const channel = q.channel !== undefined && q.channel !== '' ? q.channel : 'real';
      const page = Number.parseInt(q.page !== undefined ? q.page : '1', 10) || 1;
      // limit 由前端指定：首页首屏只要 10 张（一次 SDK 调用），分类页滚动用默认 30。
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '30', 10) || 30;
      // selections 是官方筛选面板选项（如 category_dim_theme=cate_5000），JSON 字符串传入
      let selections = null;
      if (q.selections) {
        try { selections = JSON.parse(q.selections); } catch (e) { selections = null; }
      }
      const data = await OhgData.catalog(channel, page, limit, selections);
      Res.json(req, res, 200, data);
      return;
    }

    if (method === 'GET' && pathname === '/detail') {
      // 数据源：openhongguo SDK。返回 {meta, episodes} 契约不变。
      const seriesId = q.series_id !== undefined ? q.series_id : '';
      if (seriesId === '') { Res.fail(req, res, 400, '缺少 series_id'); return; }
      const data = await OhgData.detail(seriesId);
      Res.json(req, res, 200, data);
      return;
    }

    if (method === 'GET' && pathname === '/ssr-rank') {
      const board = q.board !== undefined && q.board !== '' ? q.board : 'hot';
      const page = Number.parseInt(q.page !== undefined ? q.page : '1', 10) || 1;
      const data = await Ssr.rank(board, page);
      Res.json(req, res, 200, data);
      return;
    }

    if (method === 'GET' && pathname === '/filters') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      // 数据源：openhongguo SDK shortFilterPanel。契约不变（genre/name/rows）。
      const r = await OhgData.filterPanel(genre);
      const m = Json.obj();
      m.genre = r.genre;
      m.name = Client.GENRE_NAMES[genre] || r.name;
      m.rows = r.rows;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/browse') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      const opts = {};
      for (const k of ['theme', 'setting', 'background', 'sort',
        'gender', 'days', 'status', 'limit']) {
        if (Object.prototype.hasOwnProperty.call(q, k)) opts[k] = q[k];
      }
      let items;
      let hasMore = false;
      let nextOffset = 0;
      const offset = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      const seenRaw = q.seen;
      if (offset > 0 || (seenRaw !== undefined && seenRaw !== null && seenRaw !== '')) {
        const seen = seenRaw.split(',');
        const pg = await Client.browsePage(genre, opts, seen, offset);
        items = pg.items;
        hasMore = pg.hasMore;
        nextOffset = pg.nextSkip;
      } else {
        items = await Client.browse(genre, opts);
      }
      // 补上播放与剧集入口
      for (const itObj of items) {
        const it = Json.optObj(itObj);
        if (it === null) continue;
        const sid = Json.optStr(it.series_id, '');
        const vid = Json.optStr(it.vid, '');
        it.stream_url = vid !== '' ? '/stream?vid=' + vid
          : '/stream?series_id=' + sid + '&ep=1';
        it.episodes_url = '/episodes?series_id=' + sid;
      }
      const m = Json.obj();
      m.genre = genre;
      m.name = Client.GENRE_NAMES[genre];
      m.count = items.length;
      m.items = items;
      if (hasMore || nextOffset > 0) {
        m.has_more = hasMore;
        m.next_offset = nextOffset;
      }
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/episodes') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '缺少 series_id');
        return;
      }
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '0', 10) || 0;
      Res.json(req, res, 200, await OhgData.episodes(sid, limit));
      return;
    }

    // 官方「相关作品 / 同系列」：返回同一系列的其它季（含待上线）。
    // 前端用它替代「按标题基名猜测」，避免把不同剧误判成同一系列
    // （如「全球死考…二季」和「…第三季」其实是不同剧）。
    if (method === 'GET' && pathname === '/series-seasons') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '缺少 series_id');
        return;
      }
      // 数据源：openhongguo SDK seasons()（官方权威全季，返回什么季就全收）。
      const m = Json.obj();
      try {
        const r = await OhgData.seasons(sid);
        m.ok = true;
        m.series_id = r.series_id;
        m.album_id = r.album_id;
        m.season_count = r.season_count;
        m.items = r.items;
      } catch (e) {
        m.ok = false;
        m.error = (e && e.message) || '查全季接口不可用';
        m.items = [];
      }
      Res.json(req, res, 200, m);
      return;
    }

    // 官方时间轴弹幕。series_id 用作 business_param.book_id，vid 是本集 group_id，
    // 两者都要传；拿不到时返回 success:false + 中文说明（不是「本集没弹幕」）。
    if (method === 'GET' && pathname === '/danmaku') {
      const sid = String(q.series_id === undefined ? '' : q.series_id).trim();
      const vid = String(q.vid === undefined ? '' : q.vid).trim();
      if (sid === '' || vid === '') {
        Res.fail(req, res, 400, '缺少 series_id 或 vid');
        return;
      }
      const limit = Number(q.limit);
      // 数据源：openhongguo SDK listDanmaku（官方时间轴弹幕）。契约不变。
      const r = await OhgData.danmaku(sid, vid,
        Number.isInteger(limit) && limit > 0 ? limit : 1200);
      Res.json(req, res, 200, r);
      return;
    }

    if (method === 'GET' && pathname === '/comments') {
      const sid = String(q.series_id === undefined ? '' : q.series_id).trim();
      const vid = String(q.vid === undefined ? '' : q.vid).trim();
      if (sid === '' || vid === '') {
        Res.fail(req, res, 400, '缺少 series_id 或 vid');
        return;
      }
      const limit = Number(q.limit);
      const r = await Comments.fetchHotComments({
        seriesId: sid, vid,
        bookId: q.book_id ? String(q.book_id) : sid,
        limit: Number.isInteger(limit) && limit > 0 ? limit : 6,
      });
      Res.json(req, res, 200, r);
      return;
    }

    if (method === 'POST' && pathname === '/metrics/batch') {
      const payload = await readJson(req);
      let raw = Object.prototype.hasOwnProperty.call(payload, 'series_ids')
        ? payload.series_ids : payload.series_id;
      if (raw === undefined) raw = null;
      const ids = [];
      if (Array.isArray(raw)) {
        for (const o of raw) ids.push(String(o).trim());
      } else {
        const sp = Http.splitCsv(String(raw));
        if (sp !== null) ids.push(...sp);
      }
      const filtered = ids.filter((s) => s !== '');
      if (filtered.length === 0) {
        Res.fail(req, res, 400, 'series_ids 不能为空');
        return;
      }
      if (filtered.length > 200) {
        Res.fail(req, res, 400, 'series_ids 最多 200 个');
        return;
      }
      // 数据源：openhongguo SDK getSeriesBatch（按请求顺序返回）。契约不变。
      const r = await OhgData.batch(filtered);
      const m = Json.obj();
      m.count = r.count;
      m.items = r.items;
      m.failed = filtered.length - r.count;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/play') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '缺少 series_id');
        return;
      }
      // 数据源：openhongguo SDK（与 /episodes 一致）。
      const meta = await OhgData.episodes(sid, 0);
      const eps = Json.optArr(meta.episodes);
      const want = parseRange(q.ep !== undefined ? q.ep : 'all', eps.length);

      const sel = [];
      for (const eObj of eps) {
        const e = Json.optObj(eObj);
        if (e !== null && want.has(Json.optLong(e.index, 0))) {
          sel.push(e);
        }
      }
      const out = [];
      // 逐集取直链要打上游，ep=all 时整部剧可达数百集，串行会超时并刷屏。
      // 前端播放走 /episodes + /stream，不依赖这里的直链；这里只给前若干集取，
      // 其余仍返回完整元信息（vid/index/title），encrypted_url 留空。
      const MAX_URLS = 20;
      let urlCount = 0;
      for (const e of sel) {
        const vid = Json.optStr(e.vid, '');
        const info = urlCount < MAX_URLS ? await urlInfo(vid) : Json.obj();
        urlCount++;
        const row = Json.obj();
        row.index = Json.optLong(e.index, 0);
        row.vid = vid;
        row.title = Json.optStr(e.title, '');
        row.duration = Json.optLong(e.duration, 0);
        row.encrypted_url = info.url;
        row.backup = info.backup;
        row.size = info.size;
        row.definition = info.definition;
        row.url_is_http = info.url_is_http;
        row.stream_url = '/stream?vid=' + vid;
        out.push(row);
      }
      const m = Json.obj();
      m.series_id = sid;
      m.title = Json.optStr((Json.optObj(meta.meta) || {}).title, '');
      m.note = 'encrypted_url 为上游直链（加密集为 CENC 密文）；'
        + '可播放用 stream_url（服务端纯离线解密）；'
        + '为避免超时仅前 ' + MAX_URLS + ' 集附直链，更多请用 ep 参数分段';
      m.episodes = out;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/prewarm') {
      const vid = q.vid;
      if (vid === undefined || vid === null || vid === '') {
        Res.fail(req, res, 400, '需 vid');
        return;
      }
      const state = await Stream.prewarm(vid, q.quality !== undefined ? q.quality : 'best');
      const m = Json.obj();
      m.ok = true;
      m.vid = vid;
      m.state = state;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/video_url') {
      const vid = q.vid;
      if (vid === undefined || vid === null || vid === '') {
        Res.fail(req, res, 400, '缺少 vid');
        return;
      }
      const info = await urlInfo(vid);
      if (info.url === null || info.url === undefined) {
        Res.fail(req, res, 404, '无直链');
        return;
      }
      const m = Json.obj();
      m.vid = vid;
      m.url = info.url;
      m.size = info.size;
      m.definition = info.definition;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/cache/info') {
      const info = Stream.cacheInfo();
      const m = Json.obj();
      m.ok = true;
      m.files = info.files;
      m.bytes = info.bytes;
      m.mb = Math.round((info.bytes / 1048576) * 10) / 10;
      m.free_mb = info.freeBytes === null ? null : Math.round(info.freeBytes / 1048576);
      m.min_free_mb = Config.num('runtime.min_free_mb', 300);
      m.max_files = Config.num('runtime.cache.max_files', 30);
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/cache/keep') {
      // 2026-11-24 起：不再删窗口外文件（多设备会互相删对方的缓存）。
      // 这里只把 vid=a,b,c 这几集（前端给的「本集 + 后两集」）的 mtime 刷新为刚观看，
      // 让它们在 LRU 里排前面；真正删除由 pruneCache 在超过 max_files(默认20) 时按观看时间淘汰。
      const raw = q.vids !== undefined && q.vids !== null ? String(q.vids) : '';
      const vids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d{1,32}$/.test(s));
      if (vids.length === 0) {
        Res.fail(req, res, 400, '需 vids（逗号分隔的分集 id）');
        return;
      }
      const r = Stream.keepWindow(vids);
      const m = Json.obj();
      m.ok = true;
      m.kept = r.kept;
      m.deleted = r.deleted;
      m.freed_mb = Math.round((r.freed / 1048576) * 10) / 10;
      m.failed = r.failed.length;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/cache/delete') {
      // 删除解密缓存：vid=a,b,c 精确删；series_id= 删整部剧；all=1 清空全部
      const all = q.all === '1' || q.all === 'true';
      const vids = (q.vid !== undefined && q.vid !== '') ? String(q.vid).split(',') : [];
      // 按剧删除不能只靠前端给的 vid：前端只记得「看过的那几集」，
      // 预热提前落盘的下一集不在名单里，删完记录缓存还会留着。
      // 这里直接补全该剧的全部分集 vid，保证整部剧的缓存一次删干净。
      const sid = q.series_id !== undefined ? String(q.series_id).trim() : '';
      if (!all && sid !== '') {
        try {
          const meta = await Client.getEpisodes(sid);
          for (const eObj of Json.optArr(meta.episodes)) {
            const e = Json.optObj(eObj);
            const vid = e === null ? '' : Json.optStr(e.vid, '');
            if (vid !== '' && !vids.includes(vid)) vids.push(vid);
          }
        } catch (e) {
          Log.warn('按剧清缓存时获取剧集失败（' + sid + '）：'
            + (e && e.message ? e.message : e));
        }
      }
      let r = Stream.deleteCached(vids, all);
      // 删不掉多半是文件正被播放/解密占用（Windows 尤其常见），等 300ms 再试一轮
      if (r.failed.length > 0) {
        await new Promise((done) => setTimeout(done, 300));
        const again = Stream.deleteCached(vids, all);
        r = {
          deleted: r.deleted + again.deleted,
          freed: r.freed + again.freed,
          failed: again.failed,
        };
      }
      const m = Json.obj();
      m.ok = true;
      m.deleted = r.deleted;
      m.freed_mb = Math.round((r.freed / 1048576) * 10) / 10;
      m.vids = vids.length;
      m.failed = r.failed.length;
      if (r.failed.length > 0) m.failed_files = r.failed.slice(0, 10);
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/stream') {
      // 360p / h264：官网公开的 H.264 直链（免解密、浏览器全兼容），
      // 只有前几集存在，不存在时由前端回落 HEVC 高清档。
      if ((q.quality === '360p' || q.quality === 'h264') && q.vid && /^\d{1,32}$/.test(q.vid)) {
        res.writeHead(302, {
          Location: 'https://hongguoduanju.com/video/public/' + q.vid + '/360p.mp4',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      await this.handleStream(req, res, q);
      return;
    }

    if (method === 'GET' && pathname === '/img') {
      await handleImg(req, res, q);
      return;
    }

    if (method === 'GET' && pathname === '/download') {
      let vid = q.vid;
      const sid = q.series_id;
      if ((vid === undefined || vid === null || vid === '')
          && (sid === undefined || sid === null || sid === '')) {
        Res.fail(req, res, 400, '需 vid 或 series_id');
        return;
      }
      if (sid !== undefined && sid !== null && sid !== '' && (vid === undefined || vid === null || vid === '')) {
        const meta = await Client.getEpisodes(sid);
        const idx = Number.parseInt(q.ep !== undefined ? q.ep : '1', 10);
        for (const eObj of Json.optArr(meta.episodes)) {
          const e = Json.optObj(eObj);
          if (e !== null && Json.optLong(e.index, 0) === idx) {
            vid = Json.optStr(e.vid, '');
            break;
          }
        }
      }
      const file = await Stream.ensureDecrypted(vid, q.quality !== undefined ? q.quality : 'best');
      const m = Json.obj();
      m.ok = true;
      m.path = file;
      m.size = fs.statSync(file).size;
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 批量下载剧集（任务制）----
    // POST /download/task  启动任务：{series_id, start?, end?}，后台执行，立即返回任务快照
    // GET  /download/task?id=  查询进度：done/total/failed/status
    if (pathname === '/download/task') {
      if (method === 'POST') {
        const payload = await readJson(req);
        const sid = payload.series_id !== undefined && payload.series_id !== null
          ? String(payload.series_id).trim() : '';
        if (sid === '') {
          Res.fail(req, res, 400, '缺少 series_id');
          return;
        }
        const startEp = intOrNull(payload.start);
        const endEp = intOrNull(payload.end);
        let t;
        try {
          t = await Download.start(sid, startEp, endEp);
        } catch (e) {
          Res.fail(req, res, 400, String(e && e.message !== undefined ? e.message : e));
          return;
        }
        const m = Json.obj();
        m.ok = true;
        m.task = Download.snapshot(t);
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'GET') {
        const id = q.id !== undefined ? q.id : '';
        const t = Download.get(String(id));
        if (t === null) {
          Res.fail(req, res, 404, '任务不存在或已过期');
          return;
        }
        const m = Json.obj();
        m.ok = true;
        m.task = Download.snapshot(t);
        Res.json(req, res, 200, m);
        return;
      }
    }

    if (method === 'GET' && pathname === '/stats') {
      if (!this.checkAdmin(req, q)) {
        Res.fail(req, res, 401, '需要 admin_token');
        return;
      }
      const m = Json.obj();
      m.uptime_s = Math.floor((Date.now() - this.startTime) / 1000);
      m.requests = this.stats.requests;
      m.errors = this.stats.errors;
      m.risk = this.stats.risk;
      m.auth_fail = this.stats.authFail;
      m.cache_backend = 'memory';
      m.sign_backends = Server.signBackends();
      m.enabled_keys = this.keys.countEnabled();
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 管理接口 ----
    if (pathname.startsWith('/admin/keys')) {
      if (!this.checkAdmin(req, q)) {
        Res.fail(req, res, 401, 'admin_token 无效');
        return;
      }
      if (method === 'GET' && pathname === '/admin/keys') {
        const m = Json.obj();
        m.keys = this.keys.list();
        m.enabled_count = this.keys.countEnabled();
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'POST' && pathname === '/admin/keys') {
        const note = q.note !== undefined ? q.note : '';
        const key = this.keys.generate(note);
        const m = Json.obj();
        m.ok = true;
        m.key = key;
        m.note = note;
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'POST' && pathname === '/admin/keys/revoke') {
        const k = q.key !== undefined ? q.key : '';
        const enable = q.enable === 'true';
        const m = Json.obj();
        m.ok = this.keys.revoke(k, enable);
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'DELETE' && pathname === '/admin/keys') {
        const m = Json.obj();
        m.ok = this.keys.delete(q.key !== undefined ? q.key : '');
        Res.json(req, res, 200, m);
        return;
      }
    }

    // GET 兜底：静态资源 / 404
    if (method === 'GET') {
      await Res.serveStatic(req, res, pathname, this.webDir, webVersion(this.webDir), displayVersion(this.webDir));
      return;
    }
    Res.fail(req, res, 404, 'not found');
  }

  /**
   * 处理 /stream：定位集号 -> 确保解密 -> Range 串流。
   */
  async handleStream(req, res, q) {
    let vid = q.vid;
    let filename = null;

    if (vid === undefined || vid === null || vid === '') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '需 series_id+ep 或 vid');
        return;
      }
      const meta = await Client.getEpisodes(sid);
      const epStr = q.ep !== undefined ? q.ep : '1';
      const idx = /^\d+$/.test(epStr) ? Number.parseInt(epStr, 10) : 1;
      let targetVid = null;
      let title = '';
      for (const eObj of Json.optArr(meta.episodes)) {
        const e = Json.optObj(eObj);
        if (e !== null && Json.optLong(e.index, 0) === idx) {
          targetVid = Json.optStr(e.vid, '');
          break;
        }
      }
      if (targetVid === null) {
        Res.fail(req, res, 404, '集号不存在');
        return;
      }
      vid = targetVid;
      title = Json.optStr((Json.optObj(meta.meta) || {}).title, '');
      filename = Client.sanitize(title) + '_第'
        + String(idx).padStart(3, '0') + '集.mp4';
    }

    const quality = q.quality !== undefined ? q.quality : 'best';
    let file;
    // 播放数据源：openhongguo SDK 优先（前端 /episodes 返回的 vid 即 SDK episodeId）。
    // SDK 取址失败时回落旧 App 协议，保证存量链接仍可播。
    if (q.source !== 'app') {
      try {
        file = await Stream.ensureDecrypted(vid, quality, undefined, 'sdk');
      } catch (e) {
        Log.warn('SDK 播放失败（' + vid + '），回落 App 链路：'
          + (e && e.message ? e.message : e));
        file = await Stream.ensureDecrypted(vid, quality);
      }
    } else {
      file = await Stream.ensureDecrypted(vid, quality);
    }
    if (filename === null) filename = vid + '.mp4';
    await Res.streamFile(req, res, file, vid, filename);
  }
}

/**
 * 单集取直链信息（url / size / definition / url_is_http）。
 *
 * 统一走 Stream.videoTrack（AppSource 的 player/v1 + v5 签名链路）。
 * 取不到时返回空对象（调用方按「无直链」处理），异常只记日志不外抛，
 * 避免一个坏集带垮整个 /play 列表。
 */
async function urlInfo(vid) {
  const info = Json.obj();
  if (vid === null || vid === undefined || vid === '') return info;
  try {
    let t;
    try {
      t = await Stream.sdkTrack(vid, 'best'); // SDK 优先
    } catch (sdkErr) {
      t = await Stream.videoTrack(vid, 'best'); // 回落 App 协议
    }
    if (t === null || t === undefined || t.url === null || t.url === undefined || t.url === '') {
      return info;
    }
    info.url = t.url;
    info.size = t.size;
    info.definition = t.definition;
    info.url_is_http = String(t.url).startsWith('http');
  } catch (e) {
    Log.warn('获取播放地址失败（' + vid + '）：' + (e && e.message ? e.message : e));
  }
  return info;
}

/**
 * 图片代理：红果封面常为 HEIC，浏览器不支持；此处透传。
 */
async function handleImg(req, res, q) {
  const raw = (q.url !== undefined ? q.url : '').trim();
  let uri;
  try {
    uri = new URL(raw);
  } catch (e) {
    Res.fail(req, res, 400, '图片 URL 非法');
    return;
  }
  const scheme = uri.protocol;
  const host = (uri.hostname || '').toLowerCase();
  let hostOk = false;
  for (const h of IMG_HOSTS) {
    if (host === h || host.endsWith('.' + h)) {
      hostOk = true;
      break;
    }
  }
  if ((scheme !== 'http:' && scheme !== 'https:') || !hostOk) {
    Res.fail(req, res, 400, '图片域名不允许');
    return;
  }
  const hit = imgCacheGet(raw);
  if (hit !== null) {
    Res.send(req, res, 200, hit, Res.headers('image/jpeg', 'max-age=86400'));
    return;
  }
  try {
    const r = await Http.send({
      url: raw,
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0' },
      timeoutMs: 30000,
    });
    if (!r.ok()) {
      Res.fail(req, res, 404, '图片读取失败 HTTP ' + r.status);
      return;
    }
    let ct = r.header('content-type');
    if (ct === null || ct === undefined) ct = 'image/jpeg';
    ct = ct.toLowerCase();
    const data = r.body;
    imgCachePut(raw, data);
    Res.send(req, res, 200, data, Res.headers(
      ct.includes('heic') ? 'image/jpeg' : ct, 'max-age=86400'));
  } catch (e) {
    Res.fail(req, res, 404, '图片读取失败: ' + (e && e.message ? e.message : e));
  }
}

/** 解析集号参数：'1' / '1-10' / 'all' -> 集号集合。 */
function parseRange(ep, total) {
  const out = new Set();
  if (ep === null || ep === undefined || ep === '' || ep === 'all') {
    for (let i = 1; i <= total; i++) out.add(i);
    return out;
  }
  const m = /^(\d+)-(\d+)$/.exec(ep);
  if (m) {
    const a = Number.parseInt(m[1], 10);
    const b = Number.parseInt(m[2], 10);
    for (let i = a; i <= b; i++) out.add(i);
    return out;
  }
  if (/^\d+$/.test(ep)) {
    out.add(Number.parseInt(ep, 10));
  }
  return out;
}

/** 读取并解析 JSON 请求体。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 1000000) {
        reject(new Error('body 过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        resolve(Json.obj());
        return;
      }
      try {
        resolve(Json.parseObject(body.toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 取请求头的首个值；缺失返回 null。 */
function header(req, name) {
  const v = req.headers ? req.headers[String(name).toLowerCase()] : undefined;
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return String(v);
}

/** 把请求体/参数里的集号转成整数；缺失或非法返回 null（调用方按「不限制」处理）。 */
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

module.exports = { Server };

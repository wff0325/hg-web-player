'use strict';
/**
 * 本地链路密钥管理（对应原 Java core/KeyStore.java）。
 *
 * 设计：数据接口强制要求有效密钥（x-api-key 头或 ?api_key= 查询参数），
 * 管理接口另用 ADMIN_TOKEN 口令校验，两者分离。
 *
 * 密钥、管理口令、设备身份（device_id）都持久化在同一个文件
 * server/config/apikeys.json，且每次保存都是全量重写，因此统一走进程内单例。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Json = require('../util/json');
const Config = require('../util/config');
const Crypto = require('../util/crypto');
const Log = require('../util/log');

/** 固定位于 server/config（与 config.json 同目录）。 */
const KEYS_FILE = path.join('server', 'config', 'apikeys.json');

/** 密钥记录。 */
class Rec {
  constructor(key = '', note = '', enabled = true, createdAt = '', retiredAt = '') {
    this.key = key;
    this.note = note;
    this.enabled = enabled;
    this.createdAt = createdAt;
    /** 轮换后进入宽限期的时间；空串表示仍在使用中。 */
    this.retiredAt = retiredAt;
  }

  toMap() {
    return {
      key: this.key,
      note: this.note,
      enabled: this.enabled,
      createdAt: this.createdAt,
      retiredAt: this.retiredAt,
    };
  }
}

/** 轮换后旧密钥的宽限期（分钟），给已打开页面留出刷新时间。 */
function graceMs() {
  const m = Config.num('runtime.key_grace_minutes', 30);
  return Math.max(0, m) * 60 * 1000;
}

class KeyStore {
  constructor(file = KEYS_FILE) {
    this.file = file;
    this.keys = new Map(); // key -> Rec
    this._adminToken = '';
    this._adminTokenFresh = false;
    this._deviceId = '';
    this._current = '';
    this._rotatedAt = '';
    this.load();
  }

  /** 持久化文件路径（自检与诊断用）。 */
  storeFile() { return this.file; }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      const root = Json.optObj(Json.parse(raw));
      if (root === null) return;
      this._adminToken = Json.optStr(root.admin_token, '').trim();
      this._deviceId = Json.optStr(root.device_id, '').trim();
      this._current = Json.optStr(root.current_key, '').trim();
      this._rotatedAt = Json.optStr(root.rotated_at, '').trim();
      for (const rowObj of Json.optArr(root.keys)) {
        const row = Json.optObj(rowObj);
        if (row === null) continue;
        const k = Json.optStr(row.key, '');
        if (k === '') continue;
        this.keys.set(k, new Rec(
          k,
          Json.optStr(row.note, ''),
          Json.optBool(row.enabled, true),
          Json.optStr(row.createdAt, ''),
          Json.optStr(row.retiredAt, ''),
        ));
      }
    } catch (e) {
      Log.warn('读取密钥文件失败，使用空集合: ' + e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const rows = [];
      for (const r of this.keys.values()) rows.push(r.toMap());
      const out = { keys: rows };
      // 只在已生成/已读取到管理口令时落盘
      if (this._adminToken !== '') out.admin_token = this._adminToken;
      // device_id 同理：只有显式设置过才写
      if (this._deviceId !== '') out.device_id = this._deviceId;
      if (this._current !== '') out.current_key = this._current;
      if (this._rotatedAt !== '') out.rotated_at = this._rotatedAt;
      fs.writeFileSync(this.file, Json.stringifyPretty(out), 'utf8');
    } catch (e) {
      Log.warn('写入密钥文件失败（仅内存生效）: ' + e.message);
    }
  }

  /** 首次启动时若无任何密钥，自动签发一把本地密钥。 */
  ensureBootstrap() {
    if (this.keys.size > 0) return null;
    return this.generate('bootstrap');
  }

  /**
   * 取管理口令：文件里已有则原样返回，没有则生成一个并写回 apikeys.json。
   * 新生成时 adminTokenFresh() 返回 true。
   */
  ensureAdminToken() {
    if (this._adminToken !== '') return this._adminToken;
    this._adminToken = Crypto.hex(crypto.randomBytes(32));
    this._adminTokenFresh = true;
    this.save();
    return this._adminToken;
  }

  /** 本次启动的管理口令是否为新生成（文件里原本没有）。 */
  adminTokenFresh() { return this._adminTokenFresh; }

  /** 文件里持久化的设备身份；没有则空串。 */
  deviceId() { return this._deviceId; }

  /** 写入设备身份并立即落盘。空值忽略。 */
  setDeviceId(id) {
    if (id === null || id === undefined || id === '') return;
    this._deviceId = String(id).trim();
    this.save();
  }

  generate(note) {
    const key = 'hg_' + Crypto.hex(crypto.randomBytes(24));
    const now = new Date().toISOString();
    this.keys.set(key, new Rec(key, note === null || note === undefined ? '' : note, true, now));
    this._current = key;
    this._rotatedAt = now;
    this.save();
    return key;
  }

  /**
   * 轮换密钥：签发新密钥并设为当前，旧密钥进入宽限期（默认 30 分钟）。
   * 宽限期内旧密钥仍然有效，避免正在播放的页面立刻 401。
   */
  rotate(note) {
    const now = new Date().toISOString();
    if (this._current !== '' && this.keys.has(this._current)) {
      const cur = this.keys.get(this._current);
      if (cur && !cur.retiredAt) cur.retiredAt = now;
    }
    const key = 'hg_' + Crypto.hex(crypto.randomBytes(24));
    this.keys.set(key, new Rec(key, note === null || note === undefined ? 'rotated' : note, true, now));
    this._current = key;
    this._rotatedAt = now;
    this.save();
    Log.info('链路密钥已轮换，新密钥尾号 ' + key.slice(-6));
    return key;
  }

  /** 当前应下发给前端的密钥。 */
  currentKey() {
    if (this._current !== '' && this.isValid(this._current)) return this._current;
    return this.firstEnabled();
  }

  /** 上次轮换时间（ISO），用于判断是否到期。 */
  rotatedAt() { return this._rotatedAt; }

  isValid(key) {
    if (key === null || key === undefined || key === '') return false;
    const r = this.keys.get(String(key));
    if (!r || !r.enabled) return false;
    if (r.retiredAt !== '') {
      const t = Date.parse(r.retiredAt);
      if (!Number.isNaN(t) && Date.now() - t > graceMs()) return false;
    }
    return true;
  }

  list() {
    const out = [];
    for (const r of this.keys.values()) out.push(r.toMap());
    return out;
  }

  /** 找出第一把启用的密钥（自动签发接口用）。 */
  firstEnabled() {
    for (const r of this.keys.values()) if (r.enabled) return r;
    return null;
  }

  get(key) {
    return (key === null || key === undefined) ? null : (this.keys.get(String(key)) || null);
  }

  countEnabled() {
    let n = 0;
    for (const r of this.keys.values()) if (r.enabled) n++;
    return n;
  }

  /** 撤销或启用一把密钥。 */
  revoke(key, enable) {
    const r = (key === null || key === undefined) ? null : this.keys.get(String(key));
    if (!r) return false;
    r.enabled = !!enable;
    this.save();
    return true;
  }

  delete(key) {
    if (key === null || key === undefined) return false;
    const ok = this.keys.delete(String(key));
    if (ok) this.save();
    return ok;
  }
}

/** 进程内单例。 */
let INSTANCE = null;
function store() {
  if (INSTANCE === null) INSTANCE = new KeyStore();
  return INSTANCE;
}

module.exports = { KeyStore, Rec, store, KEYS_FILE };

'use strict';
/**
 * v5 协议常量的自动同步（`--sync-constants`）。
 *
 * 为什么需要：上游改协议时，绝大多数情况只是「常量轮换」——magic / license /
 * signKey / S 盒换一组，算法没变。这种情况可以让脚本自己去上游仓库拉最新的
 * V5Constants.kt、重新生成常量模块，并用上游自带的签名向量验一遍再落盘。
 *
 * 安全边界（重要）：
 *  - 只拉**常量**，不拉可执行代码，不引入任何依赖；
 *  - 落盘前必须过两道向量校验：
 *      1) f13 向量 → 证明**算法没变**（变了就说明不是常量问题，脚本会拒绝写盘）；
 *      2) 载体向量 → 证明**新 S 盒**能复现上游独立 SDK 的加密结果；
 *  - 校验不过一律不写盘，只报告原因；
 *  - 覆盖前先备份成 v5-constants.js.bak。
 */
const fs = require('fs');
const path = require('path');
const Http = require('../util/http');
const Crypto = require('../util/crypto');
const PureSign = require('./pure-sign');

const REPO = 'N3urda/hongguoTV';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/';
const CONSTANTS_PATH = 'kotlin-tv/core/src/main/kotlin/com/hongguotv/core/V5Constants.kt';
const F13_PATH = 'kotlin-tv/core/src/test/resources/signing-v5-f13.json';
const CARRIER_PATH = 'kotlin-tv/core/src/test/resources/signing-v5-carrier.json';

/** 常量模块位置。 */
const TARGET = path.join(__dirname, 'v5-constants.js');

/** 拉一个文本文件。 */
async function fetchText(url) {
  const res = await Http.send({
    url, method: 'GET', timeoutMs: 20000,
    headers: { 'user-agent': 'hongguo-web-sync' },
  });
  if (res.status !== 200) throw new Error('拉取失败 HTTP ' + res.status + '：' + url);
  return res.text();
}

/** 从 V5Constants.kt 里抽出常量（与上游文件结构一一对应）。 */
function parseConstants(kt) {
  const hexOf = (name) => {
    const re = new RegExp('val\\s+' + name + '\\s*=\\s*hex\\(([\\s\\S]*?)\\)\\s*\\n');
    const m = re.exec(kt);
    if (!m) throw new Error('V5Constants.kt 里找不到 ' + name);
    const hex = [...m[1].matchAll(/"([0-9a-fA-F]*)"/g)].map((x) => x[1]).join('');
    if (hex === '' || hex.length % 2 !== 0) throw new Error(name + ' 的十六进制不合法');
    return hex.toLowerCase();
  };
  const lic = /const val license = "(\d+)"/.exec(kt);
  if (!lic) throw new Error('V5Constants.kt 里找不到 license');
  const magic = hexOf('magic');
  const signKey = hexOf('signKey');
  const sbox = hexOf('sbox');
  if (magic.length !== 32) throw new Error('magic 应为 16 字节，实际 ' + magic.length / 2);
  if (signKey.length !== 64) throw new Error('signKey 应为 32 字节，实际 ' + signKey.length / 2);
  if (sbox.length !== 2048) throw new Error('sbox 应为 1024 字节，实际 ' + sbox.length / 2);
  return { magic, signKey, sbox, license: lic[1] };
}

/** 生成常量模块源码（格式与现有文件一致，便于 diff）。 */
function renderModule(c) {
  const sboxLines = c.sbox.match(/.{1,96}/g).map((s) => "  '" + s + "'").join(' +\n');
  return `'use strict';
/**
 * 红果 Android v5 签名协议常量（v04.10.03）。
 *
 * 来源：${REPO} kotlin-tv/core/src/main/kotlin/com/hongguotv/core/V5Constants.kt
 * （GPL-3.0-only）。此处只是把上游 Kotlin 常量表原样搬到 JS，数值未做任何改动；
 * 这些是协议线格式常量与 App 内置协议密钥，不是用户账号凭据。
 *
 * 可用 \`node server/src/main.js --sync-constants --apply\` 自动重新生成。
 */
const Crypto = require('../util/crypto');

/** medusa 明文里的 16 字节 magic。 */
const MAGIC16 = Crypto.unhex('${c.magic}');

/** x-medusa 字段 6 的 license 号。 */
const LICENSE = '${c.license}';

/** medusa keyHash 使用的 32 字节协议密钥。 */
const SIGN_KEY = Crypto.unhex('${c.signKey}');

/** v5 AesV3 的 4 段（每段 256 字节）S 盒，按 khronos & 3 选段。 */
const SBOX = Crypto.unhex(
${sboxLines});

module.exports = { MAGIC16, LICENSE, SIGN_KEY, SBOX };
`;
}

/** 去掉 CR 便于比较。 */
const normalize = (s) => String(s).replace(/\r\n/g, '\n');

/**
 * 本地常量是否与上游解析结果「值相同」。
 *
 * 只比值不比文本：注释、换行、缩进都不该影响判断，否则每次生成都会误报「有更新」。
 */
function sameConstants(parsed) {
  try {
    delete require.cache[require.resolve(TARGET)];
    const cur = require(TARGET);
    return cur.MAGIC16.toString('hex') === parsed.magic
      && cur.SIGN_KEY.toString('hex') === parsed.signKey
      && cur.SBOX.toString('hex') === parsed.sbox
      && cur.LICENSE === parsed.license;
  } catch (e) {
    return false;
  }
}

/**
 * 用上游向量校验「候选常量 + 当前代码」。
 *
 * @param {object} cand 候选常量（sbox 为 hex）
 * @param {object} fx 向量集 {f13:[...], carrier:[...]}
 * @returns {{algorithm:boolean, sbox:boolean, f13:number, carrier:number, total:number}}
 */
function verifyConstants(cand, fx) {
  const hex = (s) => Buffer.from(s, 'hex');
  const le32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return b;
  };

  // 1) f13：只依赖算法与轮表，与常量无关 → 用来判断「算法是否也变了」
  let f13Ok = 0;
  for (const row of fx.f13) {
    try {
      const got = PureSign.hashF13V5(hex(row.query), hex(row.body), le32(row.ts), row.ts);
      if (got.subarray(0, 16).toString('hex') === row.digest
          && got.length === 20 && (got[16] & 0x24) === 0x24) f13Ok++;
    } catch (e) { /* 计为失败 */ }
  }

  // 2) 载体：直接用候选 S 盒跑 AesV3 v5 → 验证新 S 盒是否与上游一致
  let carOk = 0;
  const sbox = hex(cand.sbox);
  for (const row of fx.carrier) {
    try {
      const got = new PureSign.AesV3(hex(row.key), row.ts, true, sbox)
        .encrypt(hex(row.source), hex(row.iv)).toString('hex');
      if (got === row.encrypted) carOk++;
    } catch (e) { /* 计为失败 */ }
  }

  return {
    algorithm: f13Ok === fx.f13.length,
    sbox: carOk === fx.carrier.length,
    f13: f13Ok,
    carrier: carOk,
    total: fx.f13.length + fx.carrier.length,
  };
}

/** 拉上游向量集。 */
async function fetchFixtures() {
  const f13 = JSON.parse(await fetchText(RAW + F13_PATH));
  const carrier = JSON.parse(await fetchText(RAW + CARRIER_PATH));
  return { f13, carrier };
}

/**
 * 检查（并在 --apply 时应用）上游常量更新。
 *
 * @param {{apply:boolean}} [opts]
 * @returns {Promise<object>}
 */
async function sync(opts) {
  const apply = opts !== null && opts !== undefined && opts.apply === true;
  const kt = await fetchText(RAW + CONSTANTS_PATH);
  const parsed = parseConstants(kt);
  const next = renderModule(parsed);

  let current = '';
  try { current = fs.readFileSync(TARGET, 'utf8'); } catch (e) { current = ''; }
  const detail = {
    magic: parsed.magic,
    license: parsed.license,
    signKeyHead: parsed.signKey.slice(0, 16) + '…',
    sboxBytes: parsed.sbox.length / 2,
  };
  if (sameConstants(parsed)) {
    return { changed: false, applied: false, note: '常量与上游一致，无需更新', detail };
  }

  const fx = await fetchFixtures();
  const v = verifyConstants(parsed, fx);
  detail.verify = v;

  if (!v.algorithm) {
    return {
      changed: true, applied: false,
      note: 'f13 向量对不上：上游改的是**算法**（不是常量），需要移植新代码，本次不写盘',
      detail,
    };
  }
  if (!v.sbox) {
    return {
      changed: true, applied: false,
      note: '新 S 盒复现不了载体向量（' + v.carrier + '/' + fx.carrier.length
        + '）：常量结构变了或算法也变了，本次不写盘',
      detail,
    };
  }
  if (!apply) {
    return {
      changed: true, applied: false,
      note: '发现新常量且已通过向量校验（未写入）。加 --apply 落盘，旧文件会备份为 .bak',
      detail,
    };
  }

  const backup = TARGET + '.bak';
  if (current !== '') fs.writeFileSync(backup, current);
  fs.writeFileSync(TARGET, next);
  return {
    changed: true, applied: true,
    note: '已更新常量并通过向量校验（旧文件备份为 v5-constants.js.bak）', detail,
  };
}

/** 本地常量能否正常加载（--check 用）。 */
function localOk() {
  try {
    const mod = require(TARGET);
    return mod.MAGIC16.length === 16 && mod.SIGN_KEY.length === 32
      && mod.SBOX.length === 1024 && /^\d+$/.test(mod.LICENSE);
  } catch (e) {
    return false;
  }
}

module.exports = { sync, localOk, parseConstants, renderModule, verifyConstants, REPO };

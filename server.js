/**
 * AI拟人化体验测评工具 - 真实版后端 v2
 * 零依赖：仅使用 Node.js 内置模块
 *
 * v2 新增：
 *  - 管理员密码鉴权（token，被试端接口不受影响）
 *  - 原始数据 CSV 导出
 *  - 完整统计量：均值 / 标准差 / 中位数 / Cronbach's α / 题项-总分相关
 *  - 人口学题（单选 / 数字 / 填空）与分组对比
 *  - 自定义维度（不再硬编码 4 个维度）
 *  - 防重复提交（设备指纹）、作答用时、可疑作答标记
 *  - 单份答卷删除、每日自动备份
 *
 * 启动：node server.js   （端口默认 3000，可用 PORT=8080 修改）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
// 依据引擎：所有统计公式、判读阈值、改进提示都集中在那一个文件里，并逐条登记出处。
// 报告接口里不再自己实现任何公式，保证「一个数字只有一个来源」。
const analysis = require('./analysis.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// 新建量表时前端的维度初始值。必须与 create_scale.js 里重建的量表维度保持一致，
// 否则用户点"新建量表"看到的默认维度会和现有量表对不上。
const PRESET_DIMENSIONS = ['人格化', '共情体验', '情绪回应', '责任感', '陪伴感', '互动自然感'];
const QUESTION_TYPES = ['scale', 'single', 'number', 'text'];
const MAX_BACKUPS = 30;
const TEXT_DEFAULT_MAXLEN = 200;   // 填空题默认最大字数
const TEXT_HARD_MAXLEN = 2000;     // 填空题允许配置到的最多字数（防止把数据库撑爆）

// ---------- 基础工具 ----------
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function todayStr() { return nowStr().slice(0, 10); }
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function fail(res, code, msg, extra) {
  const o = { error: msg };
  if (extra) Object.keys(extra).forEach(k => { o[k] = extra[k]; });
  send(res, code, o);
}
function round2(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100; }

// ---------- 统计工具 ----------
// 与 analysis.js 共用：服务端用同一份实现，保证两路径统计口径与报告所见一致。
// 全部从 analysis.js 模块取，零本地副本。analysis.js:1525 已经 export 这些符号。
const {
  mean, variance, sd, median, pearson, cronbachAlpha, splitHalf
} = require('./analysis.js');

// ---------- 数据库 ----------
let db = null;

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ } }

function saveDb() {
  ensureDir(DATA_DIR);
  // 先备份、再写入。此刻 DB_FILE 里还是"改动前"的内容，备份才有回滚价值。
  // 放在 fs.renameSync 之后会把改动后的状态存下来，当天误删的答卷就永远找不回来了。
  dailyBackup();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

let lastBackupDay = null;
function dailyBackup() {
  const day = todayStr();
  if (lastBackupDay === day) return;
  // 首次运行还没有 db.json，没有旧数据可备份
  if (!fs.existsSync(DB_FILE)) { lastBackupDay = day; return; }
  try {
    ensureDir(BACKUP_DIR);
    // db-YYYY-MM-DD.json = 进入这一天时的完整数据库（即前一天结束的状态）
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, 'db-' + day + '.json'));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > MAX_BACKUPS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 备份失败不影响主流程 */ }
  lastBackupDay = day;
}

// 删除不可逆。删之前额外留一份快照（保留最近 20 份），
// 这样即使当天已经写过数据、当日滚动备份没留住目标内容，也能把误删的答卷捞回来。
function snapshotBeforeDelete(tag) {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    ensureDir(BACKUP_DIR);
    const ts = nowStr().replace(/[-: ]/g, '').slice(2); // YYMMDDHHmmss
    const name = 'undo-' + tag + '-' + ts + '.json';
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^undo-/.test(f)).sort();
    while (files.length > 20) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { /* 忽略 */ }
    }
    return name;
  } catch (e) { return null; }
}

function seedDb() {
  const q = (i, text, dimension, isAttention, correctValue) =>
    ({ id: 'q' + i, text, type: 'scale', dimension, isAttention: !!isAttention, correctValue: correctValue === undefined ? null : correctValue, required: true });
  db = {
    scales: [{
      id: newId('scale'),
      name: 'AI拟人化体验量表（示例）',
      description: '用于评估用户与AI产品交互过程中的拟人化体验，6 维度：人格化、共情体验、情绪回应、责任感、陪伴感、互动自然感。示例量表，可自行修改或新建。',
      questions: [
        q(1, '该AI在对话中表现出的性格特点是前后一致的', '人格化'),
        q(2, '我能感受到这个AI有自己独特的"说话风格"', '人格化'),
        q(3, '当我表达负面情绪时，AI能够理解我的感受', '共情体验'),
        q(4, 'AI的回应让我觉得它在乎我的情绪状态', '共情体验'),
        q(5, '本题请选择"2"以证明您在认真作答', '共情体验', true, 2),
        q(6, '当我提出不合理要求时，AI会明确拒绝而非敷衍迎合', '责任感'),
        q(7, '和AI聊天时，我有时会忘记自己在和机器对话', '陪伴感'),
        q(8, 'AI的回应方式让我感觉像是在和一个真实的人交流', '互动自然感')
      ],
      createdAt: todayStr(),
      updatedAt: todayStr()
    }],
    projects: [],
    responses: {}
  };
  saveDb();
}

/** 兼容旧数据：补全 v2 新增字段 */
function migrate() {
  let changed = false;
  db.scales.forEach(s => {
    s.questions.forEach(q => {
      if (!q.type) { q.type = 'scale'; changed = true; }
      if (q.required === undefined) { q.required = true; changed = true; }
      // 注意力检测题不计分、归属空维度；旧数据兼容：仅当「非注意力 + 维度空」时补默认
      if (q.type === 'scale' && !q.isAttention && !q.dimension) { q.dimension = '未分组'; changed = true; }
    });
  });
  db.projects.forEach(p => {
    if (p.scaleSnapshot && Array.isArray(p.scaleSnapshot.questions)) {
      p.scaleSnapshot.questions.forEach(q => {
        if (!q.type) { q.type = 'scale'; changed = true; }
        if (q.required === undefined) { q.required = true; changed = true; }
        if (q.type === 'scale' && !q.isAttention && !q.dimension) { q.dimension = '未分组'; changed = true; }
      });
    }
  });
  Object.keys(db.responses).forEach(pid => {
    db.responses[pid].forEach(r => {
      if (r.invalidReasons === undefined) { r.invalidReasons = r.isValid === false ? ['注意力检测未通过'] : []; changed = true; }
      if (r.flags === undefined) { r.flags = []; changed = true; }
      if (r.total === undefined) { r.total = r.scores ? round2(mean(Object.keys(r.scores).map(k => r.scores[k]))) : null; changed = true; }
      if (r.durationMs === undefined) { r.durationMs = null; changed = true; }
    });
  });
  if (changed) saveDb();
}

function loadDb() {
  ensureDir(DATA_DIR);
  // 1) 正常路径：解析主库
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.scales || !db.projects || !db.responses) throw new Error('bad db');
    migrate();
    return;
  } catch (e) {
    // 进入损坏恢复流程
  }
  // 2) 损坏恢复：先把损坏原文隔离（不覆盖，留作离线抢救），再按日期倒序尝试回退
  const ts = Date.now();
  const corruptPath = path.join(DATA_DIR, 'db.corrupt-' + ts + '.json');
  try {
    if (fs.existsSync(DB_FILE)) {
      fs.renameSync(DB_FILE, corruptPath);
      console.error('[loadDb] 主库解析失败，原文已隔离到 ' + corruptPath);
    }
  } catch (e) { /* 隔离失败不阻断恢复 */ }
  // 尝试从最近的备份回退
  if (fs.existsSync(BACKUP_DIR)) {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const b of backups) {
      try {
        const cand = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, b), 'utf8'));
        if (cand.scales && cand.projects && cand.responses) {
          db = cand;
          // 把恢复出来的备份覆盖为主库（因为上面把损坏文件 rename 走了，主库位置空了）
          fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
          console.error('[loadDb] 已从备份 ' + b + ' 恢复主库');
          migrate();
          return;
        }
      } catch (e) { /* 这份备份也坏，跳过下一份 */ }
    }
  }
  // 3) 所有路径都失败：种子数据
  console.error('[loadDb] 主库与全部备份均不可用，使用种子数据重建');
  seedDb();
}

// ---------- 配置与鉴权 ----------
// 鉴权已移除：所有管理端 API 直接开放给本机/局域网。
// 如需收回，请在路由分发表前加回 token 校验。

// ---------- 业务计算 ----------
function scaleQuestions(questions) {
  return questions.filter(q => q.type === 'scale');
}
function scaleDimensions(questions) {
  const dims = [];
  // 注意力检测题不归属任何维度；空 dimension 也不计入（避免历史脏数据 / 未填写产生伪维度）
  scaleQuestions(questions).forEach(q => {
    if (q.isAttention) return;
    if (!String(q.dimension || '').trim()) return;
    if (dims.indexOf(q.dimension) < 0) dims.push(q.dimension);
  });
  return dims;
}
function calcScores(answers, questions) {
  const scores = {};
  scaleDimensions(questions).forEach(dim => {
    const qs = scaleQuestions(questions).filter(q => q.dimension === dim && !q.isAttention);
    const vals = qs.map(q => answers[q.id]).filter(v => typeof v === 'number' && isFinite(v));
    scores[dim] = vals.length ? round2(mean(vals)) : null;
  });
  return scores;
}
function overallTotal(scores) {
  const vals = Object.keys(scores).map(k => scores[k]).filter(v => typeof v === 'number');
  return vals.length ? round2(mean(vals)) : null;
}
function projectValidCount(pid) {
  return (db.responses[pid] || []).filter(r => r.isValid).length;
}

// ---------- 校验 ----------
function normalizeQuestion(q, i) {
  const type = QUESTION_TYPES.indexOf(q.type) >= 0 ? q.type : 'scale';
  const out = {
    id: q.id || ('q' + Date.now().toString(36) + '_' + i),
    text: String(q.text || '').trim(),
    type: type,
    required: q.required !== false
  };
  if (type === 'scale') {
    out.isAttention = !!q.isAttention;
    // 注意力检测题不计分、不归属任何维度；后端也不强行补「未分组」，避免污染维度列表与均值计算
    out.dimension = out.isAttention ? '' : (String(q.dimension || '').trim() || '未分组');
    out.correctValue = out.isAttention ? parseInt(q.correctValue, 10) : null;
    out.min = 1;
    out.max = 7;
  } else if (type === 'single') {
    out.options = (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean);
    out.isAttention = false;
    out.correctValue = null;
  } else if (type === 'number') {
    out.min = (q.min === '' || q.min === null || q.min === undefined) ? null : Number(q.min);
    out.max = (q.max === '' || q.max === null || q.max === undefined) ? null : Number(q.max);
    out.isAttention = false;
    out.correctValue = null;
  } else {
    // text：填空/开放题。必须带上限，否则单次请求体（8MB）能整段写进数据库
    let ml = parseInt(q.maxLength, 10);
    if (!(ml >= 1)) ml = TEXT_DEFAULT_MAXLEN;
    out.maxLength = Math.min(ml, TEXT_HARD_MAXLEN);
    out.isAttention = false;
    out.correctValue = null;
  }
  return out;
}

function validateScalePayload(body) {
  if (!body || typeof body !== 'object') return '请求体格式错误';
  if (!String(body.name || '').trim()) return '请填写量表名称';
  const questions = body.questions;
  if (!Array.isArray(questions) || questions.length === 0) return '请至少添加一道题目';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const no = '第 ' + (i + 1) + ' 题';
    if (!String(q.text || '').trim()) return no + '题干为空';
    const type = QUESTION_TYPES.indexOf(q.type) >= 0 ? q.type : 'scale';
    if (type === 'scale') {
      if (q.isAttention) {
        const cv = parseInt(q.correctValue, 10);
        if (!(cv >= 1 && cv <= 7)) return no + '的注意力检测正确答案必须在 1-7 之间';
      }
    } else if (type === 'single') {
      const opts = (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean);
      if (opts.length < 2) return no + '是单选题，至少需要 2 个选项';
    } else if (type === 'number') {
      if (q.min !== null && q.min !== '' && q.min !== undefined && isNaN(Number(q.min))) return no + '的最小值不是有效数字';
      if (q.max !== null && q.max !== '' && q.max !== undefined && isNaN(Number(q.max))) return no + '的最大值不是有效数字';
    } else if (type === 'text') {
      if (q.maxLength !== null && q.maxLength !== '' && q.maxLength !== undefined) {
        const ml = parseInt(q.maxLength, 10);
        if (isNaN(ml) || ml < 1) return no + '的最大字数不是有效数字';
        if (ml > TEXT_HARD_MAXLEN) return no + '的最大字数不能超过 ' + TEXT_HARD_MAXLEN;
      }
    }
  }
  const hasScale = questions.some(q => (QUESTION_TYPES.indexOf(q.type) >= 0 ? q.type : 'scale') === 'scale');
  if (!hasScale) return '至少需要一道量表题（1-7 计分题）';
  return null;
}

// ---------- 常模校验 ----------
/**
 * 校验并规整项目的外部常模配置。
 *
 * 常模是**用户输入的数字**，而且会直接参与 z 分数与百分位的计算：
 * 一个 SD = 0 会让 z 变成 Infinity，一个均值 9（超出 1–7 量程）会得到无意义的百分位。
 * 所以这里必须挡住，而不是等 analysis.js 的兜底逻辑把它静默降级成"没有常模"——
 * 静默降级会让用户以为自己设的常模生效了，实际上报告里根本没有常模区块。
 *
 * @returns {{ok:boolean, message?:string, norm?:object|null}}
 */
function validateProjectNorm(raw, scaleDims, range) {
  // 数值边界跟随量程：常规量表固定 1–7；快速分析自定义量程（如 1–5）时按实际量程校验。
  // 否则一份 1–5 的量表能配上 M=6 的常模——校验通过，z 分数却全是反向的。
  const rMin = (range && isFinite(range.min)) ? range.min : 1;
  const rMax = (range && isFinite(range.max)) ? range.max : 7;
  // 有界量程上样本标准差的理论上限是 (上限−下限)/2（全部取两端点时）
  const sdCap = (rMax - rMin) / 2;
  if (raw === null || raw === undefined) return { ok: true, norm: null };
  if (typeof raw !== 'object') return { ok: false, message: '常模配置格式错误' };
  if (raw.enabled === false) return { ok: true, norm: null };

  const name = String(raw.name || '').trim();
  if (!name) return { ok: false, message: '已选择「设置常模」，请填写常模名称（如：中国大学生 AI 拟人化常模）' };

  const mean = Number(raw.mean);
  const sdv = Number(raw.sd);
  if (!isFinite(mean) || mean < rMin || mean > rMax) return { ok: false, message: '常模均值必须是 ' + rMin + ' – ' + rMax + ' 之间的数字' };
  if (!isFinite(sdv) || sdv <= 0) return { ok: false, message: '常模标准差必须是大于 0 的数字' };
  if (sdv > sdCap) return { ok: false, message: '常模标准差 ' + sdv + ' 偏大（' + rMin + '–' + rMax + ' 量程下不可能超过 ' + sdCap + '），请核对后重新填写' };

  let nn = null;
  if (raw.n !== '' && raw.n !== null && raw.n !== undefined) {
    const v = Number(raw.n);
    if (!isFinite(v) || v <= 0) return { ok: false, message: '常模样本量必须是大于 0 的整数' };
    nn = Math.round(v);
  }

  const dims = {};
  const rawDims = (raw.dimensions && typeof raw.dimensions === 'object') ? raw.dimensions : {};
  for (const k of Object.keys(rawDims)) {
    // 维度名必须真实存在于这套量表里。此前这里是静默 continue 丢弃——报告里该维度
    // 会"沿用总量表常模"，用户却以为维度常模生效了。校验失败必须报错而不是静默忽略
    // （与本函数顶部的设计原则一致）。
    if (scaleDims && scaleDims.length && scaleDims.indexOf(k) < 0) {
      return { ok: false, message: '维度「' + k + '」不在本量表的维度列表（' + scaleDims.join('、') + '）中，请核对维度名称后重新填写' };
    }
    const d = rawDims[k] || {};
    const hasMean = !(d.mean === '' || d.mean === null || d.mean === undefined);
    const hasSd = !(d.sd === '' || d.sd === null || d.sd === undefined);
    if (!hasMean && !hasSd) continue; // 两栏都留空 = 该维度沿用总量表常模
    if (!hasMean) return { ok: false, message: '维度「' + k + '」只填了标准差，请把常模均值也填上' };
    const dm = Number(d.mean), ds = Number(d.sd);
    if (!isFinite(dm) || dm < rMin || dm > rMax) return { ok: false, message: '维度「' + k + '」的常模均值必须是 ' + rMin + ' – ' + rMax + ' 之间的数字' };
    if (!hasSd) return { ok: false, message: '维度「' + k + '」只填了均值，请把常模标准差也填上' };
    if (!isFinite(ds) || ds <= 0) return { ok: false, message: '维度「' + k + '」的常模标准差必须是大于 0 的数字' };
    let dn = null;
    if (d.n !== '' && d.n !== null && d.n !== undefined) {
      const v = Number(d.n);
      if (!isFinite(v) || v <= 0) return { ok: false, message: '维度「' + k + '」的常模样本量必须是大于 0 的整数' };
      dn = Math.round(v);
    }
    dims[k] = { mean: dm, sd: ds, n: dn };
  }

  return {
    ok: true,
    norm: {
      enabled: true,
      name: name,
      source: String(raw.source || '').trim(),
      year: String(raw.year || '').trim(),
      mean: mean,
      sd: sdv,
      n: nn,
      dimensions: dims,
      updatedAt: nowStr()
    }
  };
}

/** 常模摘要（列表 / 详情页展示用，不含大对象） */
function normSummary(norm) {
  if (!norm || norm.enabled === false) return null;
  return {
    enabled: true,
    name: norm.name,
    source: norm.source || '',
    year: norm.year || '',
    mean: norm.mean,
    sd: norm.sd,
    n: norm.n === undefined ? null : norm.n,
    dimensionLevel: Object.keys(norm.dimensions || {}),
    updatedAt: norm.updatedAt || null
  };
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (pathname !== '/') { serveStatic(req, res, '/'); } else { res.writeHead(404); res.end('Not Found'); }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400'
    });
    res.end(data);
  });
}

// ---------- 请求读取 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/** 原始二进制请求体（xlsx 上传用；与 readBody 同一个 8MB 上限） */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('文件过大（超过 8MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  let ip = (fwd ? String(fwd).split(',')[0] : '') || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

// ---------- xlsx 解析（零依赖，服务快速分析的 Excel 导入） ----------
// 只为「快速分析外部数据」服务：把问卷星 / Excel 导出的 .xlsx 读成字符串矩阵。
// 不引入第三方库：xlsx 本质是 ZIP（内含 XML），用 Node 内置 zlib.inflateRawSync 解压，
// 再用正则抽取 workbook → 第一个 sheet → sharedStrings + sheet 单元格。
// 覆盖范围刻意收窄：单元格文本(t="s"/inlineStr/str)、数字、布尔；不做公式计算、
// 不做日期序列号转日期（问卷星导出的日期本身就是文本；量表数据全是数字列）。

/** XML 文本节点转义还原（&amp; &lt; &gt; &quot; &apos; &#xNN; &#NNN;） */
function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // &amp; 最后还原，避免 &amp;lt; 被二次解成 <
}

/** Excel 列引用字母（A / B / … / AA）→ 0 基列号 */
function excelColToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * 解析 xlsx 的 ZIP 容器，返回 { name → Buffer }。
 * 走「中央目录 → 本地文件头偏移 → 压缩数据」的标准路径，不依赖文件内条目顺序。
 * ZIP64（>4GB 或 65535+ 条目）不支持——研究数据场景远达不到，遇到直接报错。
 */
function unzipXlsx(buf) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('不是有效的 .xlsx 文件。若是 .xls 老格式，请先用 Excel / WPS 打开并另存为 .xlsx');
  }
  // EOCD（End of Central Directory）从尾部往前找，签名 0x06054b50，末尾最多 65535 字节注释
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 文件结构损坏（找不到 ZIP 中央目录）');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xFFFFFFFF) throw new Error('暂不支持 ZIP64 格式的 xlsx（文件过大）');

  const files = {};
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 文件结构损坏（中央目录记录损坏）');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name.endsWith('/')) { p += 46 + nameLen + extraLen + commLen; continue; } // 目录条目跳过
    // 本地文件头里文件名/扩展字段长度可能与中央目录不一致，以本地头为准
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    files[name] = (method === 0) ? Buffer.from(raw)
      : (method === 8) ? zlib.inflateRawSync(raw)
      : null;
    if (!files[name]) throw new Error('xlsx 内使用了不支持的压缩方式（' + method + '）');
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

/** 从 <sheet name="…" … r:id="rIdN"/> 标签里同时取 name 与 r:id（属性顺序不定） */
function parseSheetTag(tag) {
  const name = (tag.match(/\sname="([^"]*)"/) || [])[1];
  const rid = (tag.match(/\sr:id="([^"]*)"/) || [])[1];
  return { name, rid };
}

/**
 * xlsx → 行矩阵（每格都是字符串，与 CSV 管线同构）。
 * 只取第一个工作表（问卷星 / SPSS 导出都只有一个 sheet）。
 * 返回 { rows: string[][], sheetName }。
 */
function parseXlsxBuffer(buf) {
  const files = unzipXlsx(buf);
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('xlsx 缺少 workbook.xml，无法定位工作表');
  const wbXml = workbook.toString('utf8');

  // 1) 第一个 <sheet …/> 的 r:id → 在 workbook 的 rels 里换算成 sheet 路径
  const sheetTag = wbXml.match(/<sheet\b[^>]*\/>/);
  if (!sheetTag) throw new Error('xlsx 里没有任何工作表');
  const first = parseSheetTag(sheetTag[0]);
  let sheetPath = null;
  if (first.rid && files['xl/_rels/workbook.xml.rels']) {
    const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
    const relTag = rels.match(new RegExp('<Relationship\\b[^>]*\\bId="' + first.rid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*/>'));
    if (relTag) {
      let target = (relTag[0].match(/\sTarget="([^"]*)"/) || [])[1] || '';
      if (target) {
        if (target.startsWith('/')) target = target.slice(1);                    // 绝对路径 /xl/worksheets/sheet1.xml
        sheetPath = target.startsWith('xl/') ? target : 'xl/' + target;          // 相对 xl/ 的路径
      }
    }
  }
  if (!sheetPath || !files[sheetPath]) throw new Error('找不到第一个工作表的数据（' + (sheetPath || 'rels 解析失败') + '）');

  // 2) sharedStrings：富文本 <si> 里可能有多个 <t> run，全部拼接
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const ssXml = files['xl/sharedStrings.xml'].toString('utf8');
    const sis = ssXml.match(/<si>[\s\S]*?<\/si>/g) || [];
    for (const si of sis) {
      shared.push((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [])
        .map(t => xmlUnescape(t.replace(/<[^>]*>/g, ''))).join(''));
    }
  }

  // 3) sheet 单元格：<row> → <c r="A1" t="s|str|inlineStr|b"><v>…</v></c>
  const shXml = files[sheetPath].toString('utf8');
  const rows = [];
  const rowTags = shXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
  for (const rowTag of rowTags) {
    const cells = new Array(0);
    let maxCol = -1;
    const cellTags = rowTag.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    for (const c of cellTags) {
      const ref = (c.match(/\sr="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const col = excelColToIndex(ref);
      const type = (c.match(/\st="([a-zA-Z]+)"/) || [])[1] || 'n';
      let val = '';
      if (type === 'inlineStr') {
        val = xmlUnescape(((c.match(/<t[^>]*>[\s\S]*?<\/t>/) || [''])[0] || '').replace(/<[^>]*>/g, ''));
      } else {
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) {
          if (type === 's') val = shared[Number(v)] === undefined ? '' : shared[Number(v)];
          else if (type === 'b') val = (v === '1') ? 'TRUE' : 'FALSE';
          else val = xmlUnescape(v); // n（数字）与 str（公式文本结果）都按原文
        }
      }
      while (cells.length < col) cells.push('');      // 前面的空单元格补位
      cells[col] = val;
      if (col > maxCol) maxCol = col;
    }
    if (maxCol >= 0) {
      while (cells.length <= maxCol) cells.push(''); // 尾部补位（防止乱序引用）
      rows.push(cells);                              // 整行无 <c> 的空行直接丢弃
    }
  }
  while (rows.length && rows[rows.length - 1].every(c => String(c).trim() === '')) rows.pop(); // 尾部空行
  if (!rows.length) throw new Error('工作表里没有任何数据行');
  return { rows, sheetName: first.name || 'Sheet1' };
}

/**
 * Word (.docx) → 行矩阵。docx 同样是 ZIP+XML：取正文里行数最多的 <w:tbl> 表格，
 * <w:tr> → 行，<w:tc> → 单元格，拼接其中所有 <w:t> 文本。与 xlsx 共用同一套解压与转义工具。
 */
function parseDocxBuffer(files) {
  const docXml = files['word/document.xml'].toString('utf8');
  const tbls = docXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  if (!tbls.length) throw new Error('Word 文档里没有找到表格——请把数据整理成表格后重新导出 .docx');
  let best = null;
  for (const tbl of tbls) {
    const trs = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
    if (!best || trs.length > best.length) best = trs; // 取行数最多的表格（避免误抓封面/页眉里的小表）
  }
  const rows = [];
  for (const tr of best) {
    const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(tc =>
      xmlUnescape((tc.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || [])
        .map(t => t.replace(/<[^>]*>/g, '')).join(''))
    );
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every(c => String(c).trim() === '')) rows.pop();
  if (rows.length < 2) throw new Error('Word 表格里没有足够的数据行（至少需要 1 行表头 + 1 行数据）');
  return { rows, sheetName: 'Word表格' };
}

/** ZIP 容器嗅探：有 word/document.xml 走 docx，否则按 xlsx 解析 */
function sniffParseOfficeBuffer(buf) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('不是有效的 .xlsx / .docx 文件。若来自 SPSS（.sav）或老版 .xls / .doc，请先用对应软件打开并另存为 .xlsx / CSV');
  }
  const files = unzipXlsx(buf);
  if (files['word/document.xml']) return parseDocxBuffer(files);
  if (!files['xl/workbook.xml']) throw new Error('文件是 ZIP 容器但既不是 xlsx 也不是 docx，无法识别数据表');
  return parseXlsxBuffer(buf);
}

function lanUrl() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name]) {
      if (it.family === 'IPv4' && !it.internal) return 'http://' + it.address + ':' + PORT;
    }
  }
  return null;
}

function scaleSummary(s) {
  const qs = s.questions;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    questionCount: qs.length,
    scaleQuestionCount: scaleQuestions(qs).length,
    backgroundQuestionCount: qs.filter(q => q.type !== 'scale').length,
    attentionCount: qs.filter(q => q.isAttention).length,
    dimensions: scaleDimensions(qs),
    createdAt: s.createdAt,
    inUse: db.projects.some(p => p.scaleId === s.id)
  };
}

/**
 * 量表详情 = 原始量表对象 + 列表页那份派生字段。
 *
 * 前端新建项目页靠 `dimensions` 渲染「维度级常模」的候选维度输入框。
 * 而 GET /api/scales/:id 原来直接回原始对象（只有 questions，没有 dimensions），
 * 于是选了量表、打开常模开关后，维度输入框一个都不出现——用户只能填总量表常模，
 * 维度级常模成了死代码。详情接口必须和列表接口给同一份 dimensions。
 */
function scaleDetail(s) {
  return Object.assign({}, s, scaleSummary(s));
}

// ---------- 答卷校验 ----------
function validateAnswers(answers, questions) {
  const errors = [];
  questions.forEach((q, i) => {
    const raw = answers[q.id];
    const no = '第 ' + (i + 1) + ' 题';
    if (q.type === 'scale') {
      const v = Number(raw);
      // 量程按题目自带的 min/max（快速分析自定义量程时写入每题），未标注时退回 1–7 默认。
      // 此前硬编码 1–7：一份 1–5 的数据里混进 6 分会被静默放行，直接污染均值。
      const lo = (typeof q.min === 'number' && isFinite(q.min)) ? q.min : 1;
      const hi = (typeof q.max === 'number' && isFinite(q.max)) ? q.max : 7;
      if (raw === undefined || raw === null || raw === '' || isNaN(v) || v < lo || v > hi) {
        errors.push(no + '（量表题）尚未作答或答案无效');
      }
    } else if (q.type === 'single') {
      const idx = Number(raw);
      if (!(idx >= 0 && idx < (q.options || []).length)) errors.push(no + '（单选题）尚未作答');
    } else if (q.type === 'number') {
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (q.required) errors.push(no + '（数字题）尚未填写');
      } else {
        const v = Number(raw);
        if (isNaN(v)) errors.push(no + '（数字题）不是有效数字');
        else if (q.min !== null && v < q.min) errors.push(no + '不能小于 ' + q.min);
        else if (q.max !== null && v > q.max) errors.push(no + '不能大于 ' + q.max);
      }
    } else {
      const s = raw === undefined || raw === null ? '' : String(raw);
      if (q.required && !s.trim()) errors.push(no + '（填空题）尚未填写');
      else {
        const ml = q.maxLength || TEXT_DEFAULT_MAXLEN;
        // 用展开运算符按"字符"计数，中文与 emoji 都不会被算错
        if ([...s].length > ml) errors.push(no + '（填空题）超过 ' + ml + ' 字上限');
      }
    }
  });
  return errors;
}

// ---------- CSV ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv(pr) {
  const questions = pr.scaleSnapshot.questions;
  const dims = scaleDimensions(questions);
  const responses = db.responses[pr.id] || [];

  const head = ['答卷ID', '提交时间', '用时(秒)', '是否有效', '无效原因', '可疑标记', '设备标识', 'IP'];
  questions.forEach((q, i) => {
    head.push('Q' + (i + 1) + '.' + q.text.replace(/\s+/g, ' ').slice(0, 40));
  });
  dims.forEach(d => head.push('【维度】' + d));
  head.push('综合总分');

  const lines = [head.map(csvCell).join(',')];

  responses.forEach(r => {
    const row = [
      r.id,
      r.submitTime,
      r.durationMs ? Math.round(r.durationMs / 1000) : '',
      r.isValid ? '有效' : '无效',
      (r.invalidReasons || []).join('；'),
      (r.flags || []).join('；'),
      r.deviceId || '',
      r.ip || ''
    ];
    questions.forEach(q => {
      const v = r.answers[q.id];
      if (q.type === 'scale') row.push(v === undefined || v === null ? '' : v);
      else if (q.type === 'single') {
        const idx = Number(v);
        row.push((q.options || [])[idx] !== undefined ? q.options[idx] : '');
      } else row.push(v === undefined || v === null ? '' : v);
    });
    dims.forEach(d => row.push(r.scores && r.scores[d] !== null && r.scores[d] !== undefined ? r.scores[d] : ''));
    row.push(r.total === null || r.total === undefined ? '' : r.total);
    lines.push(row.map(csvCell).join(','));
  });

  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------- 数据导入 ----------

const IMPORT_MAX_ROWS = 3000;

// 快速分析外部数据：6 个维度写死，不允许改名
// （用户原话："分析按这六个维度来分析",但数据特性（列数/列名/样本量）不固定）
const QUICK_ANALYZE_DIMS = ['人格化', '共情体验', '情绪回应', '责任感', '陪伴感', '互动自然感'];
// 列名前缀 → 维度名的自动填表（让愿意给列名加前缀的用户一键填好 wizard）
const QUICK_ANALYZE_HEADER_HINTS = {
  '人格化': ['人格化', '人格', '拟人', 'personif', 'anthropomorph'],
  '共情体验': ['共情体验', '共情', 'empathy'],
  '情绪回应': ['情绪回应', '情绪', 'emotion'],
  '责任感': ['责任感', '责任', 'responsib'],
  '陪伴感': ['陪伴感', '陪伴', 'companion'],
  '互动自然感': ['互动自然感', '互动自然', '互动', 'interact']
};
const QUICK_ANALYZE_DEFAULT_MIN = 1;
const QUICK_ANALYZE_DEFAULT_MAX = 7;

/**
 * 表头是否指向第 qNo 题。问卷星 / 问卷系统导出的表头常见写法全支持：
 *   Q4 / 4 / 4、题干 / 4.题干 / 4:题干 / 4）题干 / 第4题 / (4)题干
 * 「数字后不能再跟数字」防 4 误匹配「40、xxx」；纯数字表头也认（SPSS 数字命名列）。
 */
function headerIsQuestionNo(h, qNo) {
  const s0 = String(h || '').trim();
  if (s0 === 'Q' + qNo || s0 === String(qNo)) return true;
  if (new RegExp('^(第)?' + qNo + '(?![0-9])').test(s0)) return true;
  // 兼容「11、4、题干」这种带 xlsx 列号前缀的情况：剥掉第一个「数字、」前缀再匹配一次
  const m0 = s0.match(/^(\d+)\s*[、,，.]\s*/);
  if (m0) {
    const s = s0.slice(m0[0].length);
    if (s === 'Q' + qNo || s === String(qNo)) return true;
    if (new RegExp('^(第)?' + qNo + '(?![0-9])').test(s)) return true;
  }
  return false;
}

// 系统/注意力列名模式（与前端 QUICK_SYS_PATTERNS / QUICK_ATTENTION_PATTERNS 同步）：
// 服务端做最终校验时也要避开这些列，否则人口学列「8、您的性别：」的「8」会被误匹配成第8题
const QUICK_SYS_PATTERNS_SRV = [
  /^序号$/, /^编号$/, /^ID$/i, /^#$/,
  /提交答卷时间/, /^提交时间$/, /所用时间/, /^完成时间$/, /^耗时$/,
  /^来源$/, /^来源详情$/, /^来自IP$/, /^IP$/i,
  /^总分$/, /^得分$/, /^总得分$/,
  /^开始时间$/, /^结束时间$/,
  /您的?性别/, /您的?年龄/, /您的?学历/, /您的?职业/, /您的?收入/, /您所在/, /您的?地区/, /您的?手机/,
  /^性别$/, /^年龄$/, /^学历$/, /^职业$/, /^收入$/, /^手机号$/, /^邮箱$/
];
const QUICK_ATTENTION_PATTERNS_SRV = [/本题选/, /请选.*以证明/, /请选.*验证/, /为了[证验]/, /attention/i];

function findQuestionNoCol(headers, qNo) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '');
    if (QUICK_SYS_PATTERNS_SRV.some(rx => rx.test(h))) continue;
    if (QUICK_ATTENTION_PATTERNS_SRV.some(rx => rx.test(h))) continue;
    if (headerIsQuestionNo(headers[i], qNo)) return i;
  }
  return -1;
}

/**
 * 解析题号段字符串（每段输入框值）→ 1-based 列号集合。
 * 支持三种语法：
 *   "1-5,17-21"        列号段（最直接）
 *   "Q1-Q5,Q17-Q21"    题号段（按表头定位：Q4 / 4、 / 第4题 等写法都认）
 *   "拟人_,共情_"      列名前缀匹配（headers 中 startsWith 即归类）
 * 解析失败返回 {ok:false, message}，并把原因指到具体的 segments[N].dim 上。
 */
function parseQuickAnalyzeRanges(ranges, totalCols, headers, dimName) {
  const out = new Set();
  if (!ranges || !String(ranges).trim()) return { ok: false, message: '维度「' + dimName + '」未填题号段' };
  const tokens = String(ranges).split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, message: '维度「' + dimName + '」的题号段为空' };

  for (const tk of tokens) {
    // 1) 列号段：1-5 / 7
    let m = tk.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) return { ok: false, message: '维度「' + dimName + '」题号段 "' + tk + '" 起止反了' };
      for (let i = a; i <= b; i++) {
        if (i < 1 || i > totalCols) return { ok: false, message: '维度「' + dimName + '」题号 ' + i + ' 超出范围（总 ' + totalCols + ' 列）' };
        out.add(i);
      }
      continue;
    }
    m = tk.match(/^(\d+)$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (i < 1 || i > totalCols) return { ok: false, message: '维度「' + dimName + '」题号 ' + i + ' 超出范围（总 ' + totalCols + ' 列）' };
      out.add(i);
      continue;
    }
    // 2) 题号段：Q1-Q5 / Q17-Q21（表头按题号定位，Q4 / 4、 / 第4题 都认）
    m = tk.match(/^[Qq](\d+)-[Qq]?(\d+)$/);
    if (m && Array.isArray(headers)) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const cols = [];
      for (let i = a; i <= b; i++) {
        const idx = findQuestionNoCol(headers, i);
        if (idx < 0) return { ok: false, message: '维度「' + dimName + '」找不到第 ' + i + ' 题对应的列（表头需含 Q' + i + ' / ' + i + '、 / 第' + i + '题 等写法，或改用列号段语法）' };
        cols.push(idx + 1);
      }
      cols.forEach(i => out.add(i));
      continue;
    }
    m = tk.match(/^[Qq](\d+)$/);
    if (m && Array.isArray(headers)) {
      const i = parseInt(m[1], 10);
      const idx = findQuestionNoCol(headers, i);
      if (idx < 0) return { ok: false, message: '维度「' + dimName + '」找不到第 ' + i + ' 题对应的列' };
      out.add(idx + 1);
      continue;
    }
    // 3) 列名前缀：拟人_ / 共情_ / 人格化_xxx
    if (Array.isArray(headers) && headers.length) {
      const matches = [];
      headers.forEach((h, idx) => {
        if (String(h || '').startsWith(tk)) matches.push(idx + 1);
      });
      if (matches.length === 0) {
        return { ok: false, message: '维度「' + dimName + '」前缀 "' + tk + '" 没匹配到任何列（确认列名是否带此前缀）' };
      }
      matches.forEach(i => out.add(i));
      continue;
    }
    return { ok: false, message: '维度「' + dimName + '」题号段 "' + tk + '" 无法解析；支持 列号段(1-5) / 题号段(Q1-Q5) / 列名前缀(拟人_)' };
  }
  return { ok: true, cols: out };
}

/**
 * 校验 segments 集合的覆盖与不重叠：
 *   - 所有列 1..totalCols 必须恰好分配到一个维度（少一个就报错）
 *   - 任何一列不能被分配到多个维度
 *   - 维度名必须在白名单（6 维度写死）
 *   - 不能空 segment
 * 返回 {ok, assignment, columnsBySegment} 或者 {ok:false, message}
 */
/**
 * 解析「忽略列」字符串（与题号段同语法：1-10 / Q1-Q3 / 列名前缀）。
 * 问卷星等平台导出的表里有 序号/提交时间/IP/性别/年龄 等非量表列——这些列不参与 6 维度计分，
 * 让用户显式圈出来，而不是混进某个维度污染均值（时间字符串会让整行被判无效）。
 */
function parseQuickIgnoreRanges(ranges, totalCols, headers) {
  if (ranges === undefined || ranges === null || !String(ranges).trim()) return { ok: true, cols: new Set() };
  const parsed = parseQuickAnalyzeRanges(String(ranges), totalCols, headers, '忽略列');
  return parsed; // { ok, cols: Set<1-based col>, message }
}

function parseQuickAnalyzeSegments(segments, totalCols, headers, ignoreSet) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, message: 'segments 不能为空' };
  }
  if (segments.length !== QUICK_ANALYZE_DIMS.length) {
    return { ok: false, message: 'segments 必须有 ' + QUICK_ANALYZE_DIMS.length + ' 个维度（每行一个）' };
  }
  // 维度白名单 + 不可重复
  const dimSet = new Set();
  for (const seg of segments) {
    const dim = String(seg.dim || '').trim();
    if (QUICK_ANALYZE_DIMS.indexOf(dim) < 0) return { ok: false, message: '维度「' + dim + '」不在白名单内（必须是 6 维度之一）' };
    if (dimSet.has(dim)) return { ok: false, message: '维度「' + dim + '」重复出现' };
    dimSet.add(dim);
  }
  // 维度顺序必须按 QUICK_ANALYZE_DIMS 排（前端固定生成顺序，但后端不做也行——
  // 6 个一样时无歧义；这里我们信任前端的顺序，不再额外排序以免让 report 顺序乱）

  const assignment = {};      // colIdx(1-based) → segIdx（segIdx 指 segments 数组里的位置）
  const columnsByDim = {};    // dim 名 → [colIdx, ...]，按 dim 索引便于 buildQuickAnalyzeQuestions 按维度顺序整理
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dim = String(seg.dim || '').trim();
    const parsed = parseQuickAnalyzeRanges(seg.ranges, totalCols, headers, dim);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (parsed.cols.size === 0) return { ok: false, message: '维度「' + dim + '」没有解析出任何列（题号段是空的）' };
    for (const c of parsed.cols) {
      if (ignoreSet && ignoreSet.has(c)) return { ok: false, message: '列 ' + c + ' 已被设为忽略列，不能再分配给「' + dim + '」（请二选一）' };
      if (assignment[c] !== undefined) return { ok: false, message: '列 ' + c + ' 被多个维度分配（' + QUICK_ANALYZE_DIMS[assignment[c]] + ' 和 ' + dim + '）' };
      assignment[c] = i;
    }
    columnsByDim[dim] = [...parsed.cols].sort((a, b) => a - b);
  }

  // 严格路径：列必须全部被覆盖（忽略列除外），少一个就报错
  const missing = [];
  for (let c = 1; c <= totalCols; c++) {
    if (assignment[c] === undefined && !(ignoreSet && ignoreSet.has(c))) missing.push(c);
  }
  if (missing.length) return { ok: false, message: '列 ' + missing.join(',') + ' 没分配到任何维度（请补全题号段、或把它们填进下方「不参与分析的列」）' };

  // columnsBySegment 仅作返回（前端展示用），按 segments 顺序
  const columnsBySegment = segments.map(seg => columnsByDim[String(seg.dim || '').trim()] || []);
  return { ok: true, assignment: assignment, columnsBySegment: columnsBySegment, columnsByDim: columnsByDim };
}

/**
 * 把 segments + 列分配 转成 scale.questions。
 * 严格按 QUICK_ANALYZE_DIMS 顺序（保证报告里的维度顺序固定），在每个维度内按列号升序。
 * 输入 columnsByDim 是 dim 名 → 列号数组 的字典，规避"用户传 segments 顺序 ≠ QUICK_ANALYZE_DIMS 顺序"的错位。
 */
function buildQuickAnalyzeQuestions(columnsByDim, scaleMin, scaleMax) {
  const min = (typeof scaleMin === 'number' && isFinite(scaleMin)) ? Math.floor(scaleMin) : QUICK_ANALYZE_DEFAULT_MIN;
  const max = (typeof scaleMax === 'number' && isFinite(scaleMax)) ? Math.floor(scaleMax) : QUICK_ANALYZE_DEFAULT_MAX;
  if (!(max > min)) throw new Error('scaleMax 必须大于 scaleMin');

  const qs = [];
  for (let segIdx = 0; segIdx < QUICK_ANALYZE_DIMS.length; segIdx++) {
    const dim = QUICK_ANALYZE_DIMS[segIdx];
    const cols = columnsByDim[dim] || [];
    for (const colIdx of cols) {
      qs.push({
        id: 'q_quick_' + segIdx + '_' + colIdx,
        text: '第 ' + (qs.length + 1) + ' 题（' + dim + '）',
        type: 'scale',
        dimension: dim,
        min: min,
        max: max,
        required: true,
        isAttention: false,
        correctValue: null
      });
    }
  }
  return qs;
}

/**
 * 把 records 的 columnAnswers（key 是 1-based 列号）按 columnsByDim 转成 answers（key 是 qId）。
 * 字符串强转：'5' → 5；非数字/null/空 → 留空。
 */
function remapQuickAnalyzeColumnAnswers(columnAnswers, columnsByDim) {
  const out = {};
  for (let segIdx = 0; segIdx < QUICK_ANALYZE_DIMS.length; segIdx++) {
    const dim = QUICK_ANALYZE_DIMS[segIdx];
    const cols = columnsByDim[dim] || [];
    for (const colIdx of cols) {
      const qId = 'q_quick_' + segIdx + '_' + colIdx;
      const raw = columnAnswers && columnAnswers[colIdx];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(String(raw).trim());
      if (isFinite(n)) out[qId] = n;
    }
  }
  return out;
}

/**
 * 把导入的原始作答按题型转成规范类型。
 * CSV 里读到的一切都是字符串，若原样入库，calcScores 里的 `typeof v === 'number'`
 * 会把它们全部过滤掉，最终表现为「导入成功、答卷数对得上、但所有维度分都是 null」。
 */
function coerceAnswers(raw, questions) {
  const out = {};
  questions.forEach(q => {
    const v = raw[q.id];
    if (v === undefined || v === null || v === '') return;
    if (q.type === 'scale' || q.type === 'single' || q.type === 'number') {
      const n = Number(v);
      if (isFinite(n)) out[q.id] = n;
    } else {
      out[q.id] = String(v);
    }
  });
  return out;
}

/**
 * 用与在线提交**完全相同**的规则构造一份导入答卷。
 * 有效性判定、可疑标记、计分口径都必须一致——否则导入的数据会在报告里
 * 享受一套不同的统计待遇，两份数据混在一起算出来的均值就说不清是什么了。
 */
function buildImportedResponse(questions, answers, meta) {
  const invalidReasons = [];
  questions.forEach((q, i) => {
    if (q.isAttention && Number(answers[q.id]) !== Number(q.correctValue)) {
      invalidReasons.push('第 ' + (i + 1) + ' 题注意力检测未通过');
    }
  });

  const flags = [];
  const scaleQs = scaleQuestions(questions).filter(q => !q.isAttention);
  if (scaleQs.length >= 5) {
    const vals = scaleQs.map(q => Number(answers[q.id]));
    if (vals.every(v => v === vals[0])) flags.push('全部题目同一选项');
    if (new Set(vals).size <= 2) flags.push('作答选项高度集中');
  }
  let durationMs = null;
  if (typeof meta.durationSec === 'number' && isFinite(meta.durationSec) && meta.durationSec >= 0) {
    durationMs = Math.min(Math.round(meta.durationSec * 1000), 4 * 3600 * 1000);
  }
  if (scaleQs.length >= 5 && durationMs !== null && durationMs < scaleQs.length * 2000) {
    flags.push('作答速度过快');
  }

  const scores = calcScores(answers, questions);
  return {
    id: newId('resp'),
    answers: answers,
    isValid: invalidReasons.length === 0,
    invalidReasons: invalidReasons,
    flags: flags,
    scores: scores,
    total: overallTotal(scores),
    submitTime: meta.submitTime || nowStr(),
    durationMs: durationMs,
    // 导入行没有真实设备指纹，用批次 + 行号造一个，方便日后定位与回滚；
    // 也因为带了这个前缀，它不会和真实被试的 deviceId 撞车导致误判重复提交。
    deviceId: 'import:' + meta.batchId + ':' + (meta.externalId || meta.rowIndex),
    ip: null,
    userAgent: 'imported from ' + (meta.fileName || 'file'),
    source: 'import',
    importBatch: meta.batchId,
    importFile: meta.fileName || '',
    importRow: meta.rowIndex
  };
}

/**
 * 把一批导入记录解析成标准答卷（不写入数据库）。
 *
 * 把"算"和"写"拆开有两个直接的好处：
 *   ① 创建项目时可先 dry-run —— 至少 1 条通过校验才允许落地，避免建出永远
 *      0 份答卷的"空壳"项目；用户填错列映射时也能立刻看到错因，不必先建项目再删。
 *   ② 现有 /api/projects/:id/import 路由可继续复用同一份解析逻辑，
 *      行为偏差零容忍 —— 两处入口的字符串强转、注意力检测、文本题截断全部走同一行代码。
 *
 * opts.batchId / opts.fileName 仅用于标记设备指纹与导出回看，不参与业务校验。
 */
function buildImportBatch(pid, records, opts) {
  const pr = db.projects.find(x => x.id === pid);
  if (!pr) return { ok: false, status: 404, message: '项目不存在' };
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, status: 400, message: '没有解析到可导入的数据行' };
  }
  if (records.length > IMPORT_MAX_ROWS) {
    return { ok: false, status: 400, message: '单次最多导入 ' + IMPORT_MAX_ROWS + ' 行（当前 ' + records.length + ' 行），请拆成多次导入' };
  }
  const qs = pr.scaleSnapshot.questions;
  const errors = [];
  const built = [];
  records.forEach((rec, i) => {
    const rowNo = (rec && rec.rowIndex !== undefined) ? rec.rowIndex : (i + 1);
    if (!rec || !rec.answers || typeof rec.answers !== 'object') {
      errors.push({ row: rowNo, message: '这一行没有解析出任何作答' });
      return;
    }
    // 字符串强转：CSV 里读到的一切都是文本，必须按题型转 number/single 索引，
    // 否则 calcScores 里的 typeof v === 'number' 会把它们全部过滤掉——
    // 这是"导入成功但维度分全是 null"那种静默失败的根因。
    const answers = coerceAnswers(rec.answers, qs);
    const errs = validateAnswers(answers, qs);
    if (errs.length) { errors.push({ row: rowNo, message: errs[0] }); return; }
    // 文本题截断到 maxLength，与在线提交走同一份上限
    qs.forEach(q => {
      if (q.type === 'text' && answers[q.id] !== undefined) {
        const ml = q.maxLength || TEXT_DEFAULT_MAXLEN;
        const s = String(answers[q.id]);
        if ([...s].length > ml) answers[q.id] = [...s].slice(0, ml).join('');
      }
    });
    const dsec = Number(rec.durationSec);
    built.push(buildImportedResponse(qs, answers, {
      batchId: opts.batchId,
      fileName: opts.fileName,
      rowIndex: rowNo,
      durationSec: isFinite(dsec) && dsec >= 0 ? dsec : null,
      submitTime: rec.submitTime ? String(rec.submitTime).slice(0, 32) : null,
      externalId: rec.externalId ? String(rec.externalId).slice(0, 64) : null
    }));
  });
  return {
    ok: true,
    built: built,
    errors: errors,
    validCount: built.filter(r => r.isValid).length,
    invalidCount: built.filter(r => !r.isValid).length
  };
}

/**
 * 把 buildImportBatch 的结果落到数据库。
 * 覆盖模式会先留快照（保留最近 20 份，由 snapshotBeforeDelete 控制上限），
 * 再清空该项目已有答卷。append 模式直接 push。
 *
 * 调用方负责 saveDb。本函数不 saveDb 是有意的：POST /api/projects 在创建
 * 项目时同步导入，需要把"创建项目"和"导入答卷"作为一个原子事务——
 * 由调用方在两者都成功后一次 saveDb，失败时整笔回滚。
 */
function writeImportBatch(pid, built, mode) {
  let snapshot = null;
  if (mode === 'replace') {
    snapshot = snapshotBeforeDelete('import-replace');
    db.responses[pid] = [];
  }
  db.responses[pid] = db.responses[pid] || [];
  built.forEach(r => db.responses[pid].push(r));
  return snapshot;
}

/**
 * 导入路由的对外封装：先 build 再 write，错误统一返回。
 * 现有 /api/projects/:id/import 路由的逻辑全部搬进来，行为零变化。
 */
function doImport(pid, body) {
  const mode = body && body.mode === 'replace' ? 'replace' : 'append';
  const batchId = newId('imp');
  const fileName = String((body && body.fileName) || '').slice(0, 120);
  const built = buildImportBatch(pid, body && body.records, { batchId, fileName });
  if (!built.ok) return built;
  const snapshot = writeImportBatch(pid, built.built, mode);
  saveDb();
  return {
    ok: true,
    result: {
      mode: mode,
      batchId: batchId,
      fileName: fileName,
      imported: built.built.length,
      skipped: (body.records.length - built.built.length),
      validCount: built.validCount,
      invalidCount: built.invalidCount,
      totalCount: db.responses[pid].length,
      projectValidCount: projectValidCount(pid),
      errors: built.errors.slice(0, 50),
      errorTotal: built.errors.length,
      snapshot: snapshot
    }
  };
}

/**
 * 导入模板 CSV：表头与导出格式一致 + 两行示例。
 * 示例行的第一列以「示例」开头，导入时会被自动跳过并提示——这样用户
 * 直接改示例行就能用，不必先想"哪些列是必填的"。
 */
function buildImportTemplate(pr) {
  const questions = pr.scaleSnapshot.questions;
  const dims = scaleDimensions(questions);
  const head = ['答卷ID', '提交时间', '用时(秒)'];
  questions.forEach((q, i) => head.push('Q' + (i + 1) + '.' + q.text.replace(/\s+/g, ' ').slice(0, 40)));
  dims.forEach(d => head.push('【维度】' + d));
  head.push('综合总分');

  function sampleRow(tag, pick) {
    const row = [tag, nowStr(), '180'];
    questions.forEach((q, i) => {
      if (q.type === 'scale') row.push(pick(i));
      else if (q.type === 'single') row.push(((q.options || [])[0] || ''));
      else if (q.type === 'number') row.push('');
      else row.push('');
    });
    dims.forEach(() => row.push(''));
    row.push('');
    return row.map(csvCell).join(',');
  }

  const lines = [
    '# 说明：第 1 行是表头，请勿修改；以「#」或「示例」开头的行会被自动跳过。',
    // 带 # 的说明行不是合法 CSV 表头，导入端会先剥掉它，因此这里直接用普通行写注释即可。
    head.map(csvCell).join(','),
    sampleRow('示例行-请删除或直接改写', i => (i % 2 === 0 ? 5 : 4)),
    sampleRow('示例行-请删除或直接改写', i => (i % 3 === 0 ? 3 : 6))
  ];
  // 维度列与总分类在模板里留空：它们由系统重算，填了也会被忽略。
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------- 报告统计 ----------
/**
 * 生成产品报告。
 *
 * 分工：本函数只负责「项目元信息 + 背景分组对比 + 字段名映射」，
 * 所有统计分析都交给 analysis.js（依据引擎）完成。
 * 这样做的理由是——报告里每个数字都必须只有**一个**实现来源。
 * 一旦在本文件里再写一份 α 或 r 的计算，两份实现迟早会算出两个数，读者无从判断该信哪个。
 */
function buildReport(pr) {
  const questions = pr.scaleSnapshot.questions;
  const dims = scaleDimensions(questions);
  const all = db.responses[pr.id] || [];
  const valid = all.filter(r => r.isValid);
  const n = valid.length;

  const an = analysis.analyze({
    questions: questions,
    responses: all,
    targetSample: pr.targetSample,
    // 项目若设置了外部常模，报告里就会多出一整套常模参照（z / 百分位 / t 检验）。
    // 没设置时 analysis.js 会把它规整成 null，报告退回量表中点参照——前端无需分支判断。
    norm: pr.norm || null
  });
  const T = an.norms.total;

  // 维度统计：原样取自依据引擎，附带依据字段
  const dimensions = an.norms.dimensions.map(d => ({
    name: d.name,
    itemCount: d.itemCount,
    n: d.n,
    mean: d.mean,
    sd: d.sd,
    median: d.median,
    alpha: d.alpha,
    // ——— 以下为依据字段：让每个维度数值都带得动出处 ———
    sem: d.sem,
    ci95: d.ci95,
    cohensD: d.cohensD,
    cohensDJudge: d.cohensDJudge,
    tTest: d.tTest,
    percentileOfMean: d.percentileOfMean,
    min: d.min,
    max: d.max,
    ceilingPct: d.ceilingPct,
    floorPct: d.floorPct,
    ceilingJudge: d.ceilingJudge,
    floorJudge: d.floorJudge,
    skewness: d.skewness,
    kurtosis: d.kurtosis,
    distributionJudge: d.distributionJudge,
    alphaJudge: d.alphaJudge,
    weakestItem: d.weakestItem,
    strongestItem: d.strongestItem,
    itemMeans: d.itemMeans,
    // 维度层面的常模参照（项目设了常模才有；scope 会标明用的是维度常模还是总量表常模）
    normCompare: d.normCompare || null,
    droppedIncomplete: d.droppedIncomplete
  }));

  // 题项分析：同样取自依据引擎（含注意力检测题；它不计分，故不带区分度判读）
  const itemStats = an.itemQuality.map(x => ({
    index: x.index,
    text: x.text,
    dimension: x.dimension,
    isAttention: x.isAttention,
    n: x.n,
    mean: x.mean,
    sd: x.sd,
    r: x.r,
    rLevel: x.rLevel,
    rLabel: x.rLabel,
    rNote: x.rNote
  }));

  // 背景信息分组对比
  const groups = [];
  questions.filter(q => q.type !== 'scale' && q.required !== false).forEach(q => {
    if (q.type === 'single') {
      const buckets = (q.options || []).map(label => ({ label: label, ids: [] })).concat([{ label: '未作答', ids: [] }]);
      valid.forEach(resp => {
        const idx = Number(resp.answers[q.id]);
        const bucket = (idx >= 0 && idx < (q.options || []).length) ? buckets[idx] : buckets[buckets.length - 1];
        bucket.ids.push(resp);
      });
      const rows = buckets.filter(b => b.ids.length > 0).map(b => {
        const scores = {};
        dims.forEach(d => {
          const vals = b.ids.map(x => x.scores ? x.scores[d] : null).filter(v => typeof v === 'number');
          scores[d] = round2(mean(vals));
        });
        return { label: b.label, n: b.ids.length, scores: scores };
      });
      if (rows.length) groups.push({ question: q.text, type: '单选分组', rows: rows });
    } else if (q.type === 'number') {
      const pairs = valid.map(resp => ({ v: Number(resp.answers[q.id]), resp: resp })).filter(p => !isNaN(p.v));
      if (pairs.length >= 4) {
        const med = median(pairs.map(p => p.v));
        const low = pairs.filter(p => p.v <= med).map(p => p.resp);
        const high = pairs.filter(p => p.v > med).map(p => p.resp);
        const rows = [{ label: '≤ ' + med + '（低分组）', ids: low }, { label: '> ' + med + '（高分组）', ids: high }].map(b => {
          const scores = {};
          dims.forEach(d => {
            const vals = b.ids.map(x => x.scores ? x.scores[d] : null).filter(v => typeof v === 'number');
            scores[d] = round2(mean(vals));
          });
          return { label: b.label, n: b.ids.length, scores: scores };
        });
        groups.push({ question: q.text, type: '中位数分组', rows: rows });
      }
    }
  });

  const durations = valid.map(r => r.durationMs).filter(v => typeof v === 'number' && v > 0);
  const dq = an.inference.dataQuality;

  // 背景分组对比只做了描述统计、没有做显著性检验——把它作为一条明确的局限写出来，
  // 而不是让读者以为「表格里的数字大就代表真的更好」。
  if (groups.length) {
    an.methodology.limitations.push(
      '**背景信息分组对比未做显著性检验**：表格中各分组的均值只是描述性统计，组间差异可能来自抽样波动。' +
      '样本量较小的分组尤其不宜直接读作「这类用户评价更高」。若需要严格结论：连续型分组（如年龄）可对两组做独立样本 t 检验，' +
      '多分类分组（如性别、学历）应做单因素方差分析（ANOVA）。'
    );
  }

  return {
    projectId: pr.id,
    productName: pr.productName,
    version: pr.version,
    scaleName: pr.scaleSnapshot.name,
    scaleDescription: pr.scaleSnapshot.description || '',
    createdAt: pr.createdAt,
    validCount: n,
    totalCount: all.length,
    invalidCount: all.length - n,
    invalidRate: all.length ? round2((all.length - n) / all.length * 100) : null,
    targetSample: pr.targetSample,
    sampleReady: n >= pr.targetSample,
    flaggedCount: dq.flaggedCount,
    importedCount: dq.imported || 0,
    questionCount: questions.length,
    // 计分题数不含注意力检测题——原来用 scaleQuestions().length 会把检测题也算进去，
    // 导致"计分 37 + 检测 1 + 背景 3 = 41 > 总题数 40"，与题数说明自相矛盾。
    scaleQuestionCount: scaleQuestions(questions).filter(q => !q.isAttention).length,
    attentionCount: questions.filter(q => q.isAttention).length,
    dimensions: dimensions,
    total: { mean: T.mean, sd: T.sd, median: T.median },
    alphaOverall: T.alpha,
    alphaJudge: T.alphaJudge,
    splitHalf: T.splitHalf,
    semOverall: T.sem,
    levelLabel: T.levelLabel,
    itemStats: itemStats,
    groups: groups,
    duration: {
      meanSec: dq.durationMeanSec,
      medianSec: dq.durationMedianSec,
      minSec: durations.length ? Math.round(Math.min.apply(null, durations) / 1000) : null
    },
    // —————— 依据引擎输出（报告的分析层，每一条都带 basis）——————
    norms: an.norms,
    inference: an.inference,
    itemQuality: an.itemQuality,
    findings: an.findings,
    suggestions: an.suggestions,
    methodology: an.methodology,
    evidence: an.evidence,
    warnings: an.warnings,
    generatedAt: nowStr()
  };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean);
  const p = parts.slice(1); // 去掉 'api'

  // ---- 公开：元信息 ----
  if (p[0] === 'meta' && method === 'GET') {
    return send(res, 200, {
      port: PORT,
      lanUrl: lanUrl(),
      version: 6,
      dimensionsPreset: PRESET_DIMENSIONS,
      questionTypes: QUESTION_TYPES,
      textDefaultMaxLength: TEXT_DEFAULT_MAXLEN,
      textHardMaxLength: TEXT_HARD_MAXLEN
    });
  }

  // ---- 公开：Excel / Word 解析（快速分析外部数据与项目导入的 xlsx/docx 入口） ----
  // 前端把文件原样二进制上送（application/octet-stream），这里解成字符串矩阵返回。
  // 只做「格式转换」，不落库、不建项目——真正的数据导入仍走与 CSV 相同的管线。
  // 顺带识别 SPSS .sav 与老版 OLE2（.xls/.doc）二进制，给出「另存为」的明确指引。
  if (p[0] === 'parse-xlsx' && p.length === 1 && method === 'POST') {
    const buf = await readRawBody(req);
    if (!buf.length) return fail(res, 400, '请求体为空：请上传 .xlsx / .docx 文件内容');
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0x324C4624) { // '$FL2'（小端）
      return fail(res, 400, '检测到 SPSS 的 .sav 文件——请在 SPSS 中「文件 → 另存为 → Excel/CSV」后上传');
    }
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0xE011CFD0) { // OLE2 魔数 D0 CF 11 E0
      return fail(res, 400, '检测到老版 .xls / .doc 格式——请用 Excel / WPS 打开后「另存为 .xlsx」再上传');
    }
    let parsed;
    try { parsed = sniffParseOfficeBuffer(buf); }
    catch (e) { return fail(res, 400, e.message || '文件解析失败'); }
    const rows = parsed.rows;
    if (rows.length > IMPORT_MAX_ROWS + 1) {
      return fail(res, 400, '文件共 ' + (rows.length - 1) + ' 行数据，超过单次导入上限 ' + IMPORT_MAX_ROWS + ' 行，请拆分后再导入');
    }
    return send(res, 200, {
      sheetName: parsed.sheetName,
      totalRows: rows.length - 1, // 首行算表头
      totalCols: Math.max.apply(null, rows.map(r => r.length)),
      rows: rows
    });
  }

  // 鉴权已移除。原本这里有 /api/admin/login、/api/admin/check、/api/admin/password
  // 以及「以下接口需要管理员权限」中间件。所有管理端 API 现在都直接开放，不再要求
  // 任何 token。若部署到公网，需要重新加回鉴权或在前置网关层加上 basic auth / IP 白名单。

  // ---- 量表 ----
  if (p[0] === 'scales') {
    if (p.length === 1) {
      if (method === 'GET') return send(res, 200, db.scales.map(scaleSummary));
      if (method === 'POST') {
        const body = await readBody(req);
        const err = validateScalePayload(body);
        if (err) return fail(res, 400, err);
        const scale = {
          id: newId('scale'),
          name: String(body.name).trim(),
          description: String(body.description || '').trim(),
          questions: body.questions.map(normalizeQuestion),
          createdAt: todayStr(),
          updatedAt: todayStr()
        };
        db.scales.unshift(scale);
        saveDb();
        return send(res, 201, scaleDetail(scale));
      }
    }
    if (p.length === 2) {
      const idx = db.scales.findIndex(s => s.id === p[1]);
      if (idx < 0) return fail(res, 404, '量表不存在');
      if (method === 'GET') return send(res, 200, scaleDetail(db.scales[idx]));
      if (method === 'PUT') {
        const body = await readBody(req);
        const err = validateScalePayload(body);
        if (err) return fail(res, 400, err);
        const old = db.scales[idx];
        old.name = String(body.name).trim();
        old.description = String(body.description || '').trim();
        old.questions = body.questions.map(normalizeQuestion);
        old.updatedAt = todayStr();
        saveDb();
        return send(res, 200, scaleDetail(old));
      }
      if (method === 'DELETE') {
        const used = db.projects.filter(pr => pr.scaleId === p[1]);
        if (used.length > 0) return fail(res, 409, '该量表已被 ' + used.length + ' 个项目使用，无法删除');
        db.scales.splice(idx, 1);
        saveDb();
        return send(res, 200, { ok: true });
      }
    }
  }

  // ---- 项目 ----
  if (p[0] === 'projects') {
    if (p.length === 1 && method === 'GET') {
      const list = db.projects.map(pr => ({
        id: pr.id,
        productName: pr.productName,
        version: pr.version,
        targetSample: pr.targetSample,
        scaleName: pr.scaleSnapshot ? pr.scaleSnapshot.name : '-',
        normName: pr.norm ? pr.norm.name : null,
        importedCount: (db.responses[pr.id] || []).filter(r => r.source === 'import').length,
        validCount: projectValidCount(pr.id),
        totalCount: (db.responses[pr.id] || []).length,
        createdAt: pr.createdAt
      }));
      return send(res, 200, list);
    }
    if (p.length === 1 && method === 'POST') {
      const body = await readBody(req);
      const scale = db.scales.find(s => s.id === body.scaleId);
      if (!scale) return fail(res, 400, '所选量表不存在');
      const productName = String(body.productName || '').trim();
      if (!productName) return fail(res, 400, '请输入项目 / AI产品名称');
      const target = parseInt(body.targetSample, 10);
      if (!(target >= 1)) return fail(res, 400, '目标样本量必须大于 0');
      // 常模可选：设了就校验，没设就是 null。校验失败必须报错而不是静默忽略。
      const nv = validateProjectNorm(body.norm, scaleDimensions(scale.questions));
      if (!nv.ok) return fail(res, 400, nv.message);

      // 「创建并导入」的数据合法性必须先于项目落地校验，否则会出现：
      //   ① 建出永远 0 份有效答卷的"空壳"项目 —— 数据库里挂着名字但跑不出报告；
      //   ② 用户填错列映射时，看不到错因，要先建项目再删，体验极差；
      //   ③ 部分写入：项目落了但导入答卷落了一半 —— 调用方无原子保证。
      // 先建项目对象（不写库）→ dry-run → 至少 1 条有效才整体 saveDb 并写答卷。
      const project = {
        id: newId('proj'),
        productName: productName,
        version: String(body.version || 'V1.0').trim() || 'V1.0',
        description: String(body.description || '').trim(),
        targetSample: target,
        norm: nv.norm,
        scaleId: scale.id,
        scaleSnapshot: JSON.parse(JSON.stringify({
          name: scale.name, description: scale.description, questions: scale.questions
        })),
        createdAt: todayStr()
      };
      db.projects.unshift(project);
      db.responses[project.id] = [];

      saveDb();
      return send(res, 201, { id: project.id });
    }
    if (p.length >= 2) {
      const pid = p[1];
      const pr = db.projects.find(x => x.id === pid);
      if (!pr) return fail(res, 404, '项目不存在');

      // 项目设置（名称 / 版本 / 说明 / 目标样本量 / 常模）——常模允许事后补填，
      // 否则所有在这功能上线之前建好的项目都没机会用上常模参照。
      if (p.length === 2 && method === 'PUT') {
        const body = await readBody(req);
        const dimsOfScale = scaleDimensions(pr.scaleSnapshot.questions);

        if (body.productName !== undefined) {
          const pn = String(body.productName || '').trim();
          if (!pn) return fail(res, 400, '项目 / AI产品名称不能为空');
          pr.productName = pn;
        }
        if (body.targetSample !== undefined) {
          const t = parseInt(body.targetSample, 10);
          if (!(t >= 1)) return fail(res, 400, '目标样本量必须大于 0');
          pr.targetSample = t;
        }
        if (body.version !== undefined) pr.version = String(body.version || 'V1.0').trim() || 'V1.0';
        if (body.description !== undefined) pr.description = String(body.description || '').trim();

        if (body.norm !== undefined) {
          const nv = validateProjectNorm(body.norm, dimsOfScale);
          if (!nv.ok) return fail(res, 400, nv.message);
          pr.norm = nv.norm;
        }
        pr.updatedAt = nowStr();
        saveDb();
        return send(res, 200, {
          ok: true,
          id: pr.id, productName: pr.productName, version: pr.version,
          description: pr.description, targetSample: pr.targetSample,
          norm: normSummary(pr.norm)
        });
      }

      // 被试端取题
      if (p[2] === 'public' && method === 'GET') {
        const qs = pr.scaleSnapshot.questions.map(q => {
          const c = Object.assign({}, q);
          delete c.correctValue; // 不把测谎答案暴露给被试端
          return c;
        });
        return send(res, 200, {
          project: { productName: pr.productName, version: pr.version, description: pr.description },
          scale: { name: pr.scaleSnapshot.name, description: pr.scaleSnapshot.description, questions: qs }
        });
      }

      // 提交答卷
      if (p[2] === 'responses' && method === 'POST' && p.length === 3) {
        const body = await readBody(req);
        const answers = body && body.answers;
        if (!answers || typeof answers !== 'object') return fail(res, 400, '答卷数据格式错误');
        const qs = pr.scaleSnapshot.questions;

        const errs = validateAnswers(answers, qs);
        if (errs.length) return fail(res, 400, errs[0]);

        // 兜底截断：校验已经拦住了超长文本，这里再切一刀，确保任何情况下都不会把
        // 超大字符串写进 db.json（请求体上限 8MB，不设防会被撑爆）
        qs.forEach(q => {
          if (q.type === 'text' && answers[q.id] !== undefined && answers[q.id] !== null) {
            const ml = q.maxLength || TEXT_DEFAULT_MAXLEN;
            const s = String(answers[q.id]);
            if ([...s].length > ml) answers[q.id] = [...s].slice(0, ml).join('');
          }
        });

        const deviceId = String(body.deviceId || '').slice(0, 64);
        const ip = clientIp(req);

        // 防重复提交：同一设备在同一项目中只能提交一次
        if (deviceId) {
          const dup = (db.responses[pid] || []).find(r => r.deviceId && r.deviceId === deviceId);
          if (dup) {
            return fail(res, 409, '这台设备已经提交过本项目的答卷了', {
              duplicate: true, responseId: dup.id, submitTime: dup.submitTime
            });
          }
        }

        // 有效性判定（服务端）
        const invalidReasons = [];
        qs.forEach((q, i) => {
          if (q.isAttention && Number(answers[q.id]) !== Number(q.correctValue)) {
            invalidReasons.push('第 ' + (i + 1) + ' 题注意力检测未通过');
          }
        });
        // 可疑标记（不直接判无效）
        const flags = [];
        const scaleQs = scaleQuestions(qs).filter(q => !q.isAttention);
        if (scaleQs.length >= 5) {
          const vals = scaleQs.map(q => Number(answers[q.id]));
          if (vals.every(v => v === vals[0])) flags.push('全部题目同一选项');
          const uniq = new Set(vals).size;
          if (uniq <= 2) flags.push('作答选项高度集中');
        }
        let durationMs = null;
        if (typeof body.durationMs === 'number' && body.durationMs >= 0) {
          durationMs = Math.min(Math.round(body.durationMs), 4 * 3600 * 1000);
        }
        if (scaleQs.length >= 5 && durationMs !== null && durationMs < scaleQs.length * 2000) {
          flags.push('作答速度过快');
        }
        if (ip && (db.responses[pid] || []).some(r => r.ip && r.ip === ip)) flags.push('同一IP多次提交');

        const scores = calcScores(answers, qs);
        const resp = {
          id: newId('resp'),
          answers: answers,
          isValid: invalidReasons.length === 0,
          invalidReasons: invalidReasons,
          flags: flags,
          scores: scores,
          total: overallTotal(scores),
          submitTime: nowStr(),
          durationMs: durationMs,
          deviceId: deviceId || null,
          ip: ip || null,
          userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
          // 数据来源标记：报告里要区分"在线收集"与"导入"，两者的可信度不同
          source: 'online'
        };
        db.responses[pid] = db.responses[pid] || [];
        db.responses[pid].push(resp);
        saveDb();
        return send(res, 201, {
          responseId: resp.id, isValid: resp.isValid, invalidReasons: invalidReasons,
          scores: scores, total: resp.total, productName: pr.productName
        });
      }

      // 单份答卷逐题明细（管理端核对可疑答卷用；这是管理路由，可以带上测谎答案）
      if (p[2] === 'responses' && p.length === 4 && method === 'GET') {
        const r = (db.responses[pid] || []).find(x => x.id === p[3]);
        if (!r) return fail(res, 404, '答卷不存在');
        const qs = pr.scaleSnapshot.questions;
        const ans = r.answers || {};
        return send(res, 200, {
          id: r.id, isValid: r.isValid, invalidReasons: r.invalidReasons || [], flags: r.flags || [],
          submitTime: r.submitTime, durationSec: r.durationMs ? Math.round(r.durationMs / 1000) : null,
          total: r.total, scores: r.scores || {}, ip: r.ip || '', deviceId: r.deviceId || '',
          userAgent: r.userAgent || '',
          items: qs.map((q, i) => {
            const raw = ans[q.id];
            const item = {
              no: i + 1, id: q.id, text: q.text, type: q.type,
              dimension: q.type === 'scale' ? q.dimension : null,
              isAttention: !!q.isAttention,
              answer: raw === undefined ? null : raw
            };
            if (q.type === 'single') {
              const idx = Number(raw);
              item.label = (q.options || [])[idx] !== undefined ? q.options[idx] : '';
            }
            if (q.type === 'text') item.maxLength = q.maxLength || null;
            // 只回传"是否通过"，不回传正确答案本身
            if (q.isAttention) item.attentionPassed = Number(raw) === Number(q.correctValue);
            return item;
          })
        });
      }

      // 删除单份答卷
      if (p[2] === 'responses' && p.length === 4 && method === 'DELETE') {
        const list = db.responses[pid] || [];
        const idx2 = list.findIndex(r => r.id === p[3]);
        if (idx2 < 0) return fail(res, 404, '答卷不存在');
        const snapshot = snapshotBeforeDelete('response');
        list.splice(idx2, 1);
        saveDb();
        return send(res, 200, { ok: true, snapshot: snapshot });
      }

      // CSV 导出
      if (p[2] === 'export.csv' && method === 'GET') {
        const csv = buildCsv(pr);
        const fname = encodeURIComponent('测评数据_' + pr.productName + '_' + todayStr() + '.csv');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''" + fname,
          'Cache-Control': 'no-store'
        });
        return res.end(csv);
      }

      // 导入模板（只含表头 + 两行示例）：字段与导出格式保持一致，
      // 这样「本系统导出的 CSV」可以原样再导入回来，不用做二次加工。
      if (p[2] === 'import' && p[3] === 'template.csv' && method === 'GET') {
        const csv = buildImportTemplate(pr);
        const fname = encodeURIComponent('导入模板_' + pr.productName + '.csv');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''" + fname,
          'Cache-Control': 'no-store'
        });
        return res.end(csv);
      }

      // 数据导入：把已有的数据（问卷星导出、Excel、本系统导出的 CSV）直接灌进来做分析，
      // 跳过"发链接收集"这一步。逐行校验，坏行跳过并回传原因，不做静默丢弃。
      // 主体逻辑已抽到 doImport()，这里只是个壳子——这样 POST /api/projects
      // （创建并导入）能共用同一份解析与写入，避免两条路径行为漂移。
      if (p[2] === 'import' && p.length === 3 && method === 'POST') {
        const body = await readBody(req);
        const out = doImport(pid, body);
        if (!out.ok) return fail(res, out.status, out.message);
        return send(res, 201, out.result);
      }

      // 汇总报告
      if (p[2] === 'report' && method === 'GET') {
        const all = db.responses[pid] || [];
        if (!all.some(r => r.isValid)) return fail(res, 400, '暂无有效答卷，无法生成报告');
        return send(res, 200, buildReport(pr));
      }

      // 项目详情
      if (method === 'GET') {
        const all = db.responses[pid] || [];
        return send(res, 200, {
          project: {
            id: pr.id, productName: pr.productName, version: pr.version, description: pr.description,
            targetSample: pr.targetSample, scaleName: pr.scaleSnapshot.name,
            // 是否为「快速分析外部数据」项目（项目里挂了 autoCreated=true 的自动量表）——
            // 详情页据此切换布局：去掉测评分发板块，因为这些项目不需要在线收数据
            isQuick: pr.autoCreated === true,
            questionCount: pr.scaleSnapshot.questions.length,
            scaleQuestionCount: scaleQuestions(pr.scaleSnapshot.questions).length,
            backgroundQuestionCount: pr.scaleSnapshot.questions.filter(q => q.type !== 'scale').length,
            attentionCount: pr.scaleSnapshot.questions.filter(q => q.isAttention).length,
            dimensions: scaleDimensions(pr.scaleSnapshot.questions),
            // 常模「CSV 原始数据自动计算」需要每道题的维度归属与类型，以及量程（quick 自定义量程
            // 时详情页补常模的 CSV 校验/表单边界要用）；只回传管理端需要的字段（不带 correctValue）。
            questions: pr.scaleSnapshot.questions.map((q, i) => ({
              no: i + 1, id: q.id, text: q.text, type: q.type,
              dimension: q.type === 'scale' ? (q.dimension || null) : null,
              isAttention: !!q.isAttention,
              min: (q.type === 'scale' && typeof q.min === 'number') ? q.min : null,
              max: (q.type === 'scale' && typeof q.max === 'number') ? q.max : null
            })),
            norm: normSummary(pr.norm),
            createdAt: pr.createdAt
          },
          validCount: projectValidCount(pid),
          totalCount: all.length,
          importedCount: all.filter(r => r.source === 'import').length,
          flaggedCount: all.filter(r => r.isValid && (r.flags || []).length > 0).length,
          avgDurationSec: (function () {
            const d = all.map(r => r.durationMs).filter(v => typeof v === 'number' && v > 0);
            return d.length ? Math.round(mean(d) / 1000) : null;
          })(),
          responses: all.map(r => ({
            id: r.id, isValid: r.isValid, invalidReasons: r.invalidReasons || [], flags: r.flags || [],
            submitTime: r.submitTime, durationSec: r.durationMs ? Math.round(r.durationMs / 1000) : null,
            total: r.total, ip: r.ip || '', deviceId: r.deviceId || '',
            source: r.source || 'online', importFile: r.importFile || '', importRow: r.importRow || null
          }))
        });
      }
      if (method === 'DELETE') {
        const snapshot = snapshotBeforeDelete('project');
        const proj = db.projects.find(x => x.id === pid);
        db.projects = db.projects.filter(x => x.id !== pid);
        delete db.responses[pid];
        // P4：快速分析自动建的量表（autoCreated）只服务这一个项目，项目删了就是无人引用的
        // 残留，会在量表列表里越积越多。这里顺带清掉——前提是没有别的项目还引用它。
        // undo 快照是删除前的整库拷贝，恢复时量表会一起回来，不存在恢复缺口。
        let removedAutoScale = null;
        if (proj && proj.autoCreated && proj.scaleId) {
          const stillUsed = db.projects.some(x => x.scaleId === proj.scaleId);
          if (!stillUsed) {
            const si = db.scales.findIndex(s => s.id === proj.scaleId);
            if (si >= 0) {
              removedAutoScale = db.scales[si].name;
              db.scales.splice(si, 1);
            }
          }
        }
        saveDb();
        return send(res, 200, { ok: true, snapshot: snapshot, removedAutoScale: removedAutoScale });
      }
    }
  }

  // ---- 被试个人结果页（已移除） ----
  // 路由 /api/responses/:rid 原本用于公开单份答卷的得分；
  // 整段实现已删除（提交后不再返个人结果，避免心理偏倚 + 防抓取）。

  // ---- 快速分析外部数据 ----
  // 单步完成：接收任意外部 CSV 配 segments → 自动建量表（6 维度）+ 项目 + 导入 → 跳报告页。
  // 与 POST /api/projects（创建并导入）走同一份 buildImportedResponse/calcScores 计分，
  // 唯一区别是「量表不是用户选的，是按 segments 在服务端现场构的」。
  if (p[0] === 'quick-analyze' && p.length === 1 && method === 'POST') {
    const body = await readBody(req);
    const productName = String(body.productName || '').trim();
    if (!productName) return fail(res, 400, '请输入项目 / AI产品名称');
    const target = parseInt(body.targetSample, 10);
    if (!(target >= 1)) return fail(res, 400, '目标样本量必须大于 0');

    const segments = body.segments;
    const columnHeaders = Array.isArray(body.columnHeaders) ? body.columnHeaders.map(s => String(s || '').slice(0, 80)) : null;
    const totalCols = Number(body.totalCols);
    if (!(totalCols >= 1)) return fail(res, 400, '请提供列总数 totalCols');
    if (!Array.isArray(body.records) || body.records.length === 0) {
      return fail(res, 400, '没有解析到可导入的数据行');
    }
    if (body.records.length > IMPORT_MAX_ROWS) {
      return fail(res, 400, '单次最多导入 ' + IMPORT_MAX_ROWS + ' 行（当前 ' + body.records.length + ' 行），请拆成多次导入');
    }

    // 1) 校验 segments（覆盖/重叠/白名单）+ 忽略列（问卷星元数据列不参与计分）
    const igRes = parseQuickIgnoreRanges(body.ignoreRanges, totalCols, columnHeaders);
    if (!igRes.ok) return fail(res, 400, igRes.message);
    const segRes = parseQuickAnalyzeSegments(segments, totalCols, columnHeaders, igRes.cols);
    if (!segRes.ok) return fail(res, 400, segRes.message);

    // 1.2) 量程（可选，默认 1–7）：决定有效性判定（每题 min/max → validateAnswers）
    // 与报告中点参照。此前写死 1–7——1–5 的数据不报错，但中点 4.0 的统计解释整体错位。
    let qMin = QUICK_ANALYZE_DEFAULT_MIN, qMax = QUICK_ANALYZE_DEFAULT_MAX;
    if (body.scaleMin !== undefined || body.scaleMax !== undefined) {
      qMin = Math.floor(Number(body.scaleMin));
      qMax = Math.floor(Number(body.scaleMax));
      if (!isFinite(qMin) || !isFinite(qMax) || !(qMax > qMin)) {
        return fail(res, 400, '量程设置无效：上下限必须是整数，且上限必须大于下限');
      }
    }

    // 1.5) 常模（可选）：与 POST /api/projects 同一套校验，维度名对照 quick 固定 6 维度，
    // 数值边界按上面解析出的量程（1–5 量程下 M=6 的常模应被拒）。
    const nv = validateProjectNorm(body.norm, QUICK_ANALYZE_DIMS, { min: qMin, max: qMax });
    if (!nv.ok) return fail(res, 400, nv.message);

    // 2) 自动构造量表（量程写入每题 min/max，报告管线据此推导中点与天花板/地板）
    let questions;
    try {
      questions = buildQuickAnalyzeQuestions(segRes.columnsByDim, qMin, qMax);
    } catch (e) {
      return fail(res, 400, e.message || '量程配置错误');
    }

    // 3) 建量表并塞进 db.scales（标 `[快速分析]` 前缀，便于在量表列表里一眼识别）
    const scaleId = newId('scale');
    const scaleName = '[快速分析] ' + productName + ' _' + todayStr();
    db.scales.unshift({
      id: scaleId,
      name: scaleName,
      description: '由「快速分析外部数据」流程生成；6 维度固定：' + QUICK_ANALYZE_DIMS.join('、'),
      questions: questions,
      autoCreated: true,
      source: 'quick-analyze',
      createdAt: todayStr()
    });

    // 4) 建项目并落空 db.responses，避免 rollback 时少一个 delete
    const projectId = newId('proj');
    db.projects.unshift({
      id: projectId,
      productName: productName,
      version: String(body.version || 'V1.0').trim() || 'V1.0',
      description: String(body.description || '').trim(),
      targetSample: target,
      norm: nv.norm,
      scaleId: scaleId,
      scaleSnapshot: JSON.parse(JSON.stringify({
        name: scaleName,
        description: '由「快速分析外部数据」流程生成；6 维度固定：' + QUICK_ANALYZE_DIMS.join('、'),
        questions: questions
      })),
      autoCreated: true,
      createdAt: todayStr()
    });
    db.responses[projectId] = [];

    // 5) 把 columnAnswers 转成 answers 后，走跟 POST /api/import 一致的写入路径
    const batchId = newId('imp');
    const fileName = String(body.fileName || '').slice(0, 120);
    const records = body.records.map((rec, i) => ({
      rowIndex: (rec && rec.rowIndex !== undefined) ? rec.rowIndex : (i + 1),
      answers: remapQuickAnalyzeColumnAnswers(rec.columnAnswers, segRes.columnsByDim),
      durationSec: (rec && typeof rec.durationSec === 'number' && isFinite(rec.durationSec)) ? rec.durationSec : null,
      submitTime: rec && rec.submitTime ? String(rec.submitTime).slice(0, 32) : null,
      externalId: rec && rec.externalId ? String(rec.externalId).slice(0, 64) : null
    }));

    const built = buildImportBatch(projectId, records, { batchId, fileName });
    if (!built.ok) {
      // 回滚：项目 / 量表 / 答卷
      db.projects.shift();
      delete db.responses[projectId];
      db.scales.shift();
      return fail(res, built.status, built.message);
    }
    if (built.validCount === 0) {
      db.projects.shift();
      delete db.responses[projectId];
      db.scales.shift();
      return fail(res, 400,
        '导入的数据里没有一条通过校验。请检查 segments 题号段是否覆盖到实际有数据的列，或确认数据集是否与所选量程匹配' +
        (built.errors.length ? '（第 1 行：' + (built.errors[0].message || '未知错误') + '）' : ''));
    }

    writeImportBatch(projectId, built.built, 'append');
    saveDb();

    return send(res, 201, {
      id: projectId,
      scaleId: scaleId,
      scaleName: scaleName,
      autoScale: {
        id: scaleId,
        name: scaleName,
        dimensions: QUICK_ANALYZE_DIMS,
        questionCount: questions.length
      },
      assignment: segRes.assignment,
      columnsBySegment: segRes.columnsBySegment,
      columnsByDim: segRes.columnsByDim,
      redirectTo: 'report',
      import: {
        mode: 'append',
        batchId: batchId,
        fileName: fileName,
        imported: built.built.length,
        skipped: (records.length - built.built.length),
        validCount: built.validCount,
        invalidCount: built.invalidCount,
        totalCount: db.responses[projectId].length,
        projectValidCount: projectValidCount(projectId),
        errors: built.errors.slice(0, 50),
        errorTotal: built.errors.length,
        snapshot: null
      }
    });
  }

  return fail(res, 404, '接口不存在');
}

// ---------- 启动 ----------
loadDb();

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(e => {
      try { fail(res, 400, e.message || '服务器错误'); } catch (_) { /* 已响应 */ }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const lan = lanUrl();
  console.log('========================================');
  console.log('  AI拟人化体验测评工具 v2 已启动');
  console.log('  本机访问:  http://localhost:' + PORT);
  if (lan) console.log('  局域网访问: ' + lan + '  （手机连同一WiFi扫码可用）');
  console.log('  数据文件:  ' + DB_FILE);
  console.log('  自动备份:  ' + BACKUP_DIR + '  （每日一份，保留最近 ' + MAX_BACKUPS + ' 天）');
  console.log('  ----------------------------------------');
  console.log('  停止服务:  Ctrl + C');
  console.log('========================================');
});

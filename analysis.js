/**
 * analysis.js —— 测评报告的「依据引擎」（零依赖，仅用 Math）
 *
 * 设计目标：报告里出现的**每一个数字、每一句结论**，都必须能追溯到下面三种来源之一，
 * 并且在接口返回里以 basis 字段显式标出，由前端原样展示给读者。
 *
 *   A 级 · 公式推导 —— 有明确数学定义，读者可以拿计算器复算
 *   B 级 · 学科惯例 —— 有公开出处的判读阈值（教材 / 方法学文献）
 *   C 级 · 本研究自定 —— 确实找不到通用依据，必须写明"自定"并给出理由
 *
 * 为什么一定要分级：把 C 级包装成 A 级（比如拍一条 5.5 的线然后宣布"属于高拟人化水平"）
 * 是最容易被一句"凭什么"问倒的做法。分级之后读者能清楚知道哪些结论可以较真、
 * 哪些只是叙述性标签。
 *
 * 三条硬规则（改代码时不要破坏）：
 *   1. 任何判读阈值都必须在 BASIS 里登记，并标出 grade 与 source；
 *   2. 凡是能找到公式的，就不允许用"经验分界线"代替（例如"某维度薄弱"改用配对 t 检验，
 *      而不是"均值 < 4.5"）；
 *   3. C 级条目必须在 methodology 里集中声明，不能混在 A/B 级里蒙混过关。
 */
'use strict';

// ============================================================================
// 一、常量
// ============================================================================

/** 证据等级 */
const GRADES = {
  A: { key: 'A', label: '公式推导', short: '可复算', hint: '有明确数学定义，可用计算器逐项复算' },
  B: { key: 'B', label: '学科惯例', short: '有出处', hint: '采用公开文献/教材公认的判读标准' },
  C: { key: 'C', label: '本研究自定', short: '需声明', hint: '无通用标准，为本研究设定的操作化规则，仅供叙述参考' }
};

/** 李克特量程（1-7）。数值中点 = (1+7)/2 = 4，用于「是否显著高于/低于中点」的检验。 */
const SCALE_MIN = 1;
const SCALE_MAX = 7;
const MIDPOINT = (SCALE_MIN + SCALE_MAX) / 2;

/** 显著性水平（双尾） */
const ALPHA_LEVEL = 0.05;

// ============================================================================
// 二、判定依据登记表
//    每一条报告里的判读，都要在这里有一行。source 写清出处，formula 写清怎么算。
// ============================================================================

const BASIS = {
  // ---------- A 级：统计量与公式 ----------
  'stat.mean': { grade: 'A', name: '算术平均数', formula: 'M = Σxᵢ / n', source: '描述统计定义' },
  'stat.sd': { grade: 'A', name: '样本标准差', formula: 's = √( Σ(xᵢ − M)² / (n − 1) )（贝塞尔校正）', source: '描述统计定义' },
  'stat.median': { grade: 'A', name: '中位数', formula: '排序后取中间位置的值（偶数个取中间两值的平均）', source: '描述统计定义' },
  'stat.minmax': { grade: 'A', name: '最小值 / 最大值', formula: '—', source: '描述统计定义' },
  'stat.percentile': { grade: 'A', name: '百分等级', formula: 'PR = (低于该值的人数 + 0.5 × 等于该值的人数) / n × 100%', source: '描述统计定义（中点法）' },
  'stat.z': { grade: 'A', name: '标准分 z', formula: 'z = (x − M) / s', source: '描述统计定义' },
  'stat.alpha': {
    grade: 'A', name: "Cronbach's α 内部一致性系数",
    formula: 'α = (k / (k − 1)) × ( 1 − Σsᵢ² / s_total² )，k = 题项数',
    source: 'Cronbach (1951)；公式为标准形式'
  },
  'stat.splitHalf': {
    grade: 'A', name: '分半信度（奇偶分半）',
    formula: 'r_half = 奇数组总分与偶数组总分的 Pearson 相关；r_SB = 2·r_half / (1 + r_half)',
    source: 'Spearman-Brown  prophesy 公式'
  },
  'stat.sem': {
    grade: 'A', name: '测量标准误 SEM',
    formula: 'SEM = s × √(1 − α)',
    source: '古典测量理论（CTT）定义'
  },
  'stat.ci': {
    grade: 'A', name: '均值 95% 置信区间',
    formula: 'M ± t(0.975, df = n − 1) × s / √n',
    source: 't 分布区间估计；t 临界值见下表'
  },
  'stat.tcrit': {
    grade: 'A', name: 't 分布临界值表',
    formula: '双尾 α = .05 下的 t 临界值，按 df 查表；表外区间取更保守的一档',
    source: '标准 t 分布表'
  },
  'stat.onesample.t': {
    grade: 'A', name: '单样本 t 检验（与量表中点比较）',
    formula: 't = (M − μ₀) / (s / √n)，μ₀ = 量程数值中点（1–7 点量表即 4，1–5 点量表即 3），df = n − 1；p 由 t 分布精确计算',
    source: '标准假设检验方法'
  },
  'stat.paired.t': {
    grade: 'A', name: '配对样本 t 检验（两维度比较）',
    formula: '以同一批被试在两维度上的得分求差值 d，t = M_d / (s_d / √n)，df = n − 1',
    source: '标准假设检验方法；同一被试内比较须用配对设计'
  },
  'stat.cohen.d': {
    grade: 'A', name: "Cohen's d 效应量",
    formula: 'd = (M − μ₀) / s；配对情形 d = M_d / s_d',
    source: 'Cohen (1988) 定义式'
  },
  'stat.itemTotal.r': {
    grade: 'A', name: '校正后题项-总分相关',
    formula: 'r = 该题得分 与「同维度其余题项均分」的 Pearson 相关',
    source: '项目分析常规做法（校正后题总相关）'
  },
  'stat.skew': {
    grade: 'A', name: '偏度 G₁',
    formula: 'G₁ = n / ((n−1)(n−2)) × Σ((xᵢ − M)/s)³（SPSS / Excel SKEW 口径）',
    source: 'Fisher-Pearson 标准化矩系数'
  },
  'stat.kurt': {
    grade: 'A', name: '峰度 G₂',
    formula: 'G₂ = n(n+1)/((n−1)(n−2)(n−3)) × Σ((xᵢ − M)/s)⁴ − 3(n−1)²/((n−2)(n−3))（Excel KURT 口径）',
    source: '超额峰度（以正态分布为 0 基准）'
  },
  'stat.ceiling': {
    grade: 'A', name: '天花板 / 地板效应比例',
    formula: '天花板 = 取量程满分（如 7 点量表的 7）的作答数 / 全部作答数 × 100%；地板 = 取量程最低分（如 1）的比例',
    source: '题目层面极值统计'
  },
  'stat.responseRate': { grade: 'A', name: '有效回收率', formula: '有效答卷数 / 回收答卷总数 × 100%', source: '描述统计定义' },
  'stat.zNorm': {
    grade: 'A', name: '常模标准分 z',
    formula: 'z = (M − M_norm) / SD_norm',
    source: '标准化定义。分母取**常模**的标准差而非本样本的标准差——这是常模参照的标准做法：' +
      '只有用同一把尺子（常模 SD）才能把不同样本放到同一刻度上比较。'
  },
  'stat.normPercentile': {
    grade: 'A', name: '常模百分位（正态近似）',
    formula: 'P = Φ(z) × 100%，Φ 为标准正态累积分布函数',
    source: '标准正态分布定义。Φ 用 Abramowitz & Stegun (1964) 7.1.26 近似式实现，绝对误差 < 1.5×10⁻⁷。' +
      '含义：假定常模分数近似正态时，该均值对应的累积比例。'
  },
  'stat.onesample.tNorm': {
    grade: 'A', name: '单样本 t 检验（与外部常模均值比较）',
    formula: 't = (M − M_norm) / (s / √n)，df = n − 1；H₀：样本均值 = 常模均值',
    source: '标准假设检验方法。与「与量表中点比较」的区别在于 μ₀ 由外部常模给出，而非固定的 4.0。'
  },
  'stat.cohen.dNorm': {
    grade: 'A', name: '与常模比较的效应量 d',
    formula: 'd = (M − M_norm) / SD_norm',
    source: 'Cohen (1988) 的 d 定义用于"与外部参照比较"时的常见形式（以参照组 SD 标准化）。' +
      '该式与上面的 z 数值相同，区别在解读方式：z 用于查正态表定位百分位，d 按 Cohen 惯例判断偏离幅度。'
  },

  // ---------- B 级：学科惯例（有出处） ----------
  'judge.alpha': {
    grade: 'B', name: 'α 系数判读标准',
    formula: 'α ≥ .80 良好；.70–.80 可接受；.60–.70 勉强；< .60 不可接受；α > .95 提示题项内容冗余',
    source: 'Nunnally (1978)；DeVellis (2016)；冗余提示见 Streiner (2003)'
  },
  'judge.itemR': {
    grade: 'B', name: '题项区分度判读标准',
    formula: 'r ≥ .40 优良；.30–.39 良好；.20–.29 勉强可用；< .20 应修订或删除',
    source: 'Ebel (1965) 区分度评定标准'
  },
  'judge.cohenD': {
    grade: 'B', name: "Cohen's d 效应量判读",
    formula: '|d| < 0.2 可忽略；0.2–0.5 小；0.5–0.8 中等；≥ 0.8 大',
    source: 'Cohen (1988)'
  },
  'judge.midpoint': {
    grade: 'B', name: '以量表中点为参照基准',
    formula: '以 1–7 点量表的数值中点 4.0 作为"中性水平"参照，用单样本 t 检验判断是否显著偏离',
    source: '中点参照是李克特量表的通用叙述惯例；注意它**不是常模**，若有既有常模应优先用常模'
  },
  'judge.ceiling': {
    grade: 'B', name: '天花板 / 地板效应判读',
    formula: '极值作答占比 > 15% 提示量程受限，测量灵敏度下降',
    source: 'McHorney & Tarlov (1995) 建议的经验阈值'
  },
  'judge.distribution': {
    grade: 'B', name: '分布形态判读',
    formula: '|偏度| ≤ 2 且 |峰度| ≤ 7 可视为近似正态',
    source: 'West, Finch & Curran (1995)；较宽松的口径见 Kline (2015，|偏度|<3、|峰度|<10)'
  },
  'judge.sampleSize': {
    grade: 'B', name: '样本量充分性标准',
    formula: '样本量 : 题项数 ≥ 5:1（最低）且 ≥ 10:1（理想）；绝对样本量 N ≥ 100 为稳妥线',
    source: 'Gorsuch (1983)；Hair et al. (2010)；MacCallum et al. (1999)'
  },
  'judge.normComparability': {
    grade: 'B', name: '常模参照的可比性前提',
    formula: '常模参照有效的三个条件：① 量表相同（题目与计分口径一致）；② 施测人群与本研究目标总体相近；③ 施测时间不过于久远',
    source: '心理测量学对常模参照（norm-referenced）的一般要求。常模不可比时，z 分数与百分位的解释力会显著下降——' +
      '这也是为什么"有常模"不等于"结论更硬"，常模本身的质量决定比较的上限。'
  },

  // ---------- C 级：本研究自定（必须声明） ----------
  'self.levelLabel': {
    grade: 'C', name: '拟人化等级标签',
    formula: 'M ≥ 5.5 高 / ≥ 4.5 较高 / ≥ 3.5 中等 / 其余 低',
    source: '本研究自定。无外部常模可依，四个切分点是为了让报告便于口头转述而设，**仅作叙述性标签，不作为统计推断依据**；推断请以「与量表中点比较」的 t 检验结果为准。'
  },
  'self.flagRules': {
    grade: 'C', name: '可疑作答标记规则',
    formula: '全部题目同一选项 / 作答选项集中在 ≤ 2 种 / 用时应短于题项数 × 2 秒 / 同一 IP 多次提交',
    source: '本研究自定。参考常见的作答质量筛查惯例设定，仅作人工复核提示，不直接判定答卷无效。'
  },
  'self.advice': {
    grade: 'C', name: '改进方向提示',
    formula: '按「维度得分显著低于量表中点」或「该维度为样本内相对最弱且差异显著」触发，输出对应维度的预设改进方向',
    source: '本研究自定。属**基于低分维度的改进方向提示**，不是因果推断，也不构成"分析结论"——它只回答"哪一项得分低、可以往哪个方向查"，不回答"为什么低"。'
  },
  'self.dimensionAdviceFallback': {
    grade: 'C', name: '无预设模板时的数据驱动提示',
    formula: '引用该维度得分最低的具体题项（第几题、题干、均值、与维度均值之差）生成提示',
    source: '本研究自定。比通用套话更有指向性，但仍属描述性提示。'
  }
};

// ============================================================================
// 三、基础统计函数
// ============================================================================

function mean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
/**
 * 「实质为零的标准差」判定。
 *
 * 为什么必须单独处理：当一组数据全部取同一个值时，数学上方差恰好是 0；
 * 但用 Σ(x−M)² 逐项累加时，M 本身带舍入误差，会残留约 1e-30 量级的方差
 * （即 s ≈ 1e-15，而不是精确的 0）。下游所有 `if (!s)` 形式的判零都会失效，
 * 于是 t = (M−μ₀)/se 被放大到 1e15 这种量级，d 同理 —— 荒谬的数字会直接印进报告。
 *
 * 这里按「相对于分数尺度可忽略」判定，而不是与字面 0 比较。
 */
function isZeroVar(v, m) {
  if (v === null || v === undefined || !isFinite(v)) return true;
  if (v <= 0) return true;
  const scale = Math.max(Math.abs(m || 0), SCALE_MAX, 1);
  const eps = scale * 1e-9;
  return v <= eps * eps;
}

function variance(arr) {
  if (!arr || arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  // 归零处理集中在这一处：只要 variance 返回精确的 0，下游所有 `!s` 判零、
  // pearson 的 sxx<=0 判零、cronbachAlpha 的 totalVar<=0 判零就都能正确生效，
  // 不必在每个调用点各打一个补丁（补丁迟早会漏）。
  return isZeroVar(v, m) ? 0 : v;
}
function sd(arr) {
  const v = variance(arr);
  return v === null ? null : Math.sqrt(v);
}
function median(arr) {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function minOf(arr) { return arr && arr.length ? Math.min.apply(null, arr) : null; }
function maxOf(arr) { return arr && arr.length ? Math.max.apply(null, arr) : null; }

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Cronbach's α：rows = 被试，cols = 题项 */
function cronbachAlpha(rows) {
  if (!rows || rows.length < 2) return null;
  const k = rows[0].length;
  if (k < 2) return null;
  const itemVar = [];
  for (let c = 0; c < k; c++) {
    const v = variance(rows.map(r => r[c]));
    if (v === null) return null;
    itemVar.push(v);
  }
  const totals = rows.map(r => r.reduce((a, b) => a + b, 0));
  const totalVar = variance(totals);
  if (totalVar === null || totalVar <= 0) return null;
  const sumItemVar = itemVar.reduce((a, b) => a + b, 0);
  return (k / (k - 1)) * (1 - sumItemVar / totalVar);
}

/** 分半信度（奇偶题）→ Spearman-Brown 校正 */
function splitHalf(rows) {
  if (!rows || rows.length < 2 || rows[0].length < 2) return null;
  const odd = rows.map(r => r.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0));
  const even = rows.map(r => r.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0));
  const r = pearson(odd, even);
  if (r === null) return null;
  // r → −1 时分母趋近 0，校正值会发散成 ±Infinity。这种情形说明奇偶两半反向，
  // 多半是存在未做反向计分的反向题，返回 null（前端显示"—"）比抛出一个无穷大更有意义。
  if (1 + r <= 1e-12) return null;
  const sb = (2 * r) / (1 + r);
  return isFinite(sb) ? sb : null;
}

/** 百分等级（中点法） */
function percentileRank(arr, v) {
  if (!arr || !arr.length || v === null || v === undefined) return null;
  let below = 0, equal = 0;
  arr.forEach(x => { if (x < v) below++; else if (x === v) equal++; });
  return (below + 0.5 * equal) / arr.length * 100;
}

/** 偏度 G₁（Excel SKEW 口径） */
function skewness(arr) {
  const n = arr.length;
  if (n < 3) return null;
  const m = mean(arr), s = sd(arr);
  if (!s) return null;
  let sum = 0;
  arr.forEach(x => { sum += Math.pow((x - m) / s, 3); });
  return n / ((n - 1) * (n - 2)) * sum;
}

/** 峰度 G₂（Excel KURT 口径，正态为 0） */
function kurtosis(arr) {
  const n = arr.length;
  if (n < 4) return null;
  const m = mean(arr), s = sd(arr);
  if (!s) return null;
  let sum = 0;
  arr.forEach(x => { sum += Math.pow((x - m) / s, 4); });
  return n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * sum
    - 3 * (n - 1) * (n - 1) / ((n - 2) * (n - 3));
}

// ---------- t 分布 ----------

/** Lanczos 近似的 log Γ(x) */
function logGamma(x) {
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = C[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 连分式展开（Numerical Recipes 口径） */
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a, b) */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

/**
 * 双尾 p 值（t 分布精确计算，非查表近似）。
 * p = I_{df/(df+t²)}(df/2, 1/2)
 */
function studentTp(t, df) {
  if (!(df > 0) || !isFinite(t)) return null;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  const p = betai(df / 2, 0.5, x);
  if (!isFinite(p)) return null;
  return Math.max(0, Math.min(1, p));
}

/** t 分布双尾 α=.05 临界值表：[df, t] 递增 */
const T_TABLE = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571],
  [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228],
  [11, 2.201], [12, 2.179], [13, 2.160], [14, 2.145], [15, 2.131],
  [16, 2.120], [17, 2.110], [18, 2.101], [19, 2.093], [20, 2.086],
  [21, 2.080], [22, 2.074], [23, 2.069], [24, 2.064], [25, 2.060],
  [26, 2.056], [27, 2.052], [28, 2.048], [29, 2.045], [30, 2.042],
  [40, 2.021], [50, 2.009], [60, 2.000], [80, 1.990], [100, 1.984],
  [120, 1.980], [100000, 1.960]
];

/** 查 t 临界值。表外区间取更保守（更大）的一档，使结论不易被高估。 */
function tCrit(df) {
  if (!(df > 0)) return null;
  let t = 1.96;
  for (let i = 0; i < T_TABLE.length; i++) {
    if (df >= T_TABLE[i][0]) t = T_TABLE[i][1];
    else break;
  }
  return t;
}

/** 均值 95% 置信区间 */
function meanCI(arr) {
  const n = arr.length;
  if (n < 2) return null;
  const m = mean(arr), s = sd(arr);
  if (m === null || !s) return null;
  const df = n - 1;
  const tc = tCrit(df);
  const se = s / Math.sqrt(n);
  const margin = tc * se;
  return { n, df, mean: m, sd: s, se, tCrit: tc, margin, lower: m - margin, upper: m + margin };
}

/**
 * 单样本 t 检验：样本均值是否显著偏离 μ₀（默认量表中点 4.0）。
 * 返回 t、df、精确双尾 p、是否显著、偏离方向。
 */
function oneSampleT(arr, mu0) {
  const n = arr.length;
  if (n < 2) return null;
  const m = mean(arr), s = sd(arr);
  if (m === null || !s) return null;
  const se = s / Math.sqrt(n);
  const df = n - 1;
  const t = (m - mu0) / se;
  const p = studentTp(t, df);
  const tc = tCrit(df);
  const significant = p !== null && p < ALPHA_LEVEL;
  return {
    n, df, mu0, mean: m, sd: s, se, t, p, tCrit: tc, significant,
    direction: !significant ? 'none' : (t > 0 ? 'above' : 'below')
  };
}

/**
 * 配对样本 t 检验：x 与 y 为同一批被试在两个条件下的得分。
 * 同一被试做两个维度的比较必须用配对设计——独立样本检验会高估方差、损失检验力。
 */
function pairedT(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const diffs = [];
  for (let i = 0; i < n; i++) diffs.push(x[i] - y[i]);
  const md = mean(diffs), sdd = sd(diffs);
  if (md === null || !sdd) return null;
  const se = sdd / Math.sqrt(n);
  const df = n - 1;
  const t = md / se;
  const p = studentTp(t, df);
  return {
    n, df, meanDiff: md, sdDiff: sdd, se, t, p,
    tCrit: tCrit(df),
    significant: p !== null && p < ALPHA_LEVEL,
    d: md / sdd
  };
}

/** Cohen's d：样本均值相对参照值 μ₀ 的标准化差值 */
function cohensD(arr, mu0) {
  const m = mean(arr), s = sd(arr);
  if (m === null || !s) return null;
  return (m - mu0) / s;
}

/** 单侧 95% 下界（用于「不低于某水平」的保守陈述），t 单尾临界值近似用双尾值，偏保守 */
function lowerBound(arr) {
  const ci = meanCI(arr);
  if (!ci) return null;
  return ci.lower;
}

// ---------- 正态分布（常模百分位用） ----------

/**
 * 误差函数 erf(x)，Abramowitz & Stegun (1964) 7.1.26 近似，最大绝对误差 1.5e-7。
 * 自己实现而不是引依赖：本文件的设计前提是零依赖，且百分位只需 4 位有效数字。
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t * Math.exp(-ax * ax);
  return sign * y;
}

/** 标准正态累积分布函数 Φ(z)，返回 0–1 的概率 */
function normalCdf(z) {
  if (z === null || z === undefined || !isFinite(z)) return null;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * 把用户填写的常模配置规整成内部结构；不合法则返回 null（等于"没设常模"）。
 *
 * 为什么要在这里做一遍校验：常模是**用户输入**，一个 SD = 0 或均值 9 的常模
 * 会让 z 变成 Infinity / 越界百分位，进而把荒谬数字印进报告。
 * 服务端另有一道校验用于给用户报错，这里这道是最后防线。
 */
function normalizeNorm(raw, range) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;
  // 边界按项目实际量程：快速分析自定义 1–5 量程时，M=6 的常模在此被拦截（返回 null 退回中点参照）。
  // 服务端 validateProjectNorm 已按同一量程报错在前，这里是报告前的最后防线。
  const rMin = (range && isFinite(range.min)) ? range.min : SCALE_MIN;
  const rMax = (range && isFinite(range.max)) ? range.max : SCALE_MAX;
  const mean = Number(raw.mean), sd = Number(raw.sd);
  if (!isFinite(mean) || !isFinite(sd) || sd <= 0) return null;
  if (mean < rMin || mean > rMax) return null;
  const nRaw = Number(raw.n);
  const normName = String(raw.name || '').trim() || '外部常模';
  const normSource = String(raw.source || '').trim();
  const normYear = String(raw.year || '').trim();
  const dims = {};
  if (raw.dimensions && typeof raw.dimensions === 'object') {
    Object.keys(raw.dimensions).forEach(k => {
      const d = raw.dimensions[k] || {};
      const dm = Number(d.mean), ds = Number(d.sd);
      if (isFinite(dm) && isFinite(ds) && ds > 0 && dm >= rMin && dm <= rMax) {
        const dn = Number(d.n);
        // 维度级常模必须继承所属常模的名称/来源/年份。
        // 一个常模就是一份常模，它的分量表常模没有独立的"名字"；
        // 若不继承，下游 normCompareBlock 的 ref.name 会是 undefined，
        // 报告里就会印出「常模「undefined」的 4.4」这种话。
        dims[k] = {
          name: normName, source: normSource, year: normYear,
          dimension: k,
          mean: dm, sd: ds, n: isFinite(dn) && dn > 0 ? Math.round(dn) : null
        };
      }
    });
  }
  return {
    name: normName,
    source: normSource,
    year: normYear,
    mean, sd,
    n: isFinite(nRaw) && nRaw > 0 ? Math.round(nRaw) : null,
    dimensions: dims
  };
}

/**
 * 常模参照比较块。
 *
 * 与「量表中点参照」的分工：
 *   中点参照 —— 只回答"是否偏离中性"，与任何既有研究无关，永远不会失效但信息量也小；
 *   常模参照 —— 回答"在同量表、同人群的常模里处于什么位置"，信息量大但把结论的
 *                可靠性押在了"常模可比"这个前提上。
 * 两者都给，并把各自的前提写在报告里，而不是二选一后不说明。
 *
 * @param {number[]} arr 被试层面的分数（综合得分或某维度得分）
 * @param {object}   ref 常模参照（{name, source, mean, sd, n}）
 * @param {string}   scope 'total' | 'dimension' | 'dimension-via-total'，用于说明参照来源
 */
function normCompareBlock(arr, ref, scope) {
  if (!ref || !arr || !arr.length) return null;
  const n = arr.length;
  const m = mean(arr), s = sd(arr);
  if (m === null) return null;

  // z 与 d 共用分母（常模 SD），数值必然相同；分开返回是为了让前端能分别挂依据。
  const z = (m - ref.mean) / ref.sd;
  const pct = normalCdf(z) === null ? null : normalCdf(z) * 100;

  let t = null, df = null, p = null, significant = null, direction = 'none';
  // s 为 0（全员同分）时标准误为 0，检验没有定义——必须跳过而不是输出 Infinity
  if (n >= 2 && s) {
    df = n - 1;
    t = (m - ref.mean) / (s / Math.sqrt(n));
    p = studentTp(t, df);
    significant = p !== null && p < ALPHA_LEVEL;
    direction = !significant ? 'none' : (t > 0 ? 'above' : 'below');
  }

  return {
    scope: scope || 'total',
    // 兜底：常模名绝不能是 undefined。任何调用方漏传 name 时，宁可退回一个
    // 中性但可读的标签，也不能让 "undefined" 印进报告正文或建议的触发条件里。
    normName: (ref.name === undefined || ref.name === null || String(ref.name).trim() === '')
      ? '外部常模' : String(ref.name),
    normSource: ref.source || '',
    normYear: ref.year || '',
    normDimension: ref.dimension || null,
    normMean: ref.mean,
    normSd: ref.sd,
    normN: ref.n === undefined ? null : ref.n,
    n, mean: m, sd: s,
    diff: m - ref.mean,
    z: round3(z),
    percentile: round2(pct),
    cohensD: round3(z),
    cohensDJudge: judgeCohenD(z),
    t: round3(t), df, p: round4(p), pLabel: pLabel(p),
    significant, direction
  };
}

// ============================================================================
// 四、判读规则
// ============================================================================

function judgeAlpha(a) {
  if (a === null || a === undefined || !isFinite(a)) {
    return { value: null, label: '无法计算', level: 'na', grade: 'A', basisId: 'stat.alpha', note: '有效样本或题项数不足（α 至少需要 2 份有效答卷、2 个题项）' };
  }
  if (a >= 0.95) return { value: a, label: '极好（但提示题项冗余）', level: 'warn', grade: 'B', basisId: 'judge.alpha', note: 'α > .95 通常说明题目在问同一件事，可考虑精简' };
  if (a >= 0.80) return { value: a, label: '良好', level: 'ok', grade: 'B', basisId: 'judge.alpha' };
  if (a >= 0.70) return { value: a, label: '可接受', level: 'ok', grade: 'B', basisId: 'judge.alpha' };
  if (a >= 0.60) return { value: a, label: '勉强，建议修订', level: 'warn', grade: 'B', basisId: 'judge.alpha' };
  if (a >= 0) return { value: a, label: '不可接受，需修订题项', level: 'alert', grade: 'B', basisId: 'judge.alpha' };
  return { value: a, label: '异常（α 为负，题项间可能存在反向计分问题）', level: 'alert', grade: 'B', basisId: 'judge.alpha' };
}

function judgeItemR(r) {
  if (r === null || r === undefined || !isFinite(r)) {
    return { level: 'na', label: '—', grade: 'A', basisId: 'stat.itemTotal.r', note: '样本不足或该维度只有 1 题，无法计算' };
  }
  if (r < 0) return { level: 'bad', label: '负相关 · 应删', grade: 'B', basisId: 'judge.itemR' };
  if (r >= 0.40) return { level: 'ok', label: '优良', grade: 'B', basisId: 'judge.itemR' };
  if (r >= 0.30) return { level: 'ok', label: '良好', grade: 'B', basisId: 'judge.itemR' };
  if (r >= 0.20) return { level: 'warn', label: '勉强可用', grade: 'B', basisId: 'judge.itemR' };
  return { level: 'bad', label: '区分度不足', grade: 'B', basisId: 'judge.itemR' };
}

function judgeCohenD(d) {
  if (d === null || d === undefined || !isFinite(d)) {
    return { value: null, label: '—', grade: 'B', basisId: 'judge.cohenD' };
  }
  const a = Math.abs(d);
  const label = a < 0.2 ? '可忽略' : a < 0.5 ? '小' : a < 0.8 ? '中等' : '大';
  return { value: d, magnitude: a, label, grade: 'B', basisId: 'judge.cohenD' };
}

function judgeCeiling(pct) {
  if (pct === null || pct === undefined) return { level: 'na', label: '—', grade: 'B', basisId: 'judge.ceiling' };
  if (pct > 15) return { value: pct, level: 'warn', label: '天花板效应（>' + 15 + '%）', grade: 'B', basisId: 'judge.ceiling' };
  return { value: pct, level: 'ok', label: '正常', grade: 'B', basisId: 'judge.ceiling' };
}

function judgeFloor(pct) {
  if (pct === null || pct === undefined) return { level: 'na', label: '—', grade: 'B', basisId: 'judge.ceiling' };
  if (pct > 15) return { value: pct, level: 'warn', label: '地板效应（>' + 15 + '%）', grade: 'B', basisId: 'judge.ceiling' };
  return { value: pct, level: 'ok', label: '正常', grade: 'B', basisId: 'judge.ceiling' };
}

function judgeDistribution(sk, ku) {
  // sk/ku 为 null 有两种成因：样本量不足（偏度需 n≥3、峰度需 n≥4），
  // 或者全部取值相同导致方差为 0、标准化矩无从计算。文案要把两者都覆盖到，
  // 否则「全员同分」会被误报成「样本不足」，把用户的排查方向带偏。
  if (sk === null && ku === null) return { level: 'na', label: '无法判断（样本不足或得分无变异）', grade: 'B', basisId: 'judge.distribution' };
  const bad = (sk !== null && Math.abs(sk) > 2) || (ku !== null && Math.abs(ku) > 7);
  return {
    level: bad ? 'warn' : 'ok',
    label: bad ? '偏离近似正态（|偏度|>2 或 |峰度|>7）' : '近似正态',
    grade: 'B',
    basisId: 'judge.distribution'
  };
}

/** 样本量充分性：题项比 + 绝对样本量 */
function judgeSampleAdequacy(n, k) {
  const ratio = k ? n / k : null;
  let level = 'ok', label = '充分';
  const notes = [];
  if (ratio !== null) {
    if (ratio < 5) { level = 'alert'; label = '不足'; notes.push('题项比 ' + round2(ratio) + ':1 低于最低建议 5:1'); }
    else if (ratio < 10) { level = 'warn'; label = '偏低'; notes.push('题项比 ' + round2(ratio) + ':1 达到最低要求，但未达理想 10:1'); }
  }
  if (n < 100) {
    if (level === 'ok') { level = 'warn'; label = '偏低'; }
    notes.push('绝对样本量 ' + n + ' 少于稳妥线 100');
  }
  if (n < 30) { level = 'alert'; label = '严重不足'; notes.push('样本量 ' + n + ' 小于 30，参数估计不稳定，t 检验结果仅供参考'); }
  return { n, itemCount: k, ratio, level, label, notes, grade: 'B', basisId: 'judge.sampleSize' };
}

/** 拟人化等级标签（C 级 · 自定） */
function levelLabel(m) {
  if (m === null || m === undefined) return null;
  if (m >= 5.5) return '高';
  if (m >= 4.5) return '较高';
  if (m >= 3.5) return '中等';
  return '低';
}

// ============================================================================
// 五、改进方向提示引擎
//    用关键词匹配而不是精确等名——量表维度改一个字（"陪伴拟真" → "陪伴感"）
//    精确匹配就会静默失效，报告里只剩一句什么也没说的套话。
// ============================================================================

const DIMENSION_ADVICE = [
  {
    keys: ['人设', '人格', '角色', '设定'],
    text: '优化角色设定的一致性管理：确保多轮对话中性格、语气、价值观保持稳定，避免前后矛盾的回复；对超出设定范围的提问，应有统一的处理方式。'
  },
  {
    keys: ['共情', '同理', '情绪识别', '情绪理解'],
    text: '提升对潜台词与隐含情绪的理解能力：先复述确认对方的感受，再给建议；避免在对方表达负面情绪时直接跳到解决方案。'
  },
  {
    keys: ['情感表达', '情绪表达', '表达', '语气', '温度'],
    text: '增加回应中的情绪色彩与语气温度：使用更生动自然的措辞，允许适度的口语化语气词，减少机械、模板化的表达。'
  },
  {
    keys: ['原则', '责任', '边界', '价值观', '立场', '道德'],
    text: '完善边界意识与原则坚守机制：面对不合理请求时能明确说明理由并拒绝，让用户感知到"有立场"，而非一味顺从。'
  },
  {
    keys: ['陪伴', '拟真', '在场', '存在感', '依恋', '关系'],
    text: '提升对话的自然度与连贯性：减少机械感回复，增加口语化表达与适度的主动关心，让交互更像持续的相处而不是一问一答。'
  },
  {
    keys: ['沟通', '风格', '口语', '语言', '措辞', '表达方式'],
    text: '让措辞更接近日常口语：缩短句长，避免过于书面化的表达，控制专业术语密度，提高"像真人发消息"的体验。'
  }
];

/** 按关键词匹配维度 → 返回建议模板（未命中返回 null） */
function matchAdvice(dimName) {
  if (!dimName) return null;
  for (let i = 0; i < DIMENSION_ADVICE.length; i++) {
    const g = DIMENSION_ADVICE[i];
    for (let j = 0; j < g.keys.length; j++) {
      if (dimName.indexOf(g.keys[j]) >= 0) return g.text;
    }
  }
  return null;
}

/** 兜底：无预设模板时，引用该维度得分最低的具体题项生成提示（C 级·数据驱动） */
function dataDrivenAdvice(dimName, dimMean, weakestItem) {
  if (!weakestItem) {
    return '「' + dimName + '」维度未匹配到预设改进模板，且样本不足以定位具体题项。建议在量表中为该维度补充明确的改进方向模板（analysis.js 的 DIMENSION_ADVICE）。';
  }
  const diff = dimMean !== null && weakestItem.mean !== null
    ? (dimMean - weakestItem.mean) : null;
  return '「' + dimName + '」维度得分最低的是第 ' + weakestItem.no + ' 题「' + weakestItem.text + '」' +
    '（M = ' + round2(weakestItem.mean) +
    (diff !== null ? '，比该维度均值低 ' + round2(diff) + ' 分' : '') +
    '）。建议先针对这一题所描述的具体行为特征排查产品表现，而非泛化优化整个维度。';
}

// ============================================================================
// 六、主入口
// ============================================================================

function round2(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100; }
function round3(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 1000) / 1000; }
function round4(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10000) / 10000; }

/** p 值格式化：p < .001 或 p = .023 */
function pLabel(p) {
  if (p === null || p === undefined) return '—';
  if (p < 0.001) return 'p < .001';
  return 'p = ' + p.toFixed(3).replace(/^0/, '');
}

/**
 * 生成报告的全部分析块。
 *
 * @param {Object} input
 *   @param {Array}  input.questions    量表题目（含 id/type/dimension/isAttention/text）
 *   @param {Array}  input.responses    该项目全部答卷（含 isValid/answers/scores/total/durationMs/flags/ip/deviceId）
 *   @param {number} input.targetSample 目标样本量
 *   @param {Object} input.norm         外部常模（选填）。形如
 *        { name, source, year, mean, sd, n, dimensions: { 维度名: {mean, sd, n} } }；
 *        不合法或未提供时全部按「无外部常模」处理，退回量表中点参照。
 * @returns {Object} 可直接并入报告返回体的分析块
 */
function analyze(input) {
  const questions = input.questions || [];
  const all = input.responses || [];
  const targetSample = input.targetSample || 0;
  const warnings = [];

  const scaleQs = questions.filter(q => q.type === 'scale');
  const scored = scaleQs.filter(q => !q.isAttention);

  // 量程推导：优先读量表题自带的 min/max（快速分析自定义量程时写入每题），全部缺失时退回默认 1–7。
  // 中点参照（t 检验 μ₀）、天花板/地板、报告 meta、常模边界全部按实际量程走——
  // 否则 1–5 的数据按 7 点口径解释：中点该是 3 而不是 4，满分该是 5 而不是 7，整体错位且无提示。
  const qMins = scored.map(q => q.min).filter(v => typeof v === 'number' && isFinite(v));
  const qMaxs = scored.map(q => q.max).filter(v => typeof v === 'number' && isFinite(v));
  const rangeMin = qMins.length ? Math.min.apply(null, qMins) : SCALE_MIN;
  const rangeMax = qMaxs.length ? Math.max.apply(null, qMaxs) : SCALE_MAX;
  const midpoint = (rangeMin + rangeMax) / 2;

  // 外部常模：用户可能只填了名称没填数，或者填了 SD = 0，这里统一规整
  const normRef = normalizeNorm(input.norm, { min: rangeMin, max: rangeMax });
  const normEnabled = !!normRef;

  const valid = all.filter(r => r.isValid);
  const n = valid.length;

  const dims = [];
  scored.forEach(q => { if (q.dimension && dims.indexOf(q.dimension) < 0) dims.push(q.dimension); });

  // ---------- 各维度 ----------
  const dimBlocks = dims.map(name => {
    const items = scored.filter(q => q.dimension === name);
    const perResp = [];
    valid.forEach(r => {
      const vs = items.map(q => r.answers ? r.answers[q.id] : undefined);
      if (vs.every(v => typeof v === 'number' && isFinite(v))) {
        perResp.push({ rid: r.id, v: vs, m: mean(vs) });
      }
    });
    const means = perResp.map(x => x.m);
    const ci = meanCI(means);
    const ttest = oneSampleT(means, midpoint);
    const dRaw = cohensD(means, midpoint);
    const al = perResp.length >= 2 && items.length >= 2 ? cronbachAlpha(perResp.map(x => x.v)) : null;
    const s = sd(means);
    const semVal = (al !== null && s !== null && al < 1) ? s * Math.sqrt(1 - al) : null;

    const flat = [];
    perResp.forEach(x => x.v.forEach(v => flat.push(v)));
    const ceilingPct = flat.length ? flat.filter(v => v === rangeMax).length / flat.length * 100 : null;
    const floorPct = flat.length ? flat.filter(v => v === rangeMin).length / flat.length * 100 : null;

    const itemMeans = items.map(q => {
      const vals = valid.map(r => (r.answers ? r.answers[q.id] : undefined)).filter(v => typeof v === 'number' && isFinite(v));
      return {
        id: q.id, no: questions.indexOf(q) + 1, text: q.text,
        mean: mean(vals), sd: sd(vals), n: vals.length
      };
    }).sort((a, b) => (a.mean === null ? 1 : b.mean === null ? -1 : a.mean - b.mean));

    return {
      name,
      itemCount: items.length,
      n: means.length,
      droppedIncomplete: n - means.length,
      mean: round2(mean(means)),
      sd: round2(s),
      median: round2(median(means)),
      min: round2(minOf(means)),
      max: round2(maxOf(means)),
      alpha: round3(al),
      alphaJudge: judgeAlpha(al),
      sem: round3(semVal),
      ci95: ci ? { lower: round3(ci.lower), upper: round3(ci.upper), margin: round3(ci.margin), se: round3(ci.se), tCrit: ci.tCrit, df: ci.df } : null,
      tTest: ttest ? {
        t: round3(ttest.t), df: ttest.df, p: round4(ttest.p), pLabel: pLabel(ttest.p),
        tCrit: ttest.tCrit, significant: ttest.significant, direction: ttest.direction, mu0: midpoint
      } : null,
      cohensD: round3(dRaw),
      cohensDJudge: judgeCohenD(dRaw),
      percentileOfMean: round2(percentileRank(means, mean(means))),
      ceilingPct: round2(ceilingPct),
      floorPct: round2(floorPct),
      ceilingJudge: judgeCeiling(ceilingPct),
      floorJudge: judgeFloor(floorPct),
      skewness: round3(skewness(means)),
      kurtosis: round3(kurtosis(means)),
      distributionJudge: judgeDistribution(skewness(means), kurtosis(means)),
      weakestItem: itemMeans[0] ? {
        id: itemMeans[0].id, no: itemMeans[0].no, text: itemMeans[0].text, mean: round2(itemMeans[0].mean), sd: round2(itemMeans[0].sd)
      } : null,
      strongestItem: itemMeans.length ? {
        id: itemMeans[itemMeans.length - 1].id, no: itemMeans[itemMeans.length - 1].no,
        text: itemMeans[itemMeans.length - 1].text, mean: round2(itemMeans[itemMeans.length - 1].mean)
      } : null,
      itemMeans: itemMeans.map(x => ({ no: x.no, text: x.text, mean: round2(x.mean), sd: round2(x.sd), n: x.n })),
      // 常模参照：优先用该维度自己的常模；没有则退回总量表常模，并在 scope 里标明，
      // 让前端能提示"这一维度用的是总量表常模，定位精度更粗"。
      normCompare: (function () {
        if (!normRef) return null;
        const own = normRef.dimensions[name];
        return normCompareBlock(means, own || normRef, own ? 'dimension' : 'dimension-via-total');
      })(),
      // 内部用：逐人维度分（用于配对检验），返回前删除
      _perResp: perResp
    };
  });

  // ---------- 综合得分 ----------
  const totalPerResp = [];
  valid.forEach(r => {
    const vals = [];
    dimBlocks.forEach(db2 => {
      const hit = db2._perResp.find(x => x.rid === r.id);
      if (hit) vals.push(hit.m);
    });
    if (vals.length) totalPerResp.push(mean(vals));
  });

  const totalCI = meanCI(totalPerResp);
  const totalT = oneSampleT(totalPerResp, midpoint);
  const totalD = cohensD(totalPerResp, midpoint);
  // 全员综合得分完全相同 → 方差为 0 → 无法做任何推断。
  // 必须与「样本不足」区分开：前者是数据本身没有变异，加样本也未必解决；
  // 后者是样本量少。两者的处理建议完全不同，不能共用一个文案。
  const totalVarZero = totalPerResp.length >= 2 && sd(totalPerResp) === 0;
  // 常模参照：与「量表中点比较」并行存在的第二套参照系。有常模时它才是回答
  // "在同类型人群/产品中处于什么位置"的那一个，中点检验无法回答这个问题。
  const totalNorm = normRef ? normCompareBlock(totalPerResp, normRef, 'total') : null;
  const totalAllItems = [];
  valid.forEach(r => {
    scored.forEach(q => {
      const v = r.answers ? r.answers[q.id] : undefined;
      if (typeof v === 'number' && isFinite(v)) totalAllItems.push(v);
    });
  });

  // 整体信度
  const scoringItems = scored;
  const rowsAll = valid.map(r => scoringItems.map(q => (r.answers ? r.answers[q.id] : undefined)))
    .filter(v => v.every(x => typeof x === 'number' && isFinite(x)));
  const alphaOverall = rowsAll.length >= 2 && scoringItems.length >= 2 ? cronbachAlpha(rowsAll) : null;
  const splitHalfOverall = rowsAll.length >= 2 && scoringItems.length >= 4 ? splitHalf(rowsAll) : null;
  const semOverall = (alphaOverall !== null && totalCI) ? totalCI.sd * Math.sqrt(1 - alphaOverall) : null;

  // ---------- 最强 / 最弱维度的配对检验 ----------
  const usable = dimBlocks.filter(d => d.n > 0 && d.mean !== null);
  let pairTest = null;
  if (usable.length >= 2) {
    const sorted = usable.slice().sort((a, b) => b.mean - a.mean);
    const hi = sorted[0], lo = sorted[sorted.length - 1];
    const mapHi = {}, mapLo = {};
    hi._perResp.forEach(x => { mapHi[x.rid] = x.m; });
    lo._perResp.forEach(x => { mapLo[x.rid] = x.m; });
    const xs = [], ys = [];
    Object.keys(mapHi).forEach(rid => { if (mapLo[rid] !== undefined) { xs.push(mapHi[rid]); ys.push(mapLo[rid]); } });
    const pt = pairedT(xs, ys);
    if (pt) {
      pairTest = {
        highDim: hi.name, lowDim: lo.name,
        highMean: hi.mean, lowMean: lo.mean,
        gap: round2(hi.mean - lo.mean),
        n: pt.n, df: pt.df,
        meanDiff: round3(pt.meanDiff), sdDiff: round3(pt.sdDiff), se: round3(pt.se),
        t: round3(pt.t), p: round4(pt.p), pLabel: pLabel(pt.p), tCrit: pt.tCrit,
        significant: pt.significant,
        d: round3(pt.d), dJudge: judgeCohenD(pt.d)
      };
    }
  }

  // ---------- 题项质量 ----------
  // 覆盖**全部量表题**（含注意力检测题）——报告的题项表要把检测题也列出来，
  // 但它不计分，所以不给区分度判读，r 记为 null 并单独标注原因。
  const itemQuality = scaleQs.map(q => {
    const vals = valid.map(resp => (resp.answers ? resp.answers[q.id] : undefined))
      .filter(v => typeof v === 'number' && isFinite(v));
    const base = {
      id: q.id, index: questions.indexOf(q) + 1, text: q.text,
      dimension: q.dimension || '', isAttention: !!q.isAttention,
      n: vals.length, mean: round2(mean(vals)), sd: round2(sd(vals))
    };
    if (q.isAttention) {
      return Object.assign(base, {
        r: null, rLevel: 'na', rLabel: '不计分', basis: 'stat.itemTotal.r',
        rNote: '注意力检测题，不参与计分与区分度分析'
      });
    }
    const sibs = scored.filter(x => x.dimension === q.dimension && x.id !== q.id);
    let r = null;
    if (sibs.length) {
      const pairs = valid.map(resp => ({
        x: resp.answers ? resp.answers[q.id] : undefined,
        y: mean(sibs.map(s => (resp.answers ? resp.answers[s.id] : undefined)).filter(v => typeof v === 'number' && isFinite(v)))
      })).filter(p => typeof p.x === 'number' && isFinite(p.x) && p.y !== null);
      r = pairs.length >= 3 ? pearson(pairs.map(p => p.x), pairs.map(p => p.y)) : null;
    }
    const j = judgeItemR(r);
    return Object.assign(base, {
      r: round3(r), rLevel: j.level, rLabel: j.label, rNote: j.note || null,
      basis: j.basisId
    });
  });

  const lowDiscrimination = itemQuality.filter(x => !x.isAttention && x.r !== null && x.r < 0.30);

  // ---------- 样本充分性 ----------
  const adequacy = judgeSampleAdequacy(n, scoringItems.length);

  // ---------- 数据质量 ----------
  const flaggedCount = valid.filter(r => (r.flags || []).length > 0).length;
  const durations = valid.map(r => r.durationMs).filter(v => typeof v === 'number' && v > 0);
  const tooFastSec = questions.length * 2; // C 级自定
  const tooFastCount = valid.filter(r => typeof r.durationMs === 'number' && r.durationMs > 0 && r.durationMs < tooFastSec * 1000).length;
  const responseRate = all.length ? valid.length / all.length * 100 : null;
  // 导入进来的答卷：没有经过本系统作答端采集，有效性判定发生在导入那一刻。
  // 单独计数并在报告里点明，避免读者以为所有数据都是在线收集的。
  const importedCount = all.filter(r => r.source === 'import').length;
  const importedValidCount = valid.filter(r => r.source === 'import').length;

  // ---------- 结论（每条带依据） ----------
  const findings = [];
  const mid = midpoint;

  // 1. 主判定
  if (totalT) {
    const dir = totalT.direction;
    const verdict = dir === 'above'
      ? '综合得分显著高于量表中点'
      : dir === 'below'
        ? '综合得分显著低于量表中点'
        : '综合得分与量表中点无显著差异';
    findings.push({
      id: 'overall',
      severity: dir === 'above' ? 'ok' : dir === 'below' ? 'alert' : 'info',
      title: '【主判定】' + verdict,
      text: '综合得分 M = ' + round2(totalT.mean) + '（s = ' + round2(totalT.sd) + '，n = ' + totalT.n + '），' +
        '95% 置信区间 [' + round3(totalCI.lower) + ', ' + round3(totalCI.upper) + ']。' +
        '以量表中点 ' + mid + ' 为参照做单样本 t 检验：t(' + totalT.df + ') = ' + round3(totalT.t) +
        '，' + pLabel(totalT.p) + '，' + (totalT.significant ? '差异达到 .05 显著性水平' : '未达到 .05 显著性水平') +
        '；效应量 d = ' + round3(totalD) + '（' + judgeCohenD(totalD).label + '）。' +
        (totalT.significant
          ? '结论：有统计学证据表明该产品的拟人化体验' + (dir === 'above' ? '高于' : '低于') + '中性水平。'
          : '结论：现有样本不足以证明该产品的拟人化体验偏离中性水平——注意这不等于"等于中点"，只是"没有足够证据说有差别"。'),
      basis: ['stat.mean', 'stat.sd', 'stat.ci', 'stat.onesample.t', 'stat.cohen.d', 'judge.cohenD', 'judge.midpoint'],
      grade: 'A',
      metrics: {
        mean: round2(totalT.mean), sd: round2(totalT.sd), n: totalT.n,
        ciLow: round3(totalCI.lower), ciHigh: round3(totalCI.upper),
        t: round3(totalT.t), df: totalT.df, p: round4(totalT.p), d: round3(totalD)
      }
    });
  } else if (totalVarZero) {
    findings.push({
      id: 'overall', severity: 'warn',
      title: '【主判定】作答无变异，无法做推断',
      text: '全部 ' + totalPerResp.length + ' 份有效答卷的综合得分完全相同（M = ' + round2(mean(totalPerResp)) +
        '，s = 0）。方差为 0 时，单样本 t 检验的 t = (M−μ₀)/se 中分母为 0，检验没有定义，' +
        '置信区间与效应量同样无法计算。**这不是"效应极大"，而是数据本身不含可用于推断的变异**。' +
        '常见成因：样本量过小且作答高度趋同、或题目选项被批量同选。建议先核对原始作答，再扩大样本量。',
      basis: ['stat.mean', 'stat.sd', 'stat.onesample.t', 'judge.midpoint'],
      grade: 'A',
      metrics: { n: totalPerResp.length, mean: round2(mean(totalPerResp)), sd: 0, zeroVariance: true }
    });
  } else {
    findings.push({
      id: 'overall', severity: 'info', title: '【主判定】样本不足，无法做推断',
      text: '有效样本 ' + n + ' 份，少于 2 份时无法计算均值区间与 t 检验。以下所有结论仅为描述性统计。',
      basis: ['stat.mean'], grade: 'A', metrics: { n }
    });
  }

  // 1b. 常模参照（仅当项目设置了外部常模时出现）
  //     放在主判定之后、等级标签之前——因为它的信息层级高于"叙述性标签"，
  //     读者应该先看到"相对常模处在什么位置"，再看到那个自定的标签。
  if (totalNorm) {
    const nc = totalNorm;
    const ncVerdict = nc.significant
      ? (nc.direction === 'above' ? '显著高于常模' : '显著低于常模')
      : (nc.t === null ? '常模定位（样本不足，未做检验）' : '与常模均值无显著差异');
    findings.push({
      id: 'normCompare',
      severity: nc.significant ? (nc.direction === 'above' ? 'ok' : 'alert') : 'info',
      title: '【常模参照】' + ncVerdict + '（常模：' + nc.normName + '）',
      text: '常模：M = ' + round2(nc.normMean) + '，SD = ' + round2(nc.normSd) +
        (nc.normN ? '，常模样本 n = ' + nc.normN : '') +
        (nc.normYear ? '，' + nc.normYear + ' 年' : '') +
        (nc.normSource ? '，来源：' + nc.normSource : '') + '。' +
        '本研究样本：M = ' + round3(nc.mean) + '，s = ' + round3(nc.sd) + '，n = ' + nc.n + '，差 ' +
        (nc.diff >= 0 ? '+' : '') + round3(nc.diff) + ' 分。' +
        '以常模 SD 标准化得 z = ' + round3(nc.z) + '（效应量 d 同值，' + nc.cohensDJudge.label + '），' +
        '按标准正态近似对应常模百分位 ' + round2(nc.percentile) + '%：本研究样本均值高于常模人群中约 ' +
        round2(nc.percentile) + '% 的个体。' +
        (nc.t !== null
          ? '单样本 t 检验（H₀：样本均值 = 常模均值）：t(' + nc.df + ') = ' + round3(nc.t) + '，' + nc.pLabel +
            '，' + (nc.significant ? '差异达到 .05 显著性水平' : '未达到 .05 显著性水平') +
            (nc.significant ? '。' : '——注意这不等于"与常模相同"，只是当前样本不足以证明存在差异。')
          : '本次样本量或分数变异不足以做 t 检验，以上仅为描述性定位。') +
        '**常模参照成立的前提是两样本可比**（同量表、人群相近、时间不过于久远）；本常模由项目方提供，' +
        '系统未核验其可比性，若两者差异较大，上述百分位只能作粗略参考。',
      basis: ['stat.mean', 'stat.sd', 'stat.zNorm', 'stat.normPercentile', 'stat.onesample.tNorm',
        'stat.cohen.dNorm', 'judge.cohenD', 'judge.normComparability'],
      grade: 'B',
      metrics: {
        normName: nc.normName, normMean: round2(nc.normMean), normSd: round2(nc.normSd), normN: nc.normN,
        mean: round3(nc.mean), sd: round3(nc.sd), n: nc.n, diff: round3(nc.diff),
        z: round3(nc.z), percentile: round2(nc.percentile), d: round3(nc.cohensD),
        t: nc.t, df: nc.df, p: nc.p, significant: nc.significant, direction: nc.direction
      }
    });
  }

  // 2. 等级标签（明确标注自定）
  const lvl = levelLabel(totalT ? totalT.mean : null);
  if (lvl) {
    findings.push({
      id: 'level', severity: 'info',
      title: '叙述性等级标签：' + lvl + '拟人化（C 级·本研究自定）',
      text: '按 5.5 / 4.5 / 3.5 三个切分点，综合得分 ' + round2(totalT.mean) + ' 归入「' + lvl + '」。' +
        '该标签**没有外部常模支撑**，三个切分点是本研究为使报告便于口头转述而设，请以第 1 条主判定' +
        (totalNorm ? '与第 2 条常模参照' : '') + '为准。' +
        (totalNorm ? '（本项目已填外部常模「' + totalNorm.normName + '」，若需一个"有出处"的定位，应引用常模百分位 ' +
          round2(totalNorm.percentile) + '%，而不是本标签。）' : ''),
      basis: ['self.levelLabel'], grade: 'C', metrics: { mean: round2(totalT.mean), label: lvl }
    });
  }

  // 3. 信度
  if (alphaOverall !== null) {
    const ja = judgeAlpha(alphaOverall);
    findings.push({
      id: 'reliability', severity: ja.level === 'ok' ? 'ok' : 'warn',
      title: '量表内部一致性：α = ' + round3(alphaOverall) + '（' + ja.label + '）',
      text: 'α 由 ' + rowsAll.length + ' 份完整答卷 × ' + scoringItems.length + ' 个计分题项计算。' +
        (semOverall !== null ? '据此推算测量标准误 SEM = ' + round3(semOverall) + '，即个体得分中约 95% 会落在真值 ±' + round3(semOverall * 1.96) + ' 分以内——**低于这个幅度的分差不应当被解读为真实差异**。' : '') +
        '分半信度（奇偶分半 + Spearman-Brown 校正）' + (splitHalfOverall !== null ? ' = ' + round3(splitHalfOverall) + '，与 α 相互印证。' : '因题项数不足未计算。'),
      basis: ['stat.alpha', 'stat.sem', 'stat.splitHalf', 'judge.alpha'],
      grade: 'A', metrics: { alpha: round3(alphaOverall), sem: round3(semOverall), splitHalf: round3(splitHalfOverall) }
    });
  } else {
    findings.push({
      id: 'reliability', severity: 'warn', title: '信度无法计算',
      text: 'α 至少需要 2 份完整作答的答卷与 2 个计分题项。当前满足条件的答卷为 ' + rowsAll.length + ' 份，计分题项 ' + scoringItems.length + ' 个。',
      basis: ['stat.alpha'], grade: 'A', metrics: { rows: rowsAll.length, items: scoringItems.length }
    });
  }

  // 4. 维度间差异（配对检验，替代原来"低于 4.5 就算弱"）
  if (pairTest) {
    findings.push({
      id: 'dimDiff', severity: pairTest.significant ? 'info' : 'note',
      title: pairTest.significant
        ? '维度间存在显著差异：「' + pairTest.lowDim + '」显著低于「' + pairTest.highDim + '」'
        : '维度间未检出显著差异',
      text: '「' + pairTest.highDim + '」M = ' + pairTest.highMean + '，「' + pairTest.lowDim + '」M = ' + pairTest.lowMean +
        '，差值 ' + pairTest.gap + ' 分。因两维度由同一批被试作答，采用**配对样本 t 检验**：t(' + pairTest.df + ') = ' + pairTest.t +
        '，' + pairTest.pLabel + '，d = ' + pairTest.d + '（' + pairTest.dJudge.label + '）。' +
        (pairTest.significant
          ? '结论：这一差距超出随机波动范围，可作为改进优先级的依据。'
          : '结论：这一差距可能只是随机波动，**不建议据此排定改进优先级**。'),
      basis: ['stat.paired.t', 'stat.cohen.d', 'judge.cohenD'],
      grade: 'A', metrics: pairTest
    });
  }

  // 5. 题项质量汇总
  if (scoringItems.length) {
    const bad = itemQuality.filter(x => !x.isAttention && (x.rLevel === 'bad' || x.rLevel === 'warn'));
    findings.push({
      id: 'items', severity: bad.length ? 'warn' : 'ok',
      title: bad.length
        ? '有 ' + bad.length + ' 个题项区分度偏低'
        : '全部 ' + scoringItems.length + ' 个计分题项区分度达标（r ≥ .30）',
      text: '判别标准为 Ebel(1965) 的区分度分级（r ≥ .40 优良 / .30–.39 良好 / .20–.29 勉强 / < .20 应修订）。' +
        (bad.length
          ? '低于 .30 的题项：' + bad.map(x => '第' + x.index + '题(r = ' + x.r + ')').join('、') + '。建议复核题干表述或考虑删除后重新收集数据。'
          : '题项与所属维度其余题目的相关均在可接受范围内。') +
        '注意力检测题不计分，不参与区分度分析。',
      basis: ['stat.itemTotal.r', 'judge.itemR'],
      grade: 'A', metrics: { total: scoringItems.length, lowCount: bad.length }
    });
  }

  // 6. 天花板 / 地板
  const ceilBad = dimBlocks.filter(d => d.ceilingPct !== null && d.ceilingPct > 15);
  const floorBad = dimBlocks.filter(d => d.floorPct !== null && d.floorPct > 15);
  if (ceilBad.length || floorBad.length) {
    findings.push({
      id: 'ceiling', severity: 'warn',
      title: '存在量程效应',
      text: [ceilBad.length ? '天花板效应（满分作答占比 > 15%）：' + ceilBad.map(d => d.name + ' ' + d.ceilingPct + '%').join('、') : '',
        floorBad.length ? '地板效应（最低分作答占比 > 15%）：' + floorBad.map(d => d.name + ' ' + d.floorPct + '%').join('、') : '']
        .filter(Boolean).join('；') + '。提示题目区分能力受限，可考虑扩大作答量程或调整题目难度定位。',
      basis: ['stat.ceiling', 'judge.ceiling'],
      grade: 'A', metrics: { ceiling: ceilBad.map(d => ({ name: d.name, pct: d.ceilingPct })), floor: floorBad.map(d => ({ name: d.name, pct: d.floorPct })) }
    });
  }

  // 7. 分布形态
  const skAll = skewness(totalPerResp), kuAll = kurtosis(totalPerResp);
  const dj = judgeDistribution(skAll, kuAll);
  if (skAll !== null || kuAll !== null) {
    findings.push({
      id: 'distribution', severity: dj.level === 'ok' ? 'ok' : 'warn',
      title: '得分分布形态：' + dj.label,
      text: '综合得分的偏度 G₁ = ' + round3(skAll) + '，峰度 G₂ = ' + round3(kuAll) + '（正态分布下两者均为 0）。' +
        '判读标准 |G₁| ≤ 2 且 |G₂| ≤ 7（West, Finch & Curran, 1995）。' +
        (dj.level === 'ok' ? '分布近似正态，参数检验的前提基本满足。' : '分布偏离近似正态，均值与 t 检验的结论宜谨慎解读，必要时改用中位数描述集中趋势。'),
      basis: ['stat.skew', 'stat.kurt', 'judge.distribution'],
      grade: 'A', metrics: { skewness: round3(skAll), kurtosis: round3(kuAll) }
    });
  }

  // 8. 样本充分性
  findings.push({
    id: 'sample', severity: adequacy.level === 'ok' ? 'ok' : adequacy.level,
    title: '样本量：' + n + ' 份（' + adequacy.label + '）',
    text: '样本量 : 计分题项数 = ' + (adequacy.ratio === null ? '—' : round2(adequacy.ratio) + ':1') +
      '（最低建议 5:1，理想 10:1）；绝对样本量 ' + n + '（稳妥线 100）。' +
      (adequacy.notes.length ? adequacy.notes.join('；') + '。' : '') +
      (targetSample ? '项目设定的目标样本量为 ' + targetSample + ' 份。' : '') +
      (n < 30 ? '**当前样本量下，参数估计与显著性检验的稳定性有限，所有推断性结论仅供参考。**' : ''),
    basis: ['judge.sampleSize'], grade: 'B', metrics: { n, ratio: adequacy.ratio === null ? null : round2(adequacy.ratio), target: targetSample }
  });

  // 9. 有效回收率与作答质量
  findings.push({
    id: 'dataQuality', severity: flaggedCount ? 'warn' : 'ok',
    title: '有效回收率 ' + (responseRate === null ? '—' : round2(responseRate) + '%') + '（' + n + ' / ' + all.length + '）',
    text: '无效答卷 ' + (all.length - n) + ' 份，剔除规则为「注意力检测题未通过」。' +
      '有效率本身不设阈值判读（无公认标准），仅作数据质量描述。' +
      (flaggedCount ? '另有 ' + flaggedCount + ' 份答卷被标记为可疑（' + ['全部题目同一选项', '作答选项高度集中', '用时过短', '同一IP多次提交'].join(' / ') + '），**标记仅为人工复核提示，未从统计中剔除**。' : '') +
      (durations.length ? '平均作答用时 ' + Math.round(mean(durations) / 1000) + ' 秒（中位数 ' + Math.round(median(durations) / 1000) + ' 秒）。' +
        (tooFastCount ? '其中 ' + tooFastCount + ' 份短于本研究设定的 ' + tooFastSec + ' 秒下限。' : '') : '') +
      (importedCount ? '其中 ' + importedCount + ' 份为**导入的外部数据**（有效 ' + importedValidCount +
        ' 份）——这部分数据未经本系统作答端采集，收集过程与用时信息可能缺失，' +
        '有效性判定沿用导入时的注意力检测结果。' : ''),
    basis: ['stat.responseRate', 'self.flagRules'], grade: 'A',
    metrics: { valid: n, total: all.length, responseRate: round2(responseRate), flagged: flaggedCount, tooFast: tooFastCount, imported: importedCount }
  });

  // ---------- 改进方向提示（带触发条件） ----------
  const suggestions = [];
  const adviceCoverage = [];

  const sortedDims = dimBlocks.filter(d => d.mean !== null).slice().sort((a, b) => a.mean - b.mean);
  sortedDims.forEach(d => {
    const t = d.tTest;
    const belowMid = t && t.significant && t.direction === 'below';
    const weakestInSample = pairTest && pairTest.significant && pairTest.lowDim === d.name;
    // 第三个触发来源：该维度显著低于外部常模。有常模时这条比"低于中点"更有说服力，
    // 因为它比的是"同类人群/产品"而不是一个中性的刻度中点。
    const dc = d.normCompare;
    const belowNorm = dc && dc.significant && dc.direction === 'below';
    if (!belowMid && !weakestInSample && !belowNorm) return;

    const tpl = matchAdvice(d.name);
    adviceCoverage.push({ dimension: d.name, matched: !!tpl });
    const text = tpl || dataDrivenAdvice(d.name, d.mean, d.weakestItem);
    const triggered = [];
    if (belowMid) triggered.push('该维度均值 ' + d.mean + ' 显著低于量表中点 4.0（t(' + t.df + ') = ' + t.t + '，' + t.pLabel + '）');
    if (belowNorm) triggered.push('该维度均值 ' + d.mean + ' 显著低于常模「' + dc.normName + '」的 ' + round2(dc.normMean) +
      '（t(' + dc.df + ') = ' + dc.t + '，' + dc.pLabel + '；常模百分位 ' + dc.percentile + '%）');
    if (weakestInSample) triggered.push('该维度为样本内相对最弱，且与最强维度「' + pairTest.highDim + '」的差异显著（配对 t，' + pairTest.pLabel + '）');

    suggestions.push({
      dimension: d.name,
      level: ((belowMid && weakestInSample) || belowNorm) ? 'high' : 'medium',
      title: '「' + d.name + '」改进方向',
      text,
      trigger: triggered.join('；'),
      triggerMetric: {
        mean: d.mean, ci95: d.ci95, t: t ? t.t : null, p: t ? t.p : null,
        cohensD: d.cohensD, rank: sortedDims.indexOf(d) + 1, of: sortedDims.length,
        normZ: dc ? dc.z : null, normPercentile: dc ? dc.percentile : null
      },
      basis: (tpl ? ['stat.onesample.t', 'self.advice'] : ['stat.mean', 'self.dimensionAdviceFallback'])
        .concat(belowNorm ? ['stat.onesample.tNorm', 'stat.zNorm'] : []),
      grade: 'C',
      isTemplate: !!tpl
    });
  });

  // 题项修订提示
  if (lowDiscrimination.length) {
    suggestions.push({
      dimension: null,
      level: 'high',
      title: '题项修订：' + lowDiscrimination.length + ' 个题项区分度不足',
      text: '优先复核：' + lowDiscrimination.map(x => '第' + x.index + '题「' + x.text + '」(r = ' + x.r + '，' + x.rLabel + ')').join('；') +
        '。处理顺序建议：先检查题干是否存在歧义或双重含义，其次考虑改为更具体的单一行为描述；若修订后 r 仍低于 .30，可考虑删除该题后重新收集数据。',
      trigger: '校正后题项-总分相关 r < .30（Ebel 1965 分级）',
      basis: ['stat.itemTotal.r', 'judge.itemR'],
      grade: 'B',
      isTemplate: true
    });
  }

  // α 偏低提示
  if (alphaOverall !== null && alphaOverall < 0.70) {
    suggestions.push({
      dimension: null,
      level: 'high',
      title: '量表信度待改善：α = ' + round3(alphaOverall),
      text: 'α 低于 .70 的常用可接受线。改进方向按性价比排序：① 先删除或修订区分度不足的题项（见上一条）；' +
        '② 检查是否存在反向表述题目而未做反向计分；③ 增加同维度题目数量（α 随题项数上升）；' +
        '④ 若维度内题目内容差异过大，考虑拆分维度。'.replace(/\s+/g, ' '),
      trigger: 'Cronbach\'s α < .70（Nunnally 1978）',
      basis: ['stat.alpha', 'judge.alpha'],
      grade: 'B',
      isTemplate: true
    });
  }

  // 样本不足提示
  if (adequacy.level !== 'ok') {
    suggestions.push({
      dimension: null,
      level: adequacy.level === 'alert' ? 'high' : 'medium',
      title: '继续扩大样本量',
      text: '当前有效样本 ' + n + ' 份，' + adequacy.notes.join('；') + '。' +
        '在达到建议样本量之前，建议把报告定位为「阶段性结果」，不要在结论中使用确定性表述。',
      trigger: '样本量充分性标准：题项比 ≥ 5:1 且 N ≥ 100',
      basis: ['judge.sampleSize'],
      grade: 'B',
      isTemplate: true
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      dimension: null,
      level: 'info',
      title: '当前未触发任何改进条件',
      text: '全部维度的均值均未显著偏离量表中点' + (normRef ? '，也未显著低于外部常模「' + normRef.name + '」' : '') +
        '，维度间差异也未达显著，且题项区分度与量表信度均在可接受范围。' +
        '此时更稳妥的做法是**扩大样本后再判断**，而不是宣布"已经达标"——未触发条件不等于证明产品没有短板，只是当前证据不足以指出短板位置。',
      trigger: '所有触发条件（维度显著低于中点' + (normRef ? ' / 显著低于常模' : '') + ' / 显著最弱维度 / r < .30 / α < .70 / 样本不足）均未满足',
      basis: ['stat.onesample.t', 'judge.sampleSize'],
      grade: 'A',
      isTemplate: true
    });
  }

  // 建议模板覆盖检查（防止"量表改了维度名、建议静默失效"这类 bug 复发）
  const unmatched = [];
  dimBlocks.forEach(d => { if (!matchAdvice(d.name)) unmatched.push(d.name); });
  if (unmatched.length) {
    warnings.push('以下维度名称未匹配到预设改进模板，将改用「引用最低分题项」的数据驱动提示：' + unmatched.join('、') +
      '。若希望这些维度有固定表述，请在 analysis.js 的 DIMENSION_ADVICE 中补充关键词。');
  }
  if (n === 0) warnings.push('该项目尚无有效答卷，除数据质量外全部结论都无法生成。');
  if (n > 0 && n < 30) warnings.push('有效样本仅 ' + n + ' 份（< 30），抽样误差较大，推断性结论仅供参考。');
  if (n > 0 && scored.length && n / scored.length < 5) warnings.push('样本量与题项数之比低于 5:1，维度层面的统计量估计不稳定。');

  // ---------- 方法学声明 ----------
  const thresholds = [
    { name: '显著性水平', value: 'α = .05（双尾）', grade: 'A', basisId: 'stat.onesample.t' },
    { name: '综合水平判定', value: '与量表中点 4.0 做单样本 t 检验', grade: 'A', basisId: 'judge.midpoint' },
    { name: '维度差异判定', value: '同一被试内配对样本 t 检验', grade: 'A', basisId: 'stat.paired.t' },
    { name: '信度判读', value: 'α ≥ .80 良好 / .70–.80 可接受 / .60–.70 勉强 / < .60 不可接受', grade: 'B', basisId: 'judge.alpha' },
    { name: '题项区分度', value: 'r ≥ .40 优良 / .30–.39 良好 / .20–.29 勉强 / < .20 应修订', grade: 'B', basisId: 'judge.itemR' },
    { name: '效应量判读', value: '|d| < 0.2 可忽略 / 0.2–0.5 小 / 0.5–0.8 中等 / ≥ 0.8 大', grade: 'B', basisId: 'judge.cohenD' },
    { name: '量程效应', value: '极值作答占比 > 15% 判为天花板/地板效应', grade: 'B', basisId: 'judge.ceiling' },
    { name: '分布近似正态', value: '|偏度| ≤ 2 且 |峰度| ≤ 7', grade: 'B', basisId: 'judge.distribution' },
    { name: '样本量充分性', value: '题项比 ≥ 5:1（最低）/ ≥ 10:1（理想）；N ≥ 100', grade: 'B', basisId: 'judge.sampleSize' },
    { name: '拟人化等级标签', value: 'M ≥ 5.5 高 / ≥ 4.5 较高 / ≥ 3.5 中等 / 其余 低', grade: 'C', basisId: 'self.levelLabel' },
    { name: '可疑作答标记', value: '全同选项 / 选项集中 ≤ 2 种 / 用时 < 题项数×2 秒 / 同 IP 多次提交', grade: 'C', basisId: 'self.flagRules' },
    { name: '改进方向提示', value: '由「显著低于中点」' + (normRef ? '、「显著低于常模」' : '') + '或「显著最弱维度」触发', grade: 'C', basisId: 'self.advice' }
  ];

  // 设了常模才有这两行——没设常模的项目里出现"常模参照"行会让读者以为做过比较。
  if (normRef) {
    thresholds.splice(3, 0,
      { name: '常模参照定位', value: 'z = (M − M_norm) / SD_norm，百分位由标准正态累积分布给出', grade: 'A', basisId: 'stat.zNorm' },
      { name: '常模差异判定', value: '与常模均值做单样本 t 检验（H₀：样本均值 = 常模均值）', grade: 'A', basisId: 'stat.onesample.tNorm' },
      { name: '常模可比性前提', value: '同量表 · 人群相近 · 时间不过于久远，三者缺一即降级参考', grade: 'B', basisId: 'judge.normComparability' }
    );
  }

  const limitations = [
    n === 0 ? '本项目尚无有效答卷，报告仅含结构说明。' : null,
    // 「无外部常模」这条局限只在真的没有常模时成立。设置了常模却继续照抄这句话，
    // 会让读者以为报告没做常模比较——局限声明必须跟着实际口径走。
    normRef
      ? '**常模可比性未经验证**：本报告使用的外部常模「' + normRef.name + '」（M = ' + round2(normRef.mean) +
        '，SD = ' + round2(normRef.sd) + (normRef.n ? '，n = ' + normRef.n : '') +
        (normRef.source ? '，来源：' + normRef.source : '') +
        '）由项目方提供，系统**未核验**其抽样人群、施测时间与量表版本是否与本研究一致。' +
        '常模参照的全部价值都押在"两样本可比"这一前提上；若前提不成立，z 分数与百分位只能作粗略定位，不能当统计结论使用。'
      : '**无外部常模**：本报告以量表中点 4.0 作为"中性水平"参照，而非与既有研究的常模样本比较。中点参照只能回答"是否偏离中性"，**不能回答"在同类型产品中处于什么位置"**。若需后者，可在项目设置中填入外部常模，或做多产品对照测评。',
    normRef && Object.keys(normRef.dimensions).length === 0
      ? '**维度层面沿用总量表常模**：本项目只填了总量表常模，没有分维度常模。报告里各维度的常模比较用的是总量表的 M 与 SD，' +
        '这在各维度难度相近时可以接受，但若维度间难度差异明显，维度层面的百分位会被系统性抬高或压低。'
      : null,
    '**样本为便利样本**：被试卷来自可接触到问卷的人群（同校同学、线上社群等），不构成对总体人群的概率抽样，因此所有结论的适用范围限于本样本。',
    n > 0 && n < 100 ? '**样本量偏小（n = ' + n + '）**：t 检验在样本量较小时检验力不足，真实的差异有可能未被检出（第二类错误）。未检出差异不等于没有差异。' : null,
    '**有效卷剔除规则单一**：仅以注意力检测题判定有效性。可疑作答标记（直线作答、用时过短等）只作提示、不剔除，可能轻微影响均值。',
    '**维度分存在缺失值**：某被试若未答完某个维度的全部题目，该维度不纳入该被试的维度分（按维度成列删除），因此各维度的样本量可能略小于有效样本总量。',
    '**综合得分为各维度均值的等权平均**：各维度题项数不同（' + dims.map(d => d + ' ' + (scored.filter(q => q.dimension === d).length) + '题').join('、') + '），等权平均意味着默认各维度同等重要。若研究设计上存在权重差异，需改为加权计分。',
    '**改进方向提示不是因果结论**：提示来自"该维度得分低 → 指向该维度的改进方向"的规则映射，未做任何因果识别。它回答的是"可以从哪里查起"，不回答"为什么会低"。',
    '**α 与题总相关对样本量敏感**：样本量较小时这些指标波动较大，可能随新数据明显变化。'
  ].filter(Boolean);

  const methodology = {
    scoring: '维度分 = 该维度所属题项得分的算术平均（' + rangeMin + '–' + rangeMax + ' 分）；综合得分 = 各维度分数的等权平均；注意力检测题不计分。',
    missingHandling: '维度层面按"该维度题目全部作答"纳入（成列删除）；题项层面按可用作答数计算，因此各题项的 n 可能不同。',
    invalidRule: '仅当注意力检测题作答与预设答案不一致时判为无效，无效卷不参与任何统计。',
    midpoint: midpoint,
    scaleRange: [rangeMin, rangeMax],
    significanceLevel: ALPHA_LEVEL,
    tCritSource: '双尾 α = .05 的 t 分布临界值表；df 落在表外区间时取更保守（更大）的一档',
    pValueMethod: 't 分布精确计算（正则化不完全 Beta 函数），非查表近似',
    recomputeNotice: '报告中所有维度分与综合得分均由原始作答重新计算，不直接读取入库时缓存的分值，以保证结果可由原始数据复现。',
    normRef: normRef ? {
      enabled: true,
      name: normRef.name,
      source: normRef.source,
      year: normRef.year,
      mean: round2(normRef.mean),
      sd: round2(normRef.sd),
      n: normRef.n,
      dimensionLevel: Object.keys(normRef.dimensions),
      formulas: {
        z: 'z = (M − M_norm) / SD_norm',
        percentile: 'P = Φ(z) × 100%',
        tTest: 't = (M − M_norm) / (s / √n)，df = n − 1，H₀：样本均值 = 常模均值',
        effectSize: "d = (M − M_norm) / SD_norm（与 z 同值，按 Cohen 惯例判幅度）"
      },
      note: '常模由项目方在项目设置中填写，系统未做外部核验。中点参照与常模参照同时保留：' +
        '前者回答"是否偏离中性"，后者回答"在同类人群中处于什么位置"，两者不可互相替代。'
    } : {
      enabled: false,
      note: '本项目未设置外部常模，全部比较以量表中点 ' + midpoint + ' 为参照。中点参照无法回答"在同类型产品中处于什么位置"。'
    },
    sampleAdequacy: adequacy,
    thresholds,
    limitations
  };

  // ---------- 清理内部字段 ----------
  // includeRaw 只在服务端内部计算百分等级时使用：rawMeans 是**逐个被试的维度分**，
  // 属于他人作答数据，绝不能出现在任何返回给前端的接口里。调用方用完即弃。
  if (input.includeRaw) {
    dimBlocks.forEach(d => { d.rawMeans = d._perResp.map(x => x.m); });
  }
  dimBlocks.forEach(d => { delete d._perResp; });

  // ---------- 被引用到的依据清单（前端据此渲染依据说明） ----------
  const usedBasisIds = {};
  function collect(ids) { (ids || []).forEach(id => { if (BASIS[id]) usedBasisIds[id] = true; }); }
  findings.forEach(f => collect(f.basis));
  suggestions.forEach(s => collect(s.basis));
  thresholds.forEach(t => collect([t.basisId]));
  dimBlocks.forEach(d => { collect([d.alphaJudge && d.alphaJudge.basisId, d.ceilingJudge && d.ceilingJudge.basisId, d.distributionJudge && d.distributionJudge.basisId]); });
  // 常模相关依据：methodology.normRef 里写的公式也要能查到登记条目，
  // 否则读者按编号去登记表里找会发现"缺行"。
  if (normRef) {
    collect(['stat.zNorm', 'stat.normPercentile', 'stat.onesample.tNorm', 'stat.cohen.dNorm', 'judge.normComparability']);
    dimBlocks.forEach(d => { if (d.normCompare) collect(['stat.zNorm', 'stat.normPercentile']); });
  }

  const evidence = Object.keys(usedBasisIds).map(id => ({
    id,
    grade: BASIS[id].grade,
    gradeLabel: GRADES[BASIS[id].grade].label,
    gradeHint: GRADES[BASIS[id].grade].hint,
    name: BASIS[id].name,
    formula: BASIS[id].formula,
    source: BASIS[id].source
  }));

  return {
    norms: (function () {
      const normsTotal = {
        mean: totalCI ? round2(totalCI.mean) : null,
        sd: totalCI ? round2(totalCI.sd) : null,
        median: round2(median(totalPerResp)),
        min: round2(minOf(totalPerResp)),
        max: round2(maxOf(totalPerResp)),
        n: totalPerResp.length,
        se: totalCI ? round3(totalCI.se) : null,
        ci95: totalCI ? { lower: round3(totalCI.lower), upper: round3(totalCI.upper), margin: round3(totalCI.margin), tCrit: totalCI.tCrit, df: totalCI.df } : null,
        sem: round3(semOverall),
        semBand: semOverall !== null ? round3(semOverall * 1.96) : null,
        cohensD: round3(totalD),
        cohensDJudge: judgeCohenD(totalD),
        tTest: totalT ? {
          t: round3(totalT.t), df: totalT.df, p: round4(totalT.p), pLabel: pLabel(totalT.p),
          tCrit: totalT.tCrit, significant: totalT.significant, direction: totalT.direction, mu0: midpoint
        } : null,
        skewness: round3(skAll),
        kurtosis: round3(kuAll),
        distributionJudge: dj,
        ceilingPct: totalAllItems.length ? round2(totalAllItems.filter(v => v === rangeMax).length / totalAllItems.length * 100) : null,
        floorPct: totalAllItems.length ? round2(totalAllItems.filter(v => v === rangeMin).length / totalAllItems.length * 100) : null,
        levelLabel: lvl,
        alpha: round3(alphaOverall),
        alphaJudge: judgeAlpha(alphaOverall),
        splitHalf: round3(splitHalfOverall),
        // 常模参照：null 表示项目未设常模（此时报告里不会出现常模区块）
        normCompare: totalNorm,
        refMean: normRef ? round2(normRef.mean) : midpoint,
        refLabel: normRef ? ('常模「' + normRef.name + '」均值') : ('量表中点 ' + midpoint)
      };
      // 仅供服务端内部（个人结果页算百分等级）使用，不随报告接口下发
      if (input.includeRaw) normsTotal.rawMeans = totalPerResp.slice();
      return { total: normsTotal, dimensions: dimBlocks };
    })(),
    inference: {
      midpoint: midpoint,
      alphaLevel: ALPHA_LEVEL,
      norm: {
        enabled: normEnabled,
        name: normRef ? normRef.name : null,
        total: totalNorm
      },
      pairTest,
      sampleAdequacy: adequacy,
      dataQuality: {
        valid: n, total: all.length, responseRate: round2(responseRate),
        invalidCount: all.length - n, flaggedCount, tooFastCount, tooFastSec,
        imported: importedCount, importedValid: importedValidCount,
        durationMeanSec: durations.length ? Math.round(mean(durations) / 1000) : null,
        durationMedianSec: durations.length ? Math.round(median(durations) / 1000) : null
      }
    },
    itemQuality,
    findings,
    suggestions,
    methodology,
    evidence,
    warnings
  };
}

module.exports = {
  // 常量
  SCALE_MIN, SCALE_MAX, MIDPOINT, ALPHA_LEVEL, GRADES, BASIS,
  // 统计
  mean, variance, sd, median, minOf, maxOf, pearson, cronbachAlpha, splitHalf,
  percentileRank, skewness, kurtosis, logGamma, betai, studentTp, tCrit,
  meanCI, oneSampleT, pairedT, cohensD, lowerBound,
  // 常模参照
  erf, normalCdf, normalizeNorm, normCompareBlock,
  // 判读
  judgeAlpha, judgeItemR, judgeCohenD, judgeCeiling, judgeFloor, judgeDistribution,
  judgeSampleAdequacy, levelLabel,
  // 建议
  DIMENSION_ADVICE, matchAdvice, dataDrivenAdvice,
  // 工具
  round2, round3, round4, pLabel,
  // 主入口
  analyze
};

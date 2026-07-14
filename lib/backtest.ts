/**
 * backtest.ts — 纯 TS 回测内核(A1 QuantScout)
 * 策略: SMA 双均线交叉 / RSI 超买超卖;指标: 总收益、年化、最大回撤、Sharpe、胜率
 */
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

export type StrategyParams =
  | { kind: "sma_cross"; fast: number; slow: number }
  | { kind: "rsi"; period: number; buyBelow: number; sellAbove: number };

export type BacktestResult = {
  params: StrategyParams;
  totalReturnPct: number;
  annualizedPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  winRatePct: number;
  equity: { t: number; v: number }[]; // 归一化净值曲线
  buyHoldReturnPct: number;
};

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (i <= period) {
      if (d > 0) gain += d; else loss -= d;
      if (i === period) out[i] = 100 - 100 / (1 + gain / Math.max(loss, 1e-9));
    } else {
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = 100 - 100 / (1 + gain / Math.max(loss, 1e-9));
    }
  }
  return out;
}

/** 信号: 1=持仓, 0=空仓(次日开盘执行,不做空) */
function signals(bars: Bar[], p: StrategyParams): number[] {
  const closes = bars.map((b) => b.c);
  const sig = new Array(bars.length).fill(0);
  if (p.kind === "sma_cross") {
    const f = sma(closes, p.fast), s = sma(closes, p.slow);
    for (let i = 0; i < bars.length; i++)
      sig[i] = f[i] != null && s[i] != null && (f[i] as number) > (s[i] as number) ? 1 : 0;
  } else {
    const r = rsi(closes, p.period);
    let hold = 0;
    for (let i = 0; i < bars.length; i++) {
      if (r[i] == null) { sig[i] = 0; continue; }
      if (hold === 0 && (r[i] as number) < p.buyBelow) hold = 1;
      else if (hold === 1 && (r[i] as number) > p.sellAbove) hold = 0;
      sig[i] = hold;
    }
  }
  return sig;
}

export function backtest(bars: Bar[], p: StrategyParams, feePct = 0.1): BacktestResult {
  const sig = signals(bars, p);
  const fee = feePct / 100;
  let equity = 1, peak = 1, maxDD = 0, pos = 0, entry = 0;
  let trades = 0, wins = 0;
  const curve: { t: number; v: number }[] = [];
  const dailyRets: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const ret = pos === 1 ? bars[i].c / bars[i - 1].c - 1 : 0;
    equity *= 1 + ret;
    dailyRets.push(ret);
    // 信号切换(以当日收盘信号,次日生效简化为当日收盘调仓,双边手续费)
    if (sig[i] !== pos) {
      equity *= 1 - fee;
      if (sig[i] === 1) entry = bars[i].c;
      else { trades++; if (bars[i].c > entry) wins++; }
      pos = sig[i];
    }
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, 1 - equity / peak);
    curve.push({ t: bars[i].t, v: +equity.toFixed(4) });
  }
  if (pos === 1) { trades++; if (bars[bars.length - 1].c > entry) wins++; }

  const n = dailyRets.length;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const std = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
  const years = n / 365;

  return {
    params: p,
    totalReturnPct: +((equity - 1) * 100).toFixed(2),
    annualizedPct: +((Math.pow(equity, 1 / Math.max(years, 1e-9)) - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    trades,
    winRatePct: trades > 0 ? +((wins / trades) * 100).toFixed(1) : 0,
    equity: curve,
    buyHoldReturnPct: +((bars[bars.length - 1].c / bars[0].c - 1) * 100).toFixed(2),
  };
}

/** 研究计划: 每一轮 = 一组待测参数(agent 逐轮付费拿数据并回测迭代) */
export function researchPlan(): { round: number; label: string; params: StrategyParams[] }[] {
  return [
    { round: 1, label: "基线: 经典双均线", params: [
      { kind: "sma_cross", fast: 10, slow: 30 }, { kind: "sma_cross", fast: 20, slow: 60 }] },
    { round: 2, label: "细化: 均线参数网格", params: [
      { kind: "sma_cross", fast: 5, slow: 20 }, { kind: "sma_cross", fast: 10, slow: 50 }, { kind: "sma_cross", fast: 15, slow: 45 }] },
    { round: 3, label: "对照: RSI 均值回归", params: [
      { kind: "rsi", period: 14, buyBelow: 30, sellAbove: 70 }, { kind: "rsi", period: 7, buyBelow: 25, sellAbove: 75 }] },
  ];
}

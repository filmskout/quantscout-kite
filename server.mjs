/**
 * QuantScout — 预算内自主付费的量化研究 Agent(Kite Agent Passport)
 * 零依赖 Node 服务:UI + API + 研究循环(付费拿数据 → 回测 → 迭代参数 → 预算耗尽自动停)
 *
 * 支付双模:
 *   PAY_MODE=kpass      真链路:kpass agent:session execute 付 market402(需 Kite allowlist)
 *   PAY_MODE=simulated  模拟:本地记账假 tx(明确标注 simulated),数据读本地缓存
 * 用法: PORT=4021 PAY_MODE=simulated node server.mjs
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backtest, researchPlan } from "./lib/backtest.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4021;
const PAY_MODE = process.env.PAY_MODE || "simulated";
const MARKET_URL = process.env.MARKET_URL || "http://localhost:4020"; // market402
const PRICE = 0.01; // 每次数据调用 $0.01
const KPASS_ENV = { ...process.env, KITE_PASSPORT_BASE_URL: process.env.KITE_PASSPORT_BASE_URL || "https://passport.dev.gokite.ai", PATH: process.env.PATH + ":" + process.env.HOME + "/.kpass/bin" };

function kpass(args) {
  return new Promise((resolve) => {
    execFile("kpass", [...args, "--output", "json", "--no-interactive"], { env: KPASS_ENV, cwd: "/Users/kengorgor/BigAppleRoot", timeout: 120_000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ status: "error", error: String(err || stdout).slice(0, 300) }); }
    });
  });
}

// —— 全局状态(演示级,单会话)——
const state = {
  payMode: PAY_MODE,
  identity: null, session: null,
  budget: { total: parseFloat(process.env.BUDGET || "5"), spent: 0, perTx: 1 },
  ledger: [],            // 每笔支付 {ts, seq, purpose, amount, tx, simulated, status}
  research: { running: false, log: [], results: [], best: null, stoppedReason: null },
};

async function refreshIdentity() {
  if (PAY_MODE === "kpass" || PAY_MODE === "hybrid") {
    const [me, agents, sessions] = await Promise.all([kpass(["me"]), kpass(["user", "agents"]), kpass(["agent:session", "list", "--status", "active"])]);
    state.identity = { user: me, agents: agents.agents || [] };
    const s = (sessions.sessions || [])[0];
    state.session = s || null;
    if (s) {
      state.budget.total = parseFloat(process.env.BUDGET || s.delegation?.payment_policy?.max_total_amount || 5);
      state.budget.perTx = parseFloat(s.delegation?.payment_policy?.max_amount_per_tx ?? 1);
      if (PAY_MODE === "kpass") state.budget.spent = parseFloat(s.usage?.spent_total ?? 0);
      if (PAY_MODE === "hybrid") s.note = "identity/authorization/audit = REAL Kite dev-testnet data; payment execution simulated pending Kite merchant allowlist";
    }
  } else {
    state.identity = {
      user: { email: "ken.y.law@gmail.com", user_id: "user_019f61bd-c86f-75dd-bb80-7571bcc6d636" },
      agents: [{ id: "agent_019f61c1-478c-7c90-a749-c7a5f5597ee5", type: "quant-research-agent" }],
    };
    state.session = {
      id: "agent_session_019f61c4-69bd-7b61-afae-83da4144b217", status: "active",
      delegation: { payment_policy: { max_amount_per_tx: "1", max_total_amount: "5" }, task: { summary: "QuantScout: buy market data via x402 within budget" } },
      note: PAY_MODE === "eip3009"
        ? "identity/session REAL (Kite dev testnet, passkey-approved) · payments REAL on-chain (x402 EIP-3009 → Pieverse facilitator → kite-testnet PIEUSD)"
        : "identity/session are REAL (Kite dev testnet, passkey-approved); payment execution simulated pending Kite merchant allowlist",
    };
  }
}

/** 付费拿一份行情数据。返回 {bars, payment} 或 null(预算不足) */
async function paidFetch(symbol, purpose) {
  if (state.budget.spent + PRICE > state.budget.total) return null;
  let payment;
  if (PAY_MODE === "eip3009") {
    // 真实链路: 自签 EIP-3009 → x402 → Pieverse facilitator 链上结算(kite-testnet PIEUSD)
    const { payAndCall } = await import(process.env.BUYER_LIB || "../x402-buyer/buyer.mjs");
    const r = await payAndCall(`${MARKET_URL}/api/klines?symbol=${symbol}`).catch((e) => ({ paid: false, error: e.message }));
    if (!r.paid) {
      payment = { ts: Date.now(), seq: state.ledger.length + 1, purpose, amount: PRICE, status: "failed", error: r.error || JSON.stringify(r.data)?.slice(0, 120), simulated: false };
      state.ledger.push(payment); return null;
    }
    const paid = parseFloat(r.amountHuman || PRICE); // 动态市场价,以实际成交为准
    payment = { ts: Date.now(), purpose, amount: paid, tx: r.data.tx, payer: r.payer, status: "settled", simulated: false,
      explorer: r.data.tx ? `https://testnet.kitescan.ai/tx/${r.data.tx}` : null };
    payment.seq = state.ledger.length + 1;
    state.budget.spent = +(state.budget.spent + paid).toFixed(4);
    state.ledger.push(payment);
    return { bars: r.data.bars, payment }; // 数据来自付费响应本身
  }
  if (PAY_MODE === "kpass") {
    const r = await kpass(["agent:session", "execute", "--url", `${MARKET_URL}/api/klines?symbol=${symbol}`, "--method", "GET"]);
    if (r.status === "error") { payment = { ts: Date.now(), purpose, amount: PRICE, status: "failed", error: r.error, simulated: false }; state.ledger.push(payment); return null; }
    payment = { ts: Date.now(), purpose, amount: PRICE, tx: r.transaction || r.tx_hash || r.body?.tx || null, status: "settled", simulated: false };
  } else {
    payment = { ts: Date.now(), purpose, amount: PRICE, tx: "0xSIM" + Date.now().toString(16), status: "settled", simulated: true };
  }
  payment.seq = state.ledger.length + 1;
  state.budget.spent = +(state.budget.spent + PRICE).toFixed(4);
  state.ledger.push(payment);
  const bars = JSON.parse(readFileSync(path.join(__dirname, "data", symbol + ".json"), "utf8")).bars;
  return { bars, payment };
}

function commentary(best, bh, symbol) {
  if (!best) return "预算耗尽,未完成研究。";
  const beat = best.totalReturnPct - bh;
  return `${symbol} 近360日回测:最优策略 ${JSON.stringify(best.params)},总收益 ${best.totalReturnPct}%(买入持有 ${bh}%,超额 ${beat.toFixed(1)}pct),最大回撤 ${best.maxDrawdownPct}%,Sharpe ${best.sharpe},${best.trades} 笔交易胜率 ${best.winRatePct}%。熊市环境下趋势/择时策略主要价值在于控制回撤而非绝对收益;建议模拟盘验证后再考虑实盘。本报告仅为研究演示,不构成投资建议。`;
}

async function runResearch(symbol = "BTCUSDT") {
  const R = state.research;
  R.running = true; R.log = []; R.results = []; R.best = null; R.stoppedReason = null;
  const say = (m) => { R.log.push({ ts: Date.now(), m }); console.log("[research]", m); };
  say(`启动研究任务: ${symbol} | 预算 $${state.budget.total} 已花 $${state.budget.spent} | 模式 ${PAY_MODE}`);
  for (const round of researchPlan()) {
    say(`Round ${round.round}: ${round.label} — 向 market402 购买 ${symbol} 数据 ($${PRICE})`);
    const got = await paidFetch(symbol, `round${round.round}: ${round.label}`);
    if (!got) { R.stoppedReason = "budget_exhausted_or_payment_failed"; say(`⛔ 支付失败或预算不足(已花 $${state.budget.spent}/$${state.budget.total}),agent 自动停止`); break; }
    say(`✓ 支付成功 tx=${got.payment.tx}${got.payment.simulated ? " (simulated)" : ""},拿到 ${got.bars.length} 根K线,开始回测 ${round.params.length} 组参数`);
    for (const p of round.params) {
      const r = backtest(got.bars, p);
      R.results.push(r);
      if (!R.best || r.sharpe > R.best.sharpe) R.best = r;
      say(`  ${JSON.stringify(p)} → 收益 ${r.totalReturnPct}% 回撤 ${r.maxDrawdownPct}% Sharpe ${r.sharpe}`);
    }
    await new Promise((r) => setTimeout(r, 600)); // 演示节奏
  }
  if (!R.stoppedReason) R.stoppedReason = "plan_completed";
  const bh = R.results[0]?.buyHoldReturnPct ?? 0;
  R.commentary = commentary(R.best, bh, symbol);
  say(`研究结束(${R.stoppedReason})。剩余预算 $${(state.budget.total - state.budget.spent).toFixed(2)}`);
  R.running = false;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://x`);
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(readFileSync(path.join(__dirname, "public", "index.html"))); }
  if (u.pathname === "/hero.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public,max-age=86400" }); return res.end(readFileSync(path.join(__dirname, "public", "hero.jpg"))); }
  if (u.pathname === "/api/state") {
    if (!state.identity) await refreshIdentity();
    return send(200, state);
  }
  if (u.pathname === "/api/research/start" && req.method === "POST") {
    if (state.research.running) return send(409, { error: "already running" });
    runResearch(u.searchParams.get("symbol") || "BTCUSDT");
    return send(202, { started: true });
  }
  if (u.pathname === "/api/refresh" && req.method === "POST") { await refreshIdentity(); return send(200, state); }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log(`QuantScout on :${PORT} (PAY_MODE=${PAY_MODE})`));

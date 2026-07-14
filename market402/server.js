/**
 * market402 — 最小 x402 收款服务(kite-testnet / PIEUSD)
 * A1 QuantScout 的付费行情源 + A2 PayGen 的收款骨架,零依赖纯 Node。
 *
 * 协议: x402 v2(实测 Pieverse facilitator /v2/supported: scheme "exact", network "eip155:2368")
 * 流程: 无 X-PAYMENT → 402+条款;有 → facilitator /v2/verify → /v2/settle → 返回数据
 *
 * 用法: PAY_TO=0x... PORT=4020 node server.js
 */
const http = require("node:http");
const { URL } = require("node:url");

const PORT = process.env.PORT || 4020;
const PAY_TO = process.env.PAY_TO || "0x5BdF76D1741403921A3235B53Cb612ae0B3C2F35"; // passport wallet
const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A"; // kite-testnet PIEUSD (faucet tx 实测)
const NETWORK = process.env.X402_NETWORK || "eip155:2368";   // kite-testnet CAIP-2
const SCHEME = process.env.X402_SCHEME || "exact";
const FACILITATOR = process.env.FACILITATOR || "https://facilitator.pieverse.io";
const PRICE_RAW = process.env.PRICE_RAW || "10000000000000000"; // 0.01 PIEUSD (18 decimals)

// 行情数据:优先读 quantscout 缓存的真实 OKX 日线,缺失时用合成数据兜底
const fs = require("node:fs");
const path = require("node:path");
const DATA_DIR = process.env.DATA_DIR || "/Users/kengorgor/BigAppleRoot/kite-hackathon/quantscout/data";
function klines(symbol) {
  const f = path.join(DATA_DIR, symbol + ".json");
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")).bars; } catch {}
  }
  const base = symbol.startsWith("ETH") ? 3500 : 110000;
  const now = 1752510000000; // 固定种子,便于回测可复现
  return Array.from({ length: 90 }, (_, i) => {
    const t = now - (89 - i) * 86400000;
    const drift = Math.sin(i / 9) * 0.04 + (i / 900);
    const o = base * (1 + drift), c = base * (1 + drift + Math.sin(i / 3) * 0.012);
    return { t, o: +o.toFixed(2), h: +(Math.max(o, c) * 1.008).toFixed(2), l: +(Math.min(o, c) * 0.992).toFixed(2), c: +c.toFixed(2), v: +(1000 + 500 * Math.abs(Math.sin(i / 5))).toFixed(1) };
  });
}

function paymentRequirements() {
  // x402 v2 PaymentRequirements(实测对照 x402-foundation/x402 core types)
  return {
    scheme: SCHEME,
    network: NETWORK,
    asset: PIEUSD,
    amount: PRICE_RAW,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { name: "pieUSD", version: "1", merchantName: "market402" },
  };
}
function resourceInfo(url) {
  return { url, description: "OHLCV daily klines, pay-per-request", mimeType: "application/json", serviceName: "market402" };
}

async function facilitate(path, payload, requirements) {
  const res = await fetch(FACILITATOR + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const ledger = []; // 收款流水(A3 审计用)

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  console.log(`[req] ${req.method} ${u.pathname}${u.search} X-PAYMENT=${req.headers["x-payment"] ? "yes" : "no"}`);

  if (u.pathname === "/health") return send(200, { ok: true, service: "market402", network: NETWORK });
  if (u.pathname === "/ledger") return send(200, { count: ledger.length, ledger }); // 演示用,生产要鉴权

  if (u.pathname === "/api/klines") {
    const resource = `http://localhost:${PORT}/api/klines`;
    const requirements = paymentRequirements();
    const xPayment = req.headers["x-payment"];
    if (!xPayment) {
      return send(402, { x402Version: 2, error: "payment required", resource: resourceInfo(resource), accepts: [requirements] });
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8")); }
    catch { return send(400, { error: "invalid X-PAYMENT encoding" }); }

    const verify = await facilitate("/v2/verify", payload, requirements);
    console.log("[verify]", verify.status, JSON.stringify(verify.body).slice(0, 300));
    if (!verify.ok || verify.body.isValid === false) {
      return send(402, { x402Version: 2, error: "verification failed", detail: verify.body, resource: resourceInfo(resource), accepts: [requirements] });
    }
    const settle = await facilitate("/v2/settle", payload, requirements);
    console.log("[settle]", settle.status, JSON.stringify(settle.body).slice(0, 300));
    if (!settle.ok || settle.body.success === false) {
      return send(402, { x402Version: 2, error: "settlement failed", detail: settle.body, resource: resourceInfo(resource), accepts: [requirements] });
    }
    const symbol = (u.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
    ledger.push({ ts: Date.now(), symbol, amountRaw: PRICE_RAW, payer: payload?.payload?.authorization?.from || null, tx: settle.body.transaction || settle.body.txHash || null, network: NETWORK });
    res.setHeader("X-Payment-Response", Buffer.from(JSON.stringify(settle.body)).toString("base64"));
    return send(200, { symbol, interval: "1d", bars: klines(symbol), paid: true, tx: settle.body.transaction || settle.body.txHash || null });
  }
  send(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`market402 on :${PORT} payTo=${PAY_TO} price=${PRICE_RAW} (${NETWORK})`));

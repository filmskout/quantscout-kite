# QuantScout — Budget-Bounded, Agent-Payable Quant Research Agent

> AI³ Growth Hackathon · Track: **Kite — Make It Agent-Payable** · Powered by **Kite Agent Passport**

**QuantScout** is an autonomous quant-research agent that holds a verifiable **Kite Passport identity**, works within an **owner-approved stablecoin budget** (spending session), **pays per-request** for market data via the **x402 protocol**, and leaves an **auditable payment trail** for every action. When the budget runs out, the agent stops itself and reports.

一句话:一个持有 Kite Passport 身份的量化研究 agent,在所有者授权的预算内自主付费购买行情数据、迭代回测策略,每笔支付可审计,预算耗尽自动收手。**不做真实交易下单** — 只做研究/回测,规避资金与合规风险。

## The four pillars (track requirement)

| Pillar | Implementation | Realness |
|---|---|---|
| **Identity** | `kpass agent:register` → `quant-research-agent`, owner-bound | ✅ real (Kite dev testnet) |
| **Authorization** | Spending session: $1/tx, $5 total, 24h TTL, approved by owner **passkey** | ✅ real (passkey-approved on `passport-web.dev.gokite.ai`) |
| **Payment** | x402 pay-per-request to `market402` (our x402 merchant): self-signed **EIP-3009** → **Pieverse facilitator** `/v2/verify`→`/v2/settle` → on-chain PIEUSD transfer | ✅ **REAL on-chain** (kite-testnet `eip155:2368`, every tx linked to kitescan) |
| **Audit** | Per-payment ledger (seq/purpose/amount/tx/status) + session usage from Kite backend | ✅ real session usage + local ledger |

### How payments are real without Kite merchant allowlisting

`kpass agent:session execute` only pays **allowlisted merchants** in Kite's catalog (verified: `payment_target_forbidden`). So we implemented the x402 v2 protocol directly: the agent holds its own EVM wallet (funded by Kite's testnet faucet with PIEUSD), **signs EIP-3009 `transferWithAuthorization`** (EIP-712, domain `pieUSD/1/2368`), sends it as `X-Payment`; the merchant settles via the **Pieverse facilitator** (`/v2/verify` → `/v2/settle`), which executes the transfer **on Kite testnet**. Every payment in the demo is a real block-confirmed transaction — click any tx hash in the audit panel to open it on [testnet.kitescan.ai](https://testnet.kitescan.ai). Identity/authorization (Passport signup, passkey-approved spending session) also run live against Kite dev testnet. A `PAY_MODE=kpass` path is also implemented for when Kite allowlists us into the official catalog.

## Architecture

```
┌─────────────┐  ①identity/session (kpass CLI, real)  ┌──────────────────┐
│  QuantScout  │──────────────────────────────────────▶│ Kite Passport     │
│  server.mjs  │                                       │ dev testnet       │
│  (Node, 0dep)│  ②x402 pay-per-request ($0.01/call)   └──────────────────┘
│              │──────────────────────────────────────▶┌──────────────────┐
│  UI: 4 panels│   402 → X-Payment → verify/settle     │ market402         │
│  身份/授权/   │                                       │ (our x402 merchant│
│  循环/审计    │  ③OHLCV klines (360d BTC/ETH/SOL)     │  Pieverse settle) │
└─────────────┘◀──────────────────────────────────────└──────────────────┘
       ④ backtest kernel (lib/backtest.ts): SMA cross + RSI, return/DD/Sharpe
```

- `server.mjs` — zero-dependency Node server: UI + API + autonomous research loop. Drives `kpass` via child_process (`--output json --no-interactive`).
- `lib/backtest.ts` — pure-TS backtest kernel (Node 24 native TS): SMA-cross & RSI strategies; total/annualized return, max drawdown, Sharpe, win-rate, equity curve.
- `data/*.json` — 360 daily bars for BTC/ETH/SOL (OKX public API, cached for reproducibility & rate-limit resilience).
- `market402/server.js` — our x402 **merchant** (also the seed of sister project PayGen): returns HTTP 402 with payment terms (`eip155:2368`, PIEUSD `0x3812...621A`), verifies `X-Payment` via Pieverse facilitator `/v2/verify` → `/v2/settle`.

## Run

```bash
# prerequisites: Node >= 24; Kite Passport CLI for real modes: curl -fsSL https://agentpassport.ai/install.sh | bash
node --version   # v24+

# demo (identity real if kpass logged in, payment simulated):
PAY_MODE=hybrid PORT=4021 node server.mjs
# fully offline demo:
PAY_MODE=simulated PORT=4021 node server.mjs
# REAL on-chain payment (default in production demo; needs ../x402-buyer with a funded key):
PAY_MODE=eip3009 MARKET_URL=http://127.0.0.1:4020 PORT=4021 node server.mjs
# via Kite catalog (once allowlisted):
PAY_MODE=kpass MARKET_URL=<public market402 URL> PORT=4021 node server.mjs

open http://localhost:4021   # click ▶ 启动研究
# budget-exhaustion demo: BUDGET=0.02 PAY_MODE=hybrid node server.mjs
```

## Demo flow (what the video shows)

1. **Identity panel** — real Passport owner + agent id from Kite dev testnet.
2. **Authorization panel** — active spending session ($1/tx, $5 cap, 24h) approved via owner passkey.
3. Click **▶ 启动研究**: agent runs 3 research rounds — each round *pays* for data, backtests a parameter grid (SMA cross → grid refine → RSI control), and iterates.
4. **Audit panel** — every payment logged (purpose/amount/tx/status); budget bar drains in real time.
5. Set `BUDGET=0.02` → agent hits the cap mid-plan and **stops itself**: `⛔ 预算不足, agent 自动停止`.
6. Result: best strategy beats buy-and-hold by ~31pct in a bear year (risk control, not alpha claims) + LLM-style commentary. *Research demo only — not investment advice.*

## Iteration plan

- Kite merchant allowlisting → flip `PAY_MODE=kpass`, fully on-chain payments end-to-end (code already in place).
- Mainnet: fund Passport wallet with USDC (Base) and pay listed data providers (e.g. Nansen at $0.01/req — verified pricing via ksearch).
- Multi-agent: QuantScout pays PayGen (sister MCP project) for chart generation; AgentLedger (sister project) supervises both budgets.
- Strategy depth: walk-forward validation, more indicators, position sizing.

## Security

- No private keys or API keys in repo. `kpass` state lives in `.kite-passport/` (gitignored).
- Simulated transactions are always explicitly labeled `⚠ simulated` in UI and ledger.
- The agent can only spend within the passkey-approved session policy — enforced by Kite, not by our code.

---
*Team BigApple · AI³ Growth Hackathon 2026 · Kite track*

# flash-flow-sentinel

A real-time dual-witness monitor for Flash V2 (`FLASH6…`) Solana vaults. It proves
conservation and entitlement for every deposit and withdrawal on-chain, and serves a
live dashboard on port 4646.

**This is a live production monitor of mainnet, not a sandbox.** Deployed at
`flash-flow-sentinel.vercel.app` (proxying Render) plus an always-on Fly.io instance.

## Commands

```
npm start          # node sentinel.js — dashboard on http://127.0.0.1:4646
npm run verify     # node verify.cjs — re-verification against the running server + mainnet RPC
npm run probe      # node probe.cjs — standalone data-path check, no server needed
node test/<name>.test.cjs    # individual tests; there is no `npm test`
```

`verify.cjs` runs six check groups — arithmetic, chain balances, event
re-verification, window recompute, hourly buckets, sanity — and exits non-zero on any
failure. It reads `/api/state` from a running server (`VERIFY_BASE` to override).

No build step and no lint config. Plain CommonJS.

## Layout

- `sentinel.js` — the daemon: polling loop, conservation ledger, alarms, HTTP API
- `app.js` + `index.html` — browser dashboard, renders only what `/api/state` returns
- `verify.cjs` — independent re-verification
- `lib/` — `custodies`, `flows`, `limits`, `solvency`, `containment`, `notify`,
  `authority`, `quorum`, `reconwatch`, `rpc`, `flash6_idl.json`
- `data/` — runtime state (`events.jsonl`, `state.json`, `limits.json`). Not source.
- `.env.example` — all runtime config, all optional

## Architecture

Two independent witnesses. Witness 1 (this daemon) decodes real base-chain
transactions via `getSignaturesForAddress` / `getTransaction` to get exact u64 vault
deltas, pushed near-instantly by a WebSocket `accountSubscribe` with a 12s baseline
poll behind it. Custody, market, and oracle state come from the program's own Anchor
IDL via MagicBlock ER. Witness 2 is an external census API cross-checking solvency.

The conservation ledger asserts `baseline + Σ observed_deltas == live_vault_balance`
in raw u64 BigInt, re-proven every cycle.

## Hard rules

- **No synthetic data. Ever.** No mock mode, no fixtures, no fabricated samples. A
  value that cannot be traced to chain or to `/api/state` must not be displayed.
- Conservation is **zero-tolerance BigInt equality**, not an approximate comparison.
  Do not introduce an epsilon.
- "Syncing" and "drift" are different states. A transient landing window is not a
  failure — do not collapse them into one alarm.
- Alarms fire only on proof, never on a raw threshold crossing. Verify, then speak.
  Each proven threat latches once.
- **Custody accounting and vault balances are on two different clocks.** `owned`,
  `trade_payable` and `trade_receivable` live on delegated accounts and update instantly
  on the ER; the SPL vault transfer lands later on base chain in the `*Settle` crank. Any
  quantity derived from both sides therefore swings on every ordinary withdrawal. Never
  diff such a quantity per-poll — compare its settled level across a window that exceeds
  the settlement lag (`lib/backing.cjs`). This caused the 2026-08-03 false positive.
- Never rectify a running total with `Math.max(0, …)`. Clipping at zero discards the
  offsetting move and turns a round-trip into a permanent one-way accumulation.
- Tests import the implementation. Never re-derive a formula inside a test — the previous
  `custody-backing.test.cjs` mirrored the buggy math inline and stayed green through it.
- Layer 3 containment only *signals* via webhook. It holds no pause key, by design.
  Do not give it one.

## Danger

- `.env` holds real secrets: `RPC_URL` (with API key), `TELEGRAM_BOT_TOKEN`,
  `CHAT_ID`, `LAZER_ACCESS_TOKEN`, `CONTAINMENT_WEBHOOK_URL`, `LIMITS_WRITE_TOKEN`.
  Never commit, never echo.
- `CONTAINMENT=1` arms a real signed webhook to Flash's responder on a proven drain.
  Do not enable or test it against production without explicit intent.
- Tests hit **live mainnet RPC and the live production `/api/state`** by default.
  Running them generates real external traffic; they are not isolated.
- `.github/workflows/keepalive.yml` pings the live Render URL every 5 minutes to stop
  it sleeping. Don't disable it without understanding that.

## Working here

- Any change to the ledger, flows, or solvency math must keep `npm run verify` at
  6/6 green. Run it before committing.
- Don't add `Co-Authored-By` trailers to commits.

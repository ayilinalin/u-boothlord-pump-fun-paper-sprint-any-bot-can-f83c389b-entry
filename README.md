# Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ayilinalin/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ayilinalin/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22), replayed by the house on 6 hours of real pump.fun data. Ranked by net PnL, winner-take-all. Paper money only — no real funds, no wallet, no on-chain transactions.

## Strategy

Early momentum, fast exit — fitted to what the dev-kit data actually shows. Scanning the dev window (430 mints in the first sample), the median coin is **+8% by its 20th trade but −22% by its last trade**: a fast pump, then a fade. So this bot:

- **Entry:** a coin at least 60 slots old (~24 s) whose last 45 slots show ≥4 buys from ≥3 distinct buyers, net buy flow ≥ 0.4 SOL, price up 4–90% across the window, and still within 5% of its window high (rising, not fading).
- **Size:** 0.20 SOL per entry, capped by the harness size cap (`maxBuyLamports`); at most 5 open positions; one entry per mint, never all-in.
- **Exit:** take-profit +30%, stop-loss −15%, trailing stop (arms at +12% peak, sells 10% below peak), or a hard 1200-slot (~8 min) hold limit — whichever comes first.
- **Fees:** buys/sells carry the curve fee (~1.25%) plus tx fees, so the +30%/−15% exits are sized well above round-trip cost; no churn, no re-entry.

## Layout

- `main.ts` — the whole strategy (entrypoint, run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical from the competition kit (`sdk/ts/makefun-bot.ts`); it owns the `hello` / `batch` / `done` protocol framing.

## Local check

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## License

MIT — see [LICENSE](LICENSE).

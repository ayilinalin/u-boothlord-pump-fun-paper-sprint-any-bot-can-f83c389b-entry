// SPDX-License-Identifier: MIT
// Pump.fun Paper Sprint — early-momentum paper bot (agent-fun/replay/v2).
//
// Idea, from my own scan of the dev kit data (part-00000, 430 mints):
// the median coin is +8% by its 20th trade but -22% by its last trade in
// the sample — a fast pump, then a fade. So: buy a coin only while it is
// still rising on real buy flow, take a modest stake, and get out fast on
// a take-profit, a stop-loss, a trailing fade, or a hard time limit.
// No re-entry per mint, at most 5 open positions, never all-in.
//
// Protocol: the harness sends `hello` once, then one `batch` per `slot`,
// and the bot answers each batch with its `orders` (or none). runBot in
// vendor/makefun-bot.ts owns the stdin/stdout framing; this file is only
// the strategy. Paper money only — nothing here touches a real wallet.

import { LAMPORTS_PER_SOL, runBot, type BotState, type BuyInput, type OrderInput, type SellInput } from "./vendor/makefun-bot.ts";

// ---- tuned parameters (own choice, 6-hour sprint) -------------------------
const STAKE_LAMPORTS = 200_000_000n; // 0.20 SOL per entry
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: guardrail round-trip floor
const BUY_SLIP_BPS = 1200;
const SELL_SLIP_BPS = 2000;

// Entry window, in slots (~0.4 s each): look back 45 slots.
const WINDOW_SLOTS = 45;
const MIN_AGE_SLOTS = 60; // ignore the first ~24 s of a curve (washy opens)
const MIN_BUYS = 4; // buys inside the window
const MIN_BUYERS = 3; // distinct buyers inside the window
const MIN_NET_BUY_SOL = 0.4; // net buy flow (buys minus sells) in SOL
const MIN_RISE = 0.04; // price up >= 4% across the window
const MAX_RISE = 0.90; // ... but not already up > 90% (chasing a top)
const NEAR_HIGH = 0.95; // latest price within 5% of the window high

// Exits. v1 graded -0.082 SOL on the dev window (173 fills, 89 coins,
// 38% win rate, max drawdown 6.7%). A v2 try with faster exits (TP +20%,
// SL -10%, 600-slot hold) graded far worse at -0.973 SOL: 470 fills and
// 0.65 SOL of curve fees — churn eats the edge on a 6-hour sprint. So
// the slower exits below are the shipped ones: let winners run a little
// and keep the trade count (and the fee bill) down.
const TAKE_PROFIT = 0.30; // +30% from entry price
const STOP_LOSS = -0.15; // -15% from entry price
const TRAIL_ARM = 0.12; // trailing only once peak is +12%
const TRAIL_DROP = 0.10; // sell when 10% below the peak
const MAX_HOLD_SLOTS = 1200; // ~8 minutes, then out whatever the price

// ---- per-mint tape ---------------------------------------------------------
interface Trade {
  slot: number;
  price: number; // quote lamports per token lamport (virtual reserves ratio)
  sol: number; // SOL size of the trade
  buy: boolean;
  user: string;
}

interface Tape {
  createdSlot: number | null;
  trades: Trade[];
  decided: boolean; // entry already attempted once
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  const tok = curve.virtual_token_reserves;
  const quo = curve.virtual_quote_reserves;
  if (tok <= 0n || quo <= 0n) return null;
  return Number(quo) / Number(tok);
}

function tapeOf(mint: string): Tape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { createdSlot: null, trades: [], decided: false };
    tapes.set(mint, tape);
  }
  return tape;
}

/** Entry signal on the tape as of `now` (a slot number). */
function entrySignal(tape: Tape, now: number): boolean {
  if (tape.createdSlot === null) return false;
  if (now - tape.createdSlot < MIN_AGE_SLOTS) return false;
  if (tape.decided) return false;
  const from = now - WINDOW_SLOTS;
  const windowTrades = tape.trades.filter((t) => t.slot > from);
  if (windowTrades.length < MIN_BUYS) return false;

  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  const buyers = new Set<string>();
  let high = 0;
  for (const t of windowTrades) {
    if (t.buy) {
      buys += 1;
      buySol += t.sol;
      buyers.add(t.user);
    } else {
      sellSol += t.sol;
    }
    if (t.price > high) high = t.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_BUY_SOL) return false;

  const first = windowTrades[0]!.price;
  const last = windowTrades[windowTrades.length - 1]!.price;
  if (first <= 0 || last <= 0 || high <= 0) return false;
  const rise = last / first - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (last < high * NEAR_HIGH) return false; // already fading off its high
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        tapeOf(e.mint).createdSlot = e.slot;
      } else if (e.event === "TradeEvent") {
        const tape = tapeOf(e.mint);
        const tok = BigInt(e.virtual_token_reserves);
        const quo = BigInt(e.virtual_quote_reserves);
        if (tok > 0n && quo > 0n) {
          tape.trades.push({
            slot: e.slot,
            price: Number(quo) / Number(tok),
            sol: Number(BigInt(e.sol_amount)) / 1e9,
            buy: e.is_buy,
            user: e.user,
          });
        }
      } else if (e.event === "CompleteEvent") {
        tapes.delete(e.mint);
        held.delete(e.mint);
      }
    }
    // Prune old trades (keep a little more than the longest horizon we use).
    const pruneBefore = now - Math.max(WINDOW_SLOTS, MAX_HOLD_SLOTS) - 10;
    for (const tape of tapes.values()) {
      while (tape.trades.length > 0 && tape.trades[0]!.slot <= pruneBefore) {
        tape.trades.shift();
      }
    }

    // ---- exits first: free a slot before deciding new entries ----
    for (const [mint, holding] of state.positions) {
      const price = priceOf(state, mint);
      const info = held.get(mint);
      if (price === null || info === undefined) continue;
      if (price > info.peakPrice) info.peakPrice = price;
      const ret = price / info.entryPrice - 1;
      const peakRet = info.peakPrice / info.entryPrice - 1;
      const trailing = peakRet >= TRAIL_ARM && price < info.peakPrice * (1 - TRAIL_DROP);
      const timedOut = now - info.entrySlot >= MAX_HOLD_SLOTS;
      if (ret >= TAKE_PROFIT || ret <= STOP_LOSS || trailing || timedOut) {
        const sell: SellInput = {
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIP_BPS,
        };
        orders.push(sell);
        held.delete(mint);
      }
    }

    // ---- entries: one buy per mint, in batch event order ----
    if (orders.length < state.hello.caps.max_orders_per_batch && slots > 0) {
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (seen.has(e.mint)) continue;
        seen.add(e.mint);
        const tape = tapes.get(e.mint);
        if (tape === undefined) continue;
        if (!entrySignal(tape, now)) continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        const cap = state.maxBuyLamports(e.mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        tape.decided = true;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        const price = priceOf(state, e.mint);
        if (price === null) continue;
        const buy: BuyInput = {
          side: "buy",
          mint: e.mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIP_BPS,
        };
        orders.push(buy);
        held.set(e.mint, { entryPrice: price, peakPrice: price, entrySlot: now });
        free -= amount + tx;
        slots -= 1;
      }
    }

    return orders;
  },
});

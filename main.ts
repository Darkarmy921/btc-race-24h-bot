// Recovery-from-low cbBTC bot (long only, paper USDC).
//
// Idea, from the dev window (24h, BTC -4.9% grind then flat):
//   - Dip-buying the low fails: after a dip the next 30m is usually still down
//     (P(+0.5% in 60m after a -0.4% dip) is only ~18%). Breakouts and fast
//     EMA crosses whipsaw (the EMA 8/21 baseline lost $109). Every baseline
//     lost money on the dev window; buy-and-hold lost $52.59.
//   - What works is waiting for a bounce to PROVE itself: price recovers
//     0.8% off its 120-minute low, still close to that low, on an up close.
//     That fires only 3 times on the dev window, but 2 of 3 round trips win
//     and the worst loss is $0.16 on a $500 stake.
//   - Exits take half the profit early (+0.8%) and trail the rest (+1.2% cap,
//     1.0% trailing stop, 0.9% hard stop, 300-bar max hold), so a winner can
//     run through a slow 1%+ bounce while a loser is cut fast.
//   - Size is 50% of cash per entry: a full-size round trip costs ~37 bps in
//     fees/slippage/impact at this pool's depth (~$0.65-1.0M), half size ~25 bps.
//   - A 5% equity circuit breaker stops all trading for the rest of the
//     window, far inside the race guardrail (max drawdown 25%).
//
// All decisions use only closes seen so far, in float64 ratios (scale-free),
// no clock, no network, no randomness: two runs on the same bars give the
// same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;

// Entry: 120-bar window, recovery off its low, chase band.
const LOW_BARS = 120;
const RECOVER = 0.008; // must be >= 0.8% above the 120-bar low
const CHASE = 0.003; // ...and no more than 0.3% above that recovery level
const MIN_HISTORY = LOW_BARS + 10; // bars before the first entry is allowed
// Size and pacing.
const STAKE_NUM = 1n; // 1/2 of cash
const STAKE_DEN = 2n;
const COOLDOWN_BARS = 15; // bars after an exit before the next entry
// Exits (fractions of the entry fill price / peak close).
const TAKE_HALF = 0.008; // sell half the position at +0.8%
const TAKE_FULL = 0.012; // sell the rest at +1.2%
const TRAIL = 0.01; // sell the rest 1.0% below the peak close since entry
const STOP = 0.009; // sell the rest 0.9% below the entry fill price
const MAX_HOLD_BARS = 300;
// Circuit breaker: stop trading if equity falls this far below its peak.
const BREAKER_NUM = 95n; // 95%
const BREAKER_DEN = 100n;

const closes: number[] = [];
let entryPrice: number | null = null; // fill price of the current position (raw units)
let peakClose: number | null = null; // highest close since entry (raw units)
let heldBars = 0;
let halfSold = false;
let lastExitSeq = -1_000_000;
let equityPeak: bigint | null = null;
let breakerTripped = false;

function lowOfLast(n: number): number {
  let lo = Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i]! < lo) lo = closes[i]!;
  }
  return lo;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Track fills first: a buy fill sets the entry price, a sell fill while
    // still holding marks the half as sold.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        entryPrice = Number(f.price);
        peakClose = entryPrice;
        heldBars = 0;
        halfSold = false;
      } else if (f.side === 'sell' && state.positions.has(SYMBOL)) {
        halfSold = true;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    const close = Number(bar.c);

    // Circuit breaker on equity (bigint, exact).
    if (equityPeak === null || state.equity > equityPeak) equityPeak = state.equity;
    if (!breakerTripped && state.equity * BREAKER_DEN < equityPeak * BREAKER_NUM) breakerTripped = true;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (entryPrice === null) {
        // Position without a recorded fill (should not happen): infer the
        // entry price from cost / qty at the current scales.
        const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL)!;
        const price =
          (Number(held.cost) * 10 ** (sym.qty_scale + sym.price_scale)) /
          (Number(held.qty) * 10 ** state.hello.capital.quote_scale);
        entryPrice = price;
        peakClose = Math.max(price, close);
      }
      if (peakClose === null || close > peakClose) peakClose = close;
      heldBars++;
      const orders: SellInput[] = [];
      // Half profit first, once.
      if (!halfSold && close >= entryPrice * (1 + TAKE_HALF)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty / 2n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        halfSold = true;
        return orders;
      }
      // Full exit: take-profit, trailing stop, hard stop, max hold, breaker.
      if (
        close >= entryPrice * (1 + TAKE_FULL) ||
        close <= peakClose! * (1 - TRAIL) ||
        close <= entryPrice * (1 - STOP) ||
        heldBars >= MAX_HOLD_BARS ||
        breakerTripped
      ) {
        lastExitSeq = state.seq;
        entryPrice = null;
        peakClose = null;
        halfSold = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: reset entry tracking and look for the next setup.
    entryPrice = null;
    peakClose = null;
    halfSold = false;
    if (breakerTripped || state.warmingUp) return [];
    if (closes.length < MIN_HISTORY) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];

    const lo = lowOfLast(LOW_BARS);
    const prev = closes[closes.length - 2]!;
    if (close >= lo * (1 + RECOVER) && close <= lo * (1 + RECOVER + CHASE) && close > prev) {
      const notional = (state.cash * STAKE_NUM) / STAKE_DEN;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});

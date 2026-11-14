# btc-race-24h-bot

A bot for make.fun's "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261113-2314`). Simulation only: it trades paper USDC
against cbBTC/USDC 1-minute bars, long only, starting from $1,000.

## Strategy: recovery from the 120-minute low

The dev window (BTC -4.9% grind, then flat) kills the obvious bots:
buy-and-hold loses $52.59, EMA 8/21 loses $109.38, RSI/Bollinger loses
$65.83, and every baseline loses. Dip-buying fails because after a dip the
next 30 minutes usually keep falling. So this bot waits for a bounce to
prove itself:

- **Entry:** the close recovers 0.8% off the lowest close of the last 120
  bars, stays within 0.3% above that recovery level, and closes up on the
  bar. Stake is 50% of cash.
- **Exits:** sell half at +0.8% over the entry fill, sell the rest at +1.2%,
  on a 1.0% trailing stop from the peak close, on a 0.9% hard stop, or after
  300 bars, whichever comes first.
- **Safety:** a 5% equity circuit breaker stops all trading for the rest of
  the window (far inside the 25% race drawdown guardrail). 15-bar cooldown
  after each exit. Max slippage 200 bps per order.

Local grade on the frozen dev window (kit's `grade-local`, process driver):
net PnL about **+$6.0**, max drawdown about **-0.44%**, 3 round trips
(6 fills). Dev gate is net PnL > $0; the race window is unseen, so the bot
is deliberately boring: few trades, tight exits, no fitted intraday timing.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay/v1
  SDK shim

## Run

Grade locally with the kit (from the kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-24h-bot --driver process
```

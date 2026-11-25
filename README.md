[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lolipo8988-bot/pump-replay-jack-01/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lolipo8988-bot/pump-replay-jack-01/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# pump-replay-jack

A paper-trading bot for the make.fun competition
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
(house replay template `pumpfun-replay`, protocol `agent-fun/replay/v2`).
The bot trades 10 SOL of paper money over a replay of recorded pump.fun
bonding-curve events and is ranked by net PnL. Nothing is traded for real:
no wallet, no network, no real funds.

## Strategy in one line

Buy mature curves whose recent tape shows broad, accelerating buy
pressure with one small fixed stake, leave quickly on a take-profit, a
stop, a trailing stop or a clock, and fill idle capacity with tiny scout
round trips so the run clears the guardrail of 20 distinct coins.

## How it works

- Each curve keeps a rolling tape of its recorded trades. A curve becomes
  a buy candidate once it is at least 600 slots old and, over the last 45
  slots, net inflow is at least 20 SOL from at least 16 buy trades by at
  least 14 distinct buyers, the price rose 10%–40%, the latest price sits
  within 4% of the window high, and the newer half of the window carries
  at least as much net inflow as the older half.
- Each entry is one fixed 0.05 SOL stake, never added to, with the whole
  book's cost capped at 1.0 SOL — the drawdown guard.
- A position is sold whole on the first of: a 12% take-profit against
  cost, a 6% stop loss, a 10% trailing stop (armed after a 2% gain), net
  outflow below −1.0 SOL over 20 slots, or 200 slots held. A curve that
  completes is closed by the replay itself.
- Guardrail scouts: while fewer than 30 distinct coins have completed a
  round trip, the bot buys 0.02 SOL of a liquid curve every 500 slots
  and sells it whole as soon as the buy lands.
- Fully deterministic: no clock, no randomness, no I/O beyond the
  harness stream, so both grading executions agree byte for byte.

## Layout

- `main.ts` — the entrypoint the grader runs (`node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim, vendored byte
  for byte from the competition kit.
- `LICENSE` — MIT.

## Local grading

With the competition kit unpacked:

```
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

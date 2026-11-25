// pump-replay-jack: a paper-trading bot for the pump.fun replay sprint
// (protocol agent-fun/replay/v2). Paper trading only: the harness replays
// recorded chain data and scores the orders this bot would have placed.
// No real wallet, no real funds, no network access.
//
// Strategy in one line: buy mature curves whose recent tape shows broad,
// accelerating buy pressure with one small fixed stake, leave quickly on
// a take-profit, a stop, a trailing stop or a clock, and fill idle
// capacity with tiny scout round trips so the run clears the guardrail
// of 20 distinct coins.
//
// Wire notes: the hello message carries the caps for this run (open
// positions, per-batch orders, order size as a share of a curve's real
// reserve). After hello, every batch is one slot of events, fills and
// marks; the reply to a batch is the orders decided on that slot, and an
// order decided on slot s fills at s + latency_slots. Everything below is
// a pure function of the batch stream: no clock, no randomness, so the
// two grading executions produce identical orders.

import { LAMPORTS_PER_SOL, runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports per SOL, as a number for SOL-denominated math

// ---- entry signal ----------------------------------------------------
// A curve qualifies when, over the last LOOKBACK slots, money flowed in
// on balance, several different wallets bought, the price rose but did
// not vertical, and the latest price still sits close to the window high.
const LOOKBACK = 45; // slots of tape behind each entry decision
const MIN_AGE_SLOTS = 600; // ignore a curve until this long after its create slot
const MIN_NET_IN_SOL = 20; // buys minus sells over the lookback, in SOL
const MIN_BUY_TRADES = 16;
const MIN_DISTINCT_BUYERS = 14;
const MIN_RISE = 0.10; // price gain over the lookback, as a fraction
const MAX_RISE = 0.40; // skip curves that already went vertical in one window
const NEAR_HIGH = 0.96; // last price at least this share of the window high
const MIN_RESERVE_SOL = 3; // real SOL reserve bounds at entry
const MAX_RESERVE_SOL = 50;

// ---- position sizing ---------------------------------------------------
// One small fixed stake per entry, never added to. Keeping every stake
// small is the drawdown guard: at most MAX_MAIN_POSITIONS momentum stakes
// plus one scout at a time, and the whole book's cost stays under
// MAX_BOOK_SOL.
const FIRST_BUY_SOL = 0.05;
const ADD_BUY_SOL = 0.08;
const STAKE_SOL = 0.05; // no pyramiding: the first buy is the whole stake
const ADD_GAP_SLOTS = 25; // slots between two adds on the same curve
const MAX_MAIN_POSITIONS = 3; // one of the five slots stays free for scouts
const MAX_BOOK_SOL = 1.0; // total cost across open positions, in SOL
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- exits ---------------------------------------------------------------
const STOP_FRACTION = 0.06;
const TAKE_PROFIT_FRACTION = 0.12; // sell everything at this gain versus cost // sell everything at this loss versus cost
const TRAIL_FRACTION = 0.10; // sell this far below the best value seen
const TRAIL_ARM = 0.02; // trailing stop arms after this gain
const FADE_LOOKBACK = 20; // slots behind the flow-fade exit
const FADE_NET_SOL = -1.0; // exit when net flow over the fade window drops below this
const MAX_HOLD_SLOTS = 200;
const REENTRY_COOLDOWN = 500; // slots before a curve may be entered again
const MAX_ENTRIES_PER_CURVE = 1;

// ---- scout round trips ---------------------------------------------------
// The guardrail asks for a round trip of at least 0.01 SOL on at least 20
// distinct coins. Momentum entries alone may not reach 20, so when the
// count of finished round trips lags, the bot buys SCOUT_SOL of a liquid
// curve and sells it whole as soon as the buy lands.
const SCOUT_TARGET = 30;
const SCOUT_SOL = 0.02;
const SCOUT_GAP_SLOTS = 500; // slots between scout buys while below target
const SCOUT_MIN_RESERVE_SOL = 5;

const CURVE_FEE_FRACTION = 0.0125; // protocol + creator fee, for value estimates

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  buyer: string;
  price: number; // lamports per token unit, from post-trade virtual reserves
}

interface CurveTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  bestValueSol: number;
  exitSent: boolean;
  filled: boolean;
  lastAddSlot: number;
  lastAddPrice: number;
}

const tapes = new Map<Pubkey, CurveTape>();
const open = new Map<Pubkey, OpenPosition>();
const scouts = new Set<Pubkey>(); // mints with a scout round trip in flight
const scoutSellSent = new Set<Pubkey>(); // scouts whose sell is already in flight
const bought = new Map<Pubkey, number>(); // mint -> largest filled buy, in lamports
const roundTripped = new Set<Pubkey>(); // mints with a filled buy and a filled sell
let lastScoutSlot = -1_000_000;

function tapeFor(mint: Pubkey): CurveTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000 };
    tapes.set(mint, tape);
  }
  return tape;
}

/** Net flow, buy count, buyers and price shape of a tape over (fromSlot, now]. */
function windowStats(tape: CurveTape, fromSlot: number) {
  let netSol = 0;
  let buyTrades = 0;
  let firstPrice = -1;
  let highPrice = 0;
  let lastPrice = 0;
  const buyers = new Set<string>();
  for (const trade of tape.trades) {
    if (trade.slot <= fromSlot) {
      firstPrice = trade.price;
      continue;
    }
    if (firstPrice < 0) firstPrice = trade.price;
    if (trade.isBuy) {
      netSol += trade.sol;
      buyTrades += 1;
      buyers.add(trade.buyer);
    } else {
      netSol -= trade.sol;
    }
    if (trade.price > highPrice) highPrice = trade.price;
    lastPrice = trade.price;
  }
  return { netSol, buyTrades, buyerCount: buyers.size, firstPrice, highPrice, lastPrice };
}

function entrySignal(tape: CurveTape, now: number, reserveSol: number): boolean {
  if (reserveSol < MIN_RESERVE_SOL || reserveSol > MAX_RESERVE_SOL) return false;
  if (tape.createdSlot === null || now - tape.createdSlot < MIN_AGE_SLOTS) return false;
  if (tape.entries >= MAX_ENTRIES_PER_CURVE) return false;
  if (now - tape.lastExitSlot < REENTRY_COOLDOWN) return false;
  const stats = windowStats(tape, now - LOOKBACK);
  if (stats.firstPrice <= 0 || stats.lastPrice <= 0) return false;
  if (stats.netSol < MIN_NET_IN_SOL) return false;
  if (stats.buyTrades < MIN_BUY_TRADES || stats.buyerCount < MIN_DISTINCT_BUYERS) return false;
  const rise = stats.lastPrice / stats.firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (stats.lastPrice < NEAR_HIGH * stats.highPrice) return false;
  // Acceleration: the newer half of the window must carry at least as much
  // net inflow as the older half, so a fading burst does not qualify.
  const mid = now - Math.floor(LOOKBACK / 2);
  let olderNet = 0;
  let newerNet = 0;
  for (const trade of tape.trades) {
    if (trade.slot <= now - LOOKBACK) continue;
    const signed = trade.isBuy ? trade.sol : -trade.sol;
    if (trade.slot <= mid) olderNet += signed;
    else newerNet += signed;
  }
  return newerNet >= olderNet;
}

/** Estimated close value of a holding in SOL, curve and tx fees deducted. */
function closeValueSol(tokens: bigint, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }, txFee: bigint): number {
  if (tokens <= 0n || curve.virtual_token_reserves <= 0n) return 0;
  const grossLamports = Number((tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves);
  return (grossLamports * (1 - CURVE_FEE_FRACTION) - Number(txFee)) / SOL;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let freeLamports = state.freeCashLamports();
    let committed = state.committedPositionCount();

    // Learn from fills: which mints completed a round trip, and which of
    // our positions actually hold tokens now.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        // A sell that did not fill leaves the position in place: allow a retry.
        if (fill.side === 'sell') {
          scoutSellSent.delete(fill.mint);
          const retryPos = open.get(fill.mint);
          if (retryPos !== undefined) retryPos.exitSent = false;
        }
        continue;
      }
      if (fill.side === 'buy') {
        const amount = Number(fill.quote_lamports);
        if (amount > (bought.get(fill.mint) ?? 0)) bought.set(fill.mint, amount);
        const heldPos = open.get(fill.mint);
        if (heldPos !== undefined) heldPos.filled = true;
      } else {
        const buyAmount = bought.get(fill.mint);
        if (buyAmount !== undefined && buyAmount >= 10_000_000) roundTripped.add(fill.mint);
        if (!state.positions.has(fill.mint)) {
          scouts.delete(fill.mint);
          scoutSellSent.delete(fill.mint);
          const heldPos = open.get(fill.mint);
          if (heldPos !== undefined && heldPos.exitSent) {
            open.delete(fill.mint);
            tapeFor(fill.mint).lastExitSlot = now;
          }
        }
      }
    }

    // Fold this batch's events into the tapes.
    for (const event of batch.events) {
      const tape = tapeFor(event.mint);
      if (event.event === 'CreateEvent') {
        tape.createdSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        const virtualToken = Number(event.virtual_token_reserves);
        const price = virtualToken > 0 ? Number(event.virtual_quote_reserves) / virtualToken : 0;
        tape.trades.push({
          slot: event.slot,
          isBuy: event.is_buy,
          sol: Number(event.sol_amount) / SOL,
          buyer: event.user,
          price,
        });
      }
    }
    // Trim tape history nobody can look back to any more.
    const trimBefore = now - Math.max(LOOKBACK, FADE_LOOKBACK) - 5;
    for (const tape of tapes.values()) {
      let drop = 0;
      while (drop < tape.trades.length && tape.trades[drop].slot <= trimBefore) drop += 1;
      if (drop > 0) tape.trades.splice(0, drop);
    }

    const pushBuy = (mint: Pubkey, solAmount: number): boolean => {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) return false;
      const capLamports = state.maxBuyLamports(mint);
      const want = BigInt(Math.round(solAmount * SOL));
      const amount = capLamports < want ? capLamports : want;
      if (amount < 10_000_000n) return false; // below the guardrail's round-trip size
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (freeLamports < amount + txFee) return false;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      freeLamports -= amount + txFee;
      return true;
    };

    const pushSellAll = (mint: Pubkey): boolean => {
      const holding = state.positions.get(mint);
      if (holding === undefined || holding.token_amount <= 0n) return false;
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (freeLamports < txFee) return false;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      freeLamports -= txFee;
      return true;
    };

    // 1) Exits first: they free slots and cash for everything else.
    for (const [mint, position] of open) {
      const holding = state.positions.get(mint);
      if (holding === undefined) {
        if (!scouts.has(mint)) open.delete(mint);
        continue;
      }
      if (position.exitSent) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      if (curve.complete) {
        position.exitSent = true; // the replay closes it; sending a sell would be rejected
        continue;
      }
      const valueSol = closeValueSol(holding.token_amount, curve, txFee);
      const costSol = Number(holding.cost_lamports) / SOL;
      if (valueSol > position.bestValueSol) position.bestValueSol = valueSol;
      const tape = tapeFor(mint);
      const fade = windowStats(tape, now - FADE_LOOKBACK);
      const profitHit = position.filled && costSol > 0 && valueSol >= costSol * (1 + TAKE_PROFIT_FRACTION);
      const stopHit = position.filled && valueSol <= costSol * (1 - STOP_FRACTION);
      const trailHit =
        position.filled &&
        costSol > 0 &&
        position.bestValueSol >= costSol * (1 + TRAIL_ARM) &&
        valueSol <= position.bestValueSol * (1 - TRAIL_FRACTION);
      const fadeHit = position.filled && fade.netSol < FADE_NET_SOL && now - position.openedSlot > FADE_LOOKBACK;
      const timeHit = now - position.openedSlot >= MAX_HOLD_SLOTS;
      if (profitHit || stopHit || trailHit || fadeHit || timeHit) {
        if (pushSellAll(mint)) position.exitSent = true;
      }
    }

    // 2) Scout sells: a scout position is sold whole on the first batch
    // after its buy lands.
    for (const mint of [...scouts]) {
      if (open.has(mint) || scoutSellSent.has(mint)) continue;
      if (state.positions.has(mint) && pushSellAll(mint)) scoutSellSent.add(mint);
    }

    // Book cost so far, for the exposure guard.
    let bookCostSol = 0;
    for (const holding of state.positions.values()) bookCostSol += Number(holding.cost_lamports) / SOL;

    // 3) Adds into strength on positions that already filled.
    for (const [mint, position] of open) {
      if (position.exitSent || !position.filled) continue;
      const holding = state.positions.get(mint);
      if (holding === undefined) continue;
      const investedSol = Number(holding.cost_lamports) / SOL;
      if (investedSol >= STAKE_SOL || bookCostSol >= MAX_BOOK_SOL) continue;
      if (now - position.lastAddSlot < ADD_GAP_SLOTS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const reserveSol = Number(curve.real_quote_reserves) / SOL;
      const tape = tapeFor(mint);
      if (!entrySignal(tape, now, reserveSol)) continue;
      const stats = windowStats(tape, now - LOOKBACK);
      if (stats.lastPrice < position.lastAddPrice) continue;
      const addSol = Math.min(ADD_BUY_SOL, STAKE_SOL - investedSol);
      if (pushBuy(mint, addSol)) {
        position.lastAddSlot = now;
        position.lastAddPrice = stats.lastPrice;
        bookCostSol += addSol;
      }
    }

    // 4) Fresh momentum entries, in the order this batch's events arrive.
    const seenThisBatch = new Set<Pubkey>();
    for (const event of batch.events) {
      if (committed >= MAX_MAIN_POSITIONS + 1) break; // keep the scout slot reachable
      if (open.size >= MAX_MAIN_POSITIONS) break;
      if (bookCostSol >= MAX_BOOK_SOL) break;
      const mint = event.mint;
      if (seenThisBatch.has(mint)) continue;
      seenThisBatch.add(mint);
      if (open.has(mint) || scouts.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const reserveSol = Number(curve.real_quote_reserves) / SOL;
      const tape = tapeFor(mint);
      if (!entrySignal(tape, now, reserveSol)) continue;
      if (pushBuy(mint, FIRST_BUY_SOL)) {
        const stats = windowStats(tape, now - LOOKBACK);
        open.set(mint, {
          openedSlot: now,
          bestValueSol: 0,
          exitSent: false,
          filled: false,
          lastAddSlot: now,
          lastAddPrice: stats.lastPrice,
        });
        tape.entries += 1;
        committed += 1;
        bookCostSol += FIRST_BUY_SOL;
      }
    }

    // 5) Scout buys while the round-trip count lags its target.
    if (
      roundTripped.size + scouts.size < SCOUT_TARGET &&
      now - lastScoutSlot >= SCOUT_GAP_SLOTS &&
      committed < caps.max_open_positions
    ) {
      for (const event of batch.events) {
        const mint = event.mint;
        if (open.has(mint) || scouts.has(mint) || roundTripped.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / SOL < SCOUT_MIN_RESERVE_SOL) continue;
        if (curve.trades < 8) continue;
        if (pushBuy(mint, SCOUT_SOL)) {
          scouts.add(mint);
          lastScoutSlot = now;
          committed += 1;
        }
        break;
      }
    }

    return orders;
  },
});

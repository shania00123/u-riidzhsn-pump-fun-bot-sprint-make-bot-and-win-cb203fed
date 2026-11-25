// RIVAL (duel candidate): the dip-rider.
//
// A different market-microstructure bet from tape-rider: instead of chasing the
// launch pop, buy the first dip after it. A coin that pumped in its first slots
// and then retraced 15-35% from its early high, while buyers are still stepping
// in (recent trades mostly buys, last trade a buy), tends to bounce part of the
// way back. Small single buys, fast take-profit / stop-loss / time limit, no
// adds, no riding. Guardrail probes identical to tape-rider's (buy 0.01 SOL,
// sell on landing) so the duel compares compliant bots.
//
// Pure function of the batches: no clock, no randomness, no I/O, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback (slots) for the early high the drawdown is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the early high (fraction). */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** Real SOL reserve at entry, at least this (lamports). */
  minRqLamports: bigint;
  /** Slots since CreateEvent before entry is allowed / after which it is not. */
  minAge: number;
  maxAge: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and the most recent trade must be a buy. */
  lastMustBeBuy: boolean;
  /** Distinct buyers since creation, at least this many. */
  minBuyers: number;
  /** Skip the coin if the creator sold before entry. */
  skipDevSold: boolean;
  /** Lamports per buy; most lamports per position (single buy, no adds). */
  stakeLamports: bigint;
  /** Smallest buy worth sending. */
  minBuyLamports: bigint;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as fractions of cost. */
  takeProfit: number;
  stopLoss: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most positions open at once (<= caps.max_open_positions). */
  maxOpen: number;
  /** Most SOL at cost across all positions at once (lamports). */
  maxExposureLamports: bigint;
  /** Guardrail probes: target counted coins, pace window (block-time seconds). */
  targetCoins: number;
  paceSecs: number;
  probeSolLamports: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  highWindow: 300,
  ddMin: 0.15,
  ddMax: 0.35,
  minRqLamports: 3_000_000_000n,
  minAge: 10,
  maxAge: 300,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  minBuyers: 3,
  skipDevSold: true,
  stakeLamports: 50_000_000n,
  minBuyLamports: 20_000_000n,
  buySlipBps: 1500,
  takeProfit: 0.2,
  stopLoss: 0.1,
  maxHold: 300,
  cooldown: 100,
  maxEntries: 1,
  maxOpen: 5,
  maxExposureLamports: 6_000_000_000n,
  targetCoins: 25,
  paceSecs: 21_600,
  probeSolLamports: 10_000_000n,
  maxProbes: 1,
};

const FEE_BPS = 125n;
const BPS = 10_000n;

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: number;
}

interface CoinTape {
  created: number | null;
  creator: string | null;
  trades: Tick[];
  high: number;
  highSlot: number;
  entries: number;
  lastExit: number;
  devSold: boolean;
  complete: boolean;
  buyers: Set<string>;
}

interface Held {
  opened: number;
  invested: bigint;
  peakValue: bigint;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  const counted = new Set<Pubkey>();
  const boughtBig = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        trades: [],
        high: 0,
        highSlot: 0,
        entries: 0,
        lastExit: -1e12,
        devSold: false,
        complete: false,
        buyers: new Set(),
      };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator && !e.is_buy) t.devSold = true;
          if (e.is_buy && e.user !== t.creator) t.buyers.add(e.user);
          if (t.created !== null && e.slot - t.created <= p.highWindow && price > t.high) {
            t.high = price;
            t.highSlot = e.slot;
          }
        } else {
          tapeOf(e.mint).complete = true;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - p.highWindow - 5) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          if (boughtBig.has(f.mint)) counted.add(f.mint);
          held.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy' && BigInt(f.quote_lamports) >= 10_000_000n) {
          boughtBig.add(f.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = BigInt(state.txFeeLamports());

      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            if (boughtBig.has(mint)) counted.add(mint);
            probes.delete(mint);
          }
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (boughtBig.has(mint)) counted.add(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(pos.token_amount);
        const cost = BigInt(pos.cost_lamports);
        const value = sellValue(tokens, vq, vt) - tx;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value < (cost * BigInt(Math.round((1 - p.stopLoss) * 1e6))) / 1_000_000n) exit = true;
        if (!exit && value >= (cost * BigInt(Math.round((1 + p.takeProfit) * 1e6))) / 1_000_000n) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      let free = BigInt(state.freeCashLamports());
      let slotsLeft = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
      let exposure = 0n;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += h.invested > 0n ? h.invested : pos !== undefined ? BigInt(pos.cost_lamports) : 0n;
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        if (p.skipDevSold && t.devSold) continue;
        if (curve.real_quote_reserves < p.minRqLamports) continue;
        if (t.high <= 0) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const dd = 1 - price / t.high;
        if (dd < p.ddMin || dd > p.ddMax) continue;
        if (t.buyers.size < p.minBuyers) continue;
        const recent = t.trades.slice(-p.flowTrades);
        if (recent.length < p.flowTrades) continue;
        let buys = 0;
        for (const tr of recent) if (tr.buy) buys++;
        if (buys < p.minBuys) continue;
        if (p.lastMustBeBuy && !recent[recent.length - 1]!.buy) continue;
        if (slotsLeft <= 0) continue;
        const capLamports = BigInt(state.maxBuyLamports(mint));
        let amount = p.stakeLamports < capLamports ? p.stakeLamports : capLamports;
        const room = p.maxExposureLamports - exposure;
        if (amount > room) amount = room;
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuyLamports) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, invested: amount, peakValue: 0n, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
      }

      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (counted.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSolLamports * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (counted.has(mint) || boughtBig.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < p.probeSolLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeSolLamports, max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSolLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}

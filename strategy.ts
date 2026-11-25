// Tape-rider v2: a pump.fun bonding-curve replay bot.
//
// What the dev window (1,222 coins, 24h) taught:
//  - Most coins bleed back to ~1.0x within ~1,000 slots of creation; the money is in
//    catching the first inflow wave and leaving before it reverses. Entries are
//    decided within 3 slots of a coin's creation, on its opening tape.
//  - Two tape facts predict the wave: >=5 distinct buyers in the first slots, and a
//    creator who bought >=0.75 SOL in the create slot (skin in the game: those coins
//    hit a >=1.5x peak roughly twice as often as ones whose creator bought <0.5 SOL).
//    Coins passing both filters are the "strict" tier and get full size; coins
//    passing only the buyer/flow filter are the "broad" tier and get small size.
//  - Fees punish tiny orders: every order pays 105,000 lamports of tx fee, so no buy
//    below minBuyLamports is ever sent, and buys only happen once the 1%-of-reserve
//    cap allows a meaningful size.
//  - Exits are a take-profit, a stop-loss, a trailing stop once armed, a time limit,
//    and an exit on creator selling / a big sell / flow reversal. Tight trailing
//    stops were tried and lost money (they exit on noise); the time limit does the
//    work instead. Pyramiding and "ride" modes were tried and lost money (they let
//    losers grow); positions are single buys, never added to.
//  - Guardrail probes: the run must end with >=20 coins traded in >=0.01 SOL round
//    trips. When the bot's own counted coins lag the pace, it opens tiny probe
//    round trips (buy 0.01 SOL, sell it as soon as it lands) on liquid coins until
//    it is back on pace. Each probe costs ~0.0005 SOL, so they are a safety net,
//    not a strategy.
//
// Pure function of the batches: no clock, no randomness, no I/O, iteration only
// over insertion-ordered maps fed by the batch stream, so the two graded
// executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots for the tape signal. */
  window: number;
  /** Net buy SOL over the window (buys minus sells), in lamports. */
  minNetLamports: bigint;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct (non-creator) buying wallets in the window. */
  minBuyers: number;
  /** Most distinct buying wallets in the window (0 = no cap). */
  maxBuyers: number;
  /** Price now over price at window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip coins that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve window at entry (lamports). */
  minRqLamports: bigint;
  maxRqLamports: bigint;
  /** Slots since CreateEvent before entry is allowed / after which it is not. */
  minAge: number;
  maxAge: number;
  /** Creator's own buys in the create slot must be at most this (lamports). */
  maxDevBuyLamports: bigint;
  /** Creator's own buys in the create slot must be at least this (lamports). */
  minDevBuyLamports: bigint;
  /** Skip the coin if the creator sold before entry. */
  skipDevSold: boolean;
  /** Broad-tier first buy (lamports); the strict tier uses strictBuyLamports. */
  firstBuyLamports: bigint;
  /** Strict tier: creator bought at least this in the create slot (lamports). */
  strictDevBuyLamports: bigint;
  /** Strict-tier first buy (lamports). */
  strictBuyLamports: bigint;
  /** Strict-tier time limit (slots); broad tier uses maxHold. */
  strictHold: number;
  /** Smallest buy worth sending (tx fee is 105k lamports per order). */
  minBuyLamports: bigint;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  takeProfit: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
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
  window: 30,
  minNetLamports: 500_000_000n,
  minBuys: 3,
  minBuyers: 5,
  maxBuyers: 0,
  minPriceUp: 0.03,
  maxPriceUp: 0.8,
  accel: 1,
  nearHigh: 0.9,
  minRqLamports: 300_000_000n,
  maxRqLamports: 40_000_000_000n,
  minAge: 0,
  maxAge: 3,
  maxDevBuyLamports: 2_500_000_000n,
  minDevBuyLamports: 0n,
  skipDevSold: true,
  // CHAMPION (duel winner vs dip-rider rival, 4-fold cold-start validation):
  // broad tier OFF — the tape signal alone is a losing trade; only the
  // creator-buy band [0.75, 2.5] SOL is bought, 0.15 SOL, hold <= 10 slots.
  firstBuyLamports: 0n,
  strictDevBuyLamports: 750_000_000n,
  strictBuyLamports: 150_000_000n,
  strictHold: 10,
  minBuyLamports: 20_000_000n,
  buySlipBps: 1500,
  takeProfit: 0.2,
  stopLoss: 0.15,
  trail: 0.2,
  trailArm: 0.1,
  maxHold: 10,
  cooldown: 100,
  maxEntries: 2,
  maxOpen: 5,
  maxExposureLamports: 6_000_000_000n,
  // Guardrail probes target 30 counted coins per 6h window (guardrail is 20).
  targetCoins: 30,
  paceSecs: 21_600,
  probeSolLamports: 10_000_000n,
  maxProbes: 1,
};

const FEE_BPS = 125n; // protocol 95 + creator 30, charged on the curve side
const BPS = 10_000n;

/** What selling `tokens` against (vq, vt) pays after curve fees. */
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
  vq0: bigint;
  vt0: bigint;
  trades: Tick[];
  entries: number;
  lastExit: number;
  devBuy: bigint;
  devSold: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  invested: bigint;
  peakValue: bigint;
  holdLimit: number;
  exiting: boolean;
  filled: boolean;
}

type Tier = 'strict' | 'broad';

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints with a >=0.01 SOL buy filled and the position since closed. */
  const counted = new Set<Pubkey>();
  /** Mints with a >=0.01 SOL buy filled (position may still be open). */
  const boughtBig = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        vq0: 0n,
        vt0: 0n,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        devBuy: 0n,
        devSold: false,
        complete: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded lamports (buys minus sells) over the last `w` slots. */
  const flow = (t: CoinTape, now: number, w: number): bigint => {
    let net = 0n;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry tier for a coin's tape at slot `now`; rq is its real SOL in lamports. */
  const entryTier = (t: CoinTape, now: number, rq: bigint): Tier | null => {
    if (rq < p.minRqLamports || rq > p.maxRqLamports) return null;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return null;
    if (t.complete) return null;
    if (p.skipDevSold && t.devSold) return null;
    if (t.devBuy > p.maxDevBuyLamports) return null;
    if (t.devBuy < p.minDevBuyLamports) return null;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0n;
    let sellSol = 0n;
    let buys = 0;
    let netOld = 0n;
    let netNew = 0n;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return null;
    if (p.maxBuyers > 0 && byUser.size > p.maxBuyers) return null;
    if (buySol - sellSol < p.minNetLamports) return null;
    if (startPrice <= 0) return null;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return null;
    if (last < high * p.nearHigh) return null;
    if (netNew <= 0n) return null;
    if (netOld > 0n && netNew < netOld * BigInt(Math.round(p.accel * 100)) / 100n) return null;
    return t.devBuy >= p.strictDevBuyLamports ? 'strict' : 'broad';
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.vq0 = BigInt(e.virtual_quote_reserves);
          t.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (t.created !== null && e.slot === t.created && e.user === t.creator && e.is_buy) {
            t.devBuy += sol;
          }
          if (t.creator !== null && e.user === t.creator && !e.is_buy) t.devSold = true;
          if (!e.is_buy && sol >= 2_000_000_000n) bigSell.add(e.mint);
        } else {
          // CompleteEvent
          tapeOf(e.mint).complete = true;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      // Track my own fills: a >=0.01 SOL buy counts the coin once its position closes.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete/flatten): the coin's round trip is done.
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

      // Probe sells: sell the whole probe as soon as its buy has landed.
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

      // Exits first.
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
        const t = tapeOf(mint);
        if (!exit && value < (cost * BigInt(Math.round((1 - p.stopLoss) * 1e6))) / 1_000_000n) exit = true;
        if (!exit && h.peakValue >= (cost * BigInt(Math.round((1 + p.trailArm) * 1e6))) / 1_000_000n && value < (h.peakValue * BigInt(Math.round((1 - p.trail) * 1e6))) / 1_000_000n) exit = true;
        if (!exit && value >= (cost * BigInt(Math.round((1 + p.takeProfit) * 1e6))) / 1_000_000n) exit = true;
        if (!exit && now - h.opened > h.holdLimit) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && flow(t, now, p.window) < -p.minNetLamports) exit = true;
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

      // Entries.
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
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const tier = entryTier(t, now, curve.real_quote_reserves);
        if (tier === null) continue;
        if (slotsLeft <= 0) continue;
        const want = tier === 'strict' ? p.strictBuyLamports : p.firstBuyLamports;
        const capLamports = BigInt(state.maxBuyLamports(mint));
        let amount = want < capLamports ? want : capLamports;
        const room = p.maxExposureLamports - exposure;
        if (amount > room) amount = room;
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuyLamports) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          invested: amount,
          peakValue: 0n,
          holdLimit: tier === 'strict' ? p.strictHold : p.maxHold,
          exiting: false,
          filled: false,
        });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when counted coins lag the pace.
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

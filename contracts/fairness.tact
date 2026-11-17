import "@stdlib/deploy";

// Commit-reveal betting, verified and settled on-chain.
//
// One round:
//   Open(hash, window)   the owner commits sha256(seed). The commitment is fixed
//                        until the round is settled.
//   PlaceBet             players stake TON on a target multiplier until betsCloseAt.
//   Reveal(seed)         the owner reveals the seed after betsCloseAt and before
//                        revealBy. Bets are closed by then, so nobody can bet on a
//                        seed that is already public.
//   "expire"             anyone, once revealBy has passed without a reveal: every bet
//                        is paid as a win, so withholding the seed never helps the owner.
//   "settle"             pays the bets in batches of BATCH. The contract sends it to
//                        itself until every bet is settled; anyone may send it too.
//
// The maximum payout of a bet is reserved when the bet is accepted, so a win is
// never left unpaid, and the owner can withdraw only between rounds.

message Open {
    commitment: Int as uint256;
    betWindow: Int as uint32;           // seconds during which bets are accepted
}

message PlaceBet {
    target: Int as uint32;              // cash-out multiplier x100 (200 = 2.00x)
    clientSeed: String;
    nonce: Int as uint32;
}

message Reveal {
    serverSeed: String;
}

message Withdraw {
    amount: Int as coins;
}

struct Bet {
    player: Address;
    stake: Int as coins;
    target: Int as uint32;
    clientSeed: String;
    nonce: Int as uint32;
}

const E: Int = 4503599627370496;        // 2^52, the entropy width of the multiplier
const MIN_TARGET: Int = 101;            // 1.01x
const MAX_TARGET: Int = 10000;          // 100x
const MIN_STAKE: Int = ton("0.05");
const GAS_RESERVE: Int = ton("0.02");   // kept from every bet to pay for its settlement
const MAX_BETS: Int = 1000;             // per round
const MAX_SEED_BYTES: Int = 64;         // both seeds; keeps the gas of a batch bounded
const BATCH: Int = 25;                  // bets settled per transaction
const SETTLE_GAS: Int = ton("0.5");     // gas limit for one batch; unused value stays here
const STORAGE_RESERVE: Int = ton("0.1");
const FLOAT: Int = STORAGE_RESERVE + SETTLE_GAS; // always kept free, so settlement can run
const MIN_BET_WINDOW: Int = 30;
const MAX_BET_WINDOW: Int = 86400;
const REVEAL_WINDOW: Int = 3600;

const IDLE: Int = 0;
const OPEN: Int = 1;
const SETTLING: Int = 2;

contract Fairness with Deployable {
    owner: Address;
    phase: Int as uint8 = 0;
    round: Int as uint32 = 0;
    commitment: Int as uint256 = 0;
    betsCloseAt: Int as uint32 = 0;
    revealBy: Int as uint32 = 0;
    seed: String = "";
    expired: Bool = false;
    bets: map<Int as uint16, Bet> = emptyMap();
    betCount: Int as uint16 = 0;
    settled: Int as uint16 = 0;
    reserved: Int as coins = 0;         // maximum payouts of the bets not settled yet

    init(owner: Address) {
        self.owner = owner;
    }

    receive(msg: Open) {
        require(sender() == self.owner, "only owner");
        require(self.phase == IDLE, "round in progress");
        require(msg.commitment != 0, "empty commitment");
        require(msg.betWindow >= MIN_BET_WINDOW && msg.betWindow <= MAX_BET_WINDOW, "bet window out of range");
        require(myBalance() >= FLOAT, "fund the contract first");
        self.phase = OPEN;
        self.round += 1;
        self.commitment = msg.commitment;
        self.betsCloseAt = now() + msg.betWindow;
        self.revealBy = self.betsCloseAt + REVEAL_WINDOW;
        self.seed = "";
        self.expired = false;
        self.bets = emptyMap();
        self.betCount = 0;
        self.settled = 0;
    }

    // Owner tops up the bankroll so winning bets can be paid.
    receive("fund") {
        require(sender() == self.owner, "only owner");
    }

    receive(msg: PlaceBet) {
        require(self.phase == OPEN && now() < self.betsCloseAt, "betting is closed");
        require(msg.target >= MIN_TARGET && msg.target <= MAX_TARGET, "target out of range");
        require(self.betCount < MAX_BETS, "round is full");
        require(self.isShort(msg.clientSeed), "client seed longer than 64 bytes");
        let stake: Int = context().value - GAS_RESERVE;
        require(stake >= MIN_STAKE, "stake too small");
        let payout: Int = stake * msg.target / 100;
        // myBalance() already includes this bet.
        require(myBalance() - self.reserved - FLOAT >= payout, "bankroll cannot cover this bet");
        self.reserved += payout;
        self.bets.set(self.betCount, Bet{
            player: sender(), stake: stake, target: msg.target, clientSeed: msg.clientSeed, nonce: msg.nonce,
        });
        self.betCount += 1;
    }

    receive(msg: Reveal) {
        require(sender() == self.owner, "only owner");
        require(self.phase == OPEN, "no open round");
        require(now() >= self.betsCloseAt, "betting is still open");
        require(now() < self.revealBy, "reveal window has passed");
        require(sha256(msg.serverSeed) == self.commitment, "seed does not match commitment");
        // A longer seed could make settlement cost more gas than a transaction allows.
        // If the owner committed to one, it cannot be revealed and the round expires.
        require(self.isShort(msg.serverSeed), "seed longer than 64 bytes");
        self.seed = msg.serverSeed;
        self.phase = SETTLING;
        self.continueSettling();
    }

    receive("expire") {
        require(self.phase == OPEN && now() >= self.revealBy, "nothing to expire");
        self.expired = true;
        self.phase = SETTLING;
        self.continueSettling();
    }

    receive("settle") {
        require(self.phase == SETTLING, "nothing to settle");
        let end: Int = min(self.settled + BATCH, self.betCount);
        let i: Int = self.settled;
        while (i < end) {
            let bet: Bet = self.bets.get(i)!!;
            let payout: Int = bet.stake * bet.target / 100;
            if (self.expired || self.crashFrom(self.seed, bet.clientSeed, bet.nonce) >= bet.target) {
                // No SendIgnoreErrors: if this payout cannot be sent, the whole batch is
                // rolled back and can be settled again, instead of losing the win.
                send(SendParameters{
                    to: bet.player,
                    value: payout,
                    mode: SendPayFwdFeesSeparately,
                    bounce: false,
                });
            }
            self.reserved -= payout;
            self.bets.del(i);
            i += 1;
        }
        self.settled = end;
        if (self.settled < self.betCount) {
            self.continueSettling();
        } else {
            self.phase = IDLE;
        }
    }

    // Only between rounds, and never below the float.
    receive(msg: Withdraw) {
        require(sender() == self.owner, "only owner");
        require(self.phase == IDLE, "round in progress");
        require(myBalance() - msg.amount >= FLOAT, "would leave too little for the next round");
        send(SendParameters{
            to: self.owner,
            value: msg.amount,
            mode: SendPayFwdFeesSeparately,
            bounce: false,
        });
    }

    fun continueSettling() {
        send(SendParameters{
            to: myAddress(),
            value: SETTLE_GAS,
            mode: SendPayFwdFeesSeparately,
            bounce: false,
            body: "settle".asComment(),
        });
    }

    fun isShort(s: String): Bool {
        let bits: Slice = s.asSlice();
        return bits.refs() == 0 && bits.bits() <= MAX_SEED_BYTES * 8;
    }

    // The multiplier x100 (247 means 2.47x), derived from the revealed seed.
    // u = h / 2^52 is uniform in [0, 1) and the multiplier is 0.99 / (1 - u), floored to
    // 0.01x. P(multiplier >= t) = 0.99 / t for every target t >= 1.01, so every target
    // has the same 1% edge.
    fun crashFrom(seed: String, clientSeed: String, nonce: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append(seed);
        sb.append(":");
        sb.append(clientSeed);
        sb.append(":");
        sb.append(nonce.toString());
        let h: Int = sha256(sb.toString()) >> 204;     // top 52 bits
        return max(99 * E / (E - h), 100);
    }

    // Recompute any multiplier with the last revealed seed; 0 before a reveal.
    get fun crashPoint(clientSeed: String, nonce: Int): Int {
        if (self.seed == "") { return 0 }
        return self.crashFrom(self.seed, clientSeed, nonce);
    }

    get fun phase(): Int { return self.phase }
    get fun round(): Int { return self.round }
    get fun commitment(): Int { return self.commitment }
    get fun betsCloseAt(): Int { return self.betsCloseAt }
    get fun revealBy(): Int { return self.revealBy }
    get fun revealedSeed(): String { return self.seed }
    get fun expired(): Bool { return self.expired }
    get fun betCount(): Int { return self.betCount }
    get fun settledCount(): Int { return self.settled }
    get fun reserved(): Int { return self.reserved }
    get fun freeBankroll(): Int { return myBalance() - self.reserved - FLOAT }
    get fun betAt(index: Int): Bet? { return self.bets.get(index) }
    get fun owner(): Address { return self.owner }
}

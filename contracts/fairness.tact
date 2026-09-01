import "@stdlib/deploy";

// Commit-reveal fairness, verified on-chain.
// Commit hash(seed) before the round, reveal the seed after — the contract
// checks it so nobody has to trust the operator.

message Commit {
    commitment: Int as uint256;
}

message Reveal {
    serverSeed: String;
}

message Reset {
    commitment: Int as uint256;
}

// A player stakes TON on a target multiplier before the seed is revealed.
message PlaceBet {
    target: Int as uint32;      // desired cash-out, x100 (200 = 2.00x)
    clientSeed: String;
    nonce: Int as uint32;
}

struct BetInfo {
    amount: Int as coins;
    target: Int as uint32;
    clientSeed: String;
    nonce: Int as uint32;
}

// 2^52 — the entropy width the multiplier is drawn from.
const E: Int = 4503599627370496;
const GAS_RESERVE: Int = ton("0.02");

contract Fairness with Deployable {
    owner: Address;
    commitment: Int as uint256 = 0;
    revealedSeed: String = "";
    isRevealed: Bool = false;
    rounds: Int as uint32 = 0;
    bets: map<Address, BetInfo> = emptyMap();

    init(owner: Address) {
        self.owner = owner;
    }

    receive(msg: Commit) {
        require(sender() == self.owner, "only owner");
        require(!self.isRevealed, "reveal current round first");
        self.commitment = msg.commitment;
    }

    // Owner tops up the bankroll so winning bets can be paid.
    receive("fund") {
        require(sender() == self.owner, "only owner");
    }

    // Bet while the seed is still hidden. Staked TON is the message value.
    receive(msg: PlaceBet) {
        require(self.commitment != 0, "no active round");
        require(!self.isRevealed, "round already revealed");
        require(msg.target >= 101, "target must exceed 1.00x");
        let stake: Int = context().value - GAS_RESERVE;
        require(stake > 0, "stake too small");
        self.bets.set(sender(), BetInfo{
            amount: stake, target: msg.target, clientSeed: msg.clientSeed, nonce: msg.nonce
        });
    }

    receive(msg: Reveal) {
        require(sender() == self.owner, "only owner");
        require(sha256(msg.serverSeed) == self.commitment, "seed does not match commitment");
        self.revealedSeed = msg.serverSeed;
        self.isRevealed = true;
        self.rounds += 1;

        // Settle every bet automatically against the on-chain multiplier.
        foreach (player, bet in self.bets) {
            let crash: Int = self.crashFrom(msg.serverSeed, bet.clientSeed, bet.nonce);
            if (crash >= bet.target) {
                let payout: Int = bet.amount * bet.target / 100;
                send(SendParameters{
                    to: player,
                    value: payout,
                    mode: SendIgnoreErrors,
                    bounce: false,
                });
            }
        }
        self.bets = emptyMap();
    }

    receive(msg: Reset) {
        require(sender() == self.owner, "only owner");
        self.commitment = msg.commitment;
        self.isRevealed = false;
        self.revealedSeed = "";
    }

    // The crash multiplier itself, derived on-chain from the revealed seed.
    // Returned x100 (e.g. 247 means 2.47x). 1% edge is baked into the formula.
    fun crashFrom(seed: String, clientSeed: String, nonce: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append(seed);
        sb.append(":");
        sb.append(clientSeed);
        sb.append(":");
        sb.append(nonce.toString());

        let hash: Int = sha256(sb.toString());
        let h: Int = hash >> 204;              // top 52 bits
        if (h == 0) { h = 1 }

        let x100: Int = (100 * E - h) / (E - h);
        if (x100 < 100) { x100 = 100 }
        return x100;
    }

    // Ask the chain for a round's multiplier. Only valid once revealed.
    get fun crashPoint(clientSeed: String, nonce: Int): Int {
        if (!self.isRevealed) { return 0 }
        return self.crashFrom(self.revealedSeed, clientSeed, nonce);
    }

    get fun commitment(): Int {
        return self.commitment;
    }

    get fun verified(): Bool {
        return self.isRevealed;
    }

    get fun roundsPlayed(): Int {
        return self.rounds;
    }

    get fun owner(): Address {
        return self.owner;
    }

    get fun betOf(player: Address): BetInfo? {
        return self.bets.get(player);
    }
}

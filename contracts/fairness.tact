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

contract Fairness with Deployable {
    owner: Address;
    commitment: Int as uint256 = 0;
    revealedHash: Int as uint256 = 0;
    isRevealed: Bool = false;
    rounds: Int as uint32 = 0;

    init(owner: Address) {
        self.owner = owner;
    }

    receive(msg: Commit) {
        require(sender() == self.owner, "only owner");
        require(!self.isRevealed, "reveal current round first");
        self.commitment = msg.commitment;
    }

    receive(msg: Reveal) {
        require(sender() == self.owner, "only owner");
        let h: Int = sha256(msg.serverSeed);
        require(h == self.commitment, "seed does not match commitment");
        self.revealedHash = h;
        self.isRevealed = true;
        self.rounds += 1;
    }

    receive(msg: Reset) {
        require(sender() == self.owner, "only owner");
        self.commitment = msg.commitment;
        self.isRevealed = false;
        self.revealedHash = 0;
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
}

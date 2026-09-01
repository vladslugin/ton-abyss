# ton-abyss

![TON](https://img.shields.io/badge/TON-Tact-0098EA) ![tests](https://img.shields.io/badge/tests-7%2F7%20passing-3ad17c) ![license](https://img.shields.io/badge/license-MIT-blue)

A tiny provably-fair verifier that lives **on-chain**. The operator commits to a
hashed seed before a round and reveals it after — and the smart contract itself
checks the reveal, so players don't have to take anyone's word for it.

It's the on-chain half of a crash casino I've been building
([abyss-casino](https://github.com/vladslugin/abyss-casino) is the off-chain
game). Same fairness math, same `SHA-256`, now enforced by a TON contract in Tact —
including the crash multiplier itself, which the contract derives on-chain.

## How it works

```mermaid
sequenceDiagram
    participant O as Operator
    participant C as Contract (TON)
    participant P as Player
    O->>C: commit( sha256(seed) )
    C-->>P: commitment is public, on-chain
    Note over P: player bets on this round
    O->>C: reveal( seed )
    C->>C: require sha256(seed) == commitment
    Note over C: verified on-chain — no trust needed
```

The nice part: `sha256` inside the contract produces the **exact same hash** as
the server and the browser. So the commitment *and the multiplier* computed
off-chain can both be verified right on TON — the tests cross-check every round
against an independent off-chain implementation.

## Tests

```
Fairness (on-chain provably-fair verifier)
  ✓ external sha256 matches the on-chain commitment
  ✓ accepts a correct reveal and marks the round verified
  ✓ rejects a reveal that does not match the commitment
  ✓ derives the crash multiplier on-chain, matching the off-chain formula
  ✓ returns 0 for the multiplier before the seed is revealed
  ✓ only the owner can commit
  ✓ supports multiple rounds via reset

Tests: 7 passed, 7 total
```

## Run it

```bash
npm install
npx blueprint build Fairness     # compile the Tact contract
npx blueprint test               # run the sandbox tests
```

Deploy to testnet:

```bash
npx blueprint run deployFairness --testnet
```

## Contract

`contracts/fairness.tact` — the whole thing is ~60 lines:

- `commit(hash)` — publish `sha256(server_seed)` before the round
- `reveal(seed)` — contract enforces `sha256(seed) == commitment`
- `reset(hash)` — start a new round
- `crashPoint(clientSeed, nonce)` — the multiplier, derived on-chain from the revealed seed (returned x100, so `247` = 2.47x)
- getters: `commitment`, `verified`, `roundsPlayed`, `owner`

Only the owner can commit or reveal; a mismatched seed is rejected by the VM.

## What's next

The contract now verifies fairness *and* derives the multiplier on-chain. Next
up: hold bets in escrow and pay out automatically, then wrap the whole thing in
a Telegram Mini App.

## License

MIT

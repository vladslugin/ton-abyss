import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { Fairness } from '../build/Fairness/Fairness_Fairness';

export const E = 1n << 52n;
export const BET_WINDOW = 60;
export const REVEAL_WINDOW = 3600;
export const GAS_RESERVE = toNano('0.02');

export const commit = (seed: string) => BigInt('0x' + sha256_sync(seed).toString('hex'));

// The contract's formula, computed independently off-chain.
export function crash(seed: string, clientSeed: string, nonce: number | bigint): bigint {
    const h = BigInt('0x' + sha256_sync(`${seed}:${clientSeed}:${nonce}`).toString('hex')) >> 204n;
    const x100 = (99n * E) / (E - h);
    return x100 < 100n ? 100n : x100;
}

export function findNonce(seed: string, client: string, pred: (x100: bigint) => boolean): bigint {
    for (let n = 0; n < 100_000; n++) if (pred(crash(seed, client, n))) return BigInt(n);
    throw new Error('no matching nonce');
}

export const payoutFor = (value: bigint, target: bigint) => ((value - GAS_RESERVE) * target) / 100n;

export interface Game {
    chain: Blockchain;
    owner: SandboxContract<TreasuryContract>;
    game: SandboxContract<Fairness>;
}

export async function setup(bankroll = '10'): Promise<Game> {
    const chain = await Blockchain.create();
    chain.now = 1_800_000_000;
    const owner = await chain.treasury('owner');
    const game = chain.openContract(await Fairness.fromInit(owner.address));
    await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    if (bankroll !== '0') await game.send(owner.getSender(), { value: toNano(bankroll) }, 'fund');
    return { chain, owner, game };
}

export const open = ({ owner, game }: Game, seed: string, betWindow = BET_WINDOW) =>
    game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Open', commitment: commit(seed), betWindow: BigInt(betWindow) });

export const bet = ({ game }: Game, player: SandboxContract<TreasuryContract>, target: bigint, clientSeed: string, nonce: bigint, value = toNano('1')) =>
    game.send(player.getSender(), { value }, { $$type: 'PlaceBet', target, clientSeed, nonce });

export const reveal = ({ owner, game }: Game, seed: string) =>
    game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Reveal', serverSeed: seed });

export const closeBetting = (g: Game) => { g.chain.now! += BET_WINDOW; };

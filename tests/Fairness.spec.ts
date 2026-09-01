import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { Fairness } from '../build/Fairness/Fairness_Fairness';
import '@ton/test-utils';

const commit = (seed: string) => BigInt('0x' + sha256_sync(seed).toString('hex'));

// Same multiplier formula as the contract, computed off-chain to cross-check.
const E = 4503599627370496n; // 2^52
function crashOffchain(seed: string, clientSeed: string, nonce: number): bigint {
    const hash = BigInt('0x' + sha256_sync(`${seed}:${clientSeed}:${nonce}`).toString('hex'));
    let h = hash >> 204n;
    if (h === 0n) h = 1n;
    let x100 = (100n * E - h) / (E - h);
    if (x100 < 100n) x100 = 100n;
    return x100;
}

describe('Fairness (on-chain provably-fair verifier)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let fairness: SandboxContract<Fairness>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        stranger = await blockchain.treasury('stranger');
        fairness = blockchain.openContract(await Fairness.fromInit(owner.address));

        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Deploy', queryId: 0n } as any);
    });

    it('external sha256 matches the on-chain commitment', async () => {
        const seed = 'abyss-round-0001-secret';
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });
        expect(await fairness.getCommitment()).toBe(commit(seed));
    });

    it('accepts a correct reveal and marks the round verified', async () => {
        const seed = 'abyss-round-0001-secret';
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });

        const res = await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: seed });

        expect(res.transactions).toHaveTransaction({ from: owner.address, to: fairness.address, success: true });
        expect(await fairness.getVerified()).toBe(true);
        expect(await fairness.getRoundsPlayed()).toBe(1n);
    });

    it('rejects a reveal that does not match the commitment', async () => {
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit('the-real-seed') });

        const res = await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: 'a-forged-seed' });

        expect(res.transactions).toHaveTransaction({ from: owner.address, to: fairness.address, success: false });
        expect(await fairness.getVerified()).toBe(false);
    });

    it('derives the crash multiplier on-chain, matching the off-chain formula', async () => {
        const seed = 'abyss-round-0001-secret';
        const client = 'player-seed-xyz';
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: seed });

        for (const nonce of [0, 1, 7, 42, 1000]) {
            const onChain = await fairness.getCrashPoint(client, BigInt(nonce));
            expect(onChain).toBe(crashOffchain(seed, client, nonce));
            expect(onChain).toBeGreaterThanOrEqual(100n); // never below 1.00x
        }
    });

    it('returns 0 for the multiplier before the seed is revealed', async () => {
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit('secret') });
        expect(await fairness.getCrashPoint('client', 0n)).toBe(0n);
    });

    it('only the owner can commit', async () => {
        const res = await fairness.send(stranger.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit('x') });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: fairness.address, success: false });
    });

    const findNonce = (seed: string, client: string, pred: (c: bigint) => boolean) => {
        for (let n = 0; n < 400; n++) if (pred(crashOffchain(seed, client, n))) return n;
        throw new Error('no matching nonce');
    };

    it('pays out a winning bet automatically on reveal', async () => {
        const seed = 'escrow-seed-win', client = 'winner';
        const nonce = findNonce(seed, client, c => c >= 250n); // crash >= 2.5x
        const target = 200n;                                    // bet on 2.0x -> wins

        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });
        await fairness.send(owner.getSender(), { value: toNano('5') }, 'fund'); // bankroll

        await fairness.send(stranger.getSender(), { value: toNano('1') },
            { $$type: 'PlaceBet', target, clientSeed: client, nonce: BigInt(nonce) });
        expect((await fairness.getBetOf(stranger.address))!.target).toBe(target);

        const res = await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: seed });

        // contract sends the payout back to the bettor
        expect(res.transactions).toHaveTransaction({
            from: fairness.address, to: stranger.address, success: true,
        });
        expect(await fairness.getBetOf(stranger.address)).toBeNull(); // cleared
    });

    it('keeps the stake when the bet loses', async () => {
        const seed = 'escrow-seed-lose', client = 'loser';
        const nonce = findNonce(seed, client, c => c >= 101n && c < 170n); // low crash
        const target = 200n;                                               // 2.0x -> loses

        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });
        await fairness.send(owner.getSender(), { value: toNano('5') }, 'fund');
        await fairness.send(stranger.getSender(), { value: toNano('1') },
            { $$type: 'PlaceBet', target, clientSeed: client, nonce: BigInt(nonce) });

        const res = await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: seed });

        expect(res.transactions).not.toHaveTransaction({
            from: fairness.address, to: stranger.address,
        });
    });

    it('rejects a bet once the round is revealed', async () => {
        const seed = 'escrow-late';
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit(seed) });
        await fairness.send(owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Reveal', serverSeed: seed });

        const res = await fairness.send(stranger.getSender(), { value: toNano('1') },
            { $$type: 'PlaceBet', target: 200n, clientSeed: 'x', nonce: 0n });
        expect(res.transactions).toHaveTransaction({
            from: stranger.address, to: fairness.address, success: false,
        });
    });

    it('supports multiple rounds via reset', async () => {
        for (let i = 0; i < 3; i++) {
            const seed = `round-${i}-seed`;
            await fairness.send(owner.getSender(), { value: toNano('0.05') },
                { $$type: 'Reset', commitment: commit(seed) });
            await fairness.send(owner.getSender(), { value: toNano('0.05') },
                { $$type: 'Reveal', serverSeed: seed });
        }
        expect(await fairness.getRoundsPlayed()).toBe(3n);
    });
});

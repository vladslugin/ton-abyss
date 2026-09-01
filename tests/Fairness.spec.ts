import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { Fairness } from '../build/Fairness/Fairness_Fairness';
import '@ton/test-utils';

const commit = (seed: string) => BigInt('0x' + sha256_sync(seed).toString('hex'));

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

    it('only the owner can commit', async () => {
        const res = await fairness.send(stranger.getSender(), { value: toNano('0.05') },
            { $$type: 'Commit', commitment: commit('x') });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: fairness.address, success: false });
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

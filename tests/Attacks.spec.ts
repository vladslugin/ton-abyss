// The attacks that worked on the first version of the contract, run against the
// current one. Each of them now fails.
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { commit, crash, findNonce, payoutFor, setup, open, bet, reveal, closeBetting } from './helpers';

describe('attacks on the first version, now', () => {
    it('the owner cannot replace the commitment after seeing the bets', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        const nonce = findNonce('honest-seed', 'player-1', x => x >= 300n);
        await open(g, 'honest-seed');
        await bet(g, player, 200n, 'player-1', nonce);

        let other = '';
        for (let i = 0; ; i++) { other = `other-${i}`; if (crash(other, 'player-1', nonce) < 200n) break; }
        const swap = await g.game.send(g.owner.getSender(), { value: toNano('0.05') },
            { $$type: 'Open', commitment: commit(other), betWindow: 60n });
        expect(swap.transactions).toHaveTransaction({ to: g.game.address, success: false });
        closeBetting(g);
        expect((await reveal(g, other)).transactions).toHaveTransaction({ to: g.game.address, success: false });
        expect((await reveal(g, 'honest-seed')).transactions)
            .toHaveTransaction({ from: g.game.address, to: player.address, value: payoutFor(toNano('1'), 200n) });
    });

    it('a crowded round still settles: 100 bets', async () => {
        const g = await setup('100');
        await open(g, 'crowded');
        for (let i = 0; i < 100; i++) await bet(g, await g.chain.treasury(`p${i}`), 101n, `c${i}`, 0n, toNano('0.1'));
        closeBetting(g);
        await reveal(g, 'crowded');
        expect(await g.game.getSettledCount()).toBe(100n);
        expect(await g.game.getPhase()).toBe(0n);
    }, 120_000);

    it('a win the bankroll could not cover is never accepted as a bet', async () => {
        const g = await setup('0.6');
        const player = await g.chain.treasury('player');
        await open(g, 'empty-bank');
        expect((await bet(g, player, 1000n, 'lucky', 0n)).transactions)
            .toHaveTransaction({ from: player.address, to: g.game.address, success: false });
    });

    it('a second bet from the same wallet is kept and settled', async () => {
        const g = await setup('20');
        const player = await g.chain.treasury('player');
        await open(g, 'two-bets');
        await bet(g, player, 101n, 'a', findNonce('two-bets', 'a', x => x >= 101n), toNano('5'));
        await bet(g, player, 101n, 'a', findNonce('two-bets', 'a', x => x >= 101n), toNano('1'));
        expect(await g.game.getBetCount()).toBe(2n);
        closeBetting(g);
        const res = await reveal(g, 'two-bets');
        expect(res.transactions).toHaveTransaction({ from: g.game.address, to: player.address, value: payoutFor(toNano('5'), 101n) });
        expect(res.transactions).toHaveTransaction({ from: g.game.address, to: player.address, value: payoutFor(toNano('1'), 101n) });
    });

    it('nobody can bet once the seed may be revealed', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        await open(g, 'race');
        closeBetting(g);
        expect((await bet(g, player, 200n, 'p', 0n)).transactions)
            .toHaveTransaction({ from: player.address, to: g.game.address, success: false });
    });
});

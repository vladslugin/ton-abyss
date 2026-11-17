import { toNano } from '@ton/core';
import '@ton/test-utils';
import {
    E, BET_WINDOW, REVEAL_WINDOW, commit, crash, findNonce, payoutFor, setup, open, bet, reveal, closeBetting,
} from './helpers';

describe('rounds', () => {
    it('commits to sha256(seed) and sets the betting and reveal deadlines', async () => {
        const g = await setup();
        await open(g, 'round-seed');
        expect(await g.game.getCommitment()).toBe(commit('round-seed'));
        expect(await g.game.getRound()).toBe(1n);
        expect(await g.game.getPhase()).toBe(1n);
        expect(await g.game.getBetsCloseAt()).toBe(BigInt(g.chain.now! + BET_WINDOW));
        expect(await g.game.getRevealBy()).toBe(BigInt(g.chain.now! + BET_WINDOW + REVEAL_WINDOW));
    });

    it('only the owner opens a round, and only when none is running', async () => {
        const g = await setup();
        const stranger = await g.chain.treasury('stranger');
        const res = await g.game.send(stranger.getSender(), { value: toNano('0.05') },
            { $$type: 'Open', commitment: commit('x'), betWindow: 60n });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: g.game.address, success: false });
        await open(g, 'first');
        expect((await open(g, 'second')).transactions).toHaveTransaction({ to: g.game.address, success: false });
        expect(await g.game.getCommitment()).toBe(commit('first'));
    });

    it('does not open a round without the float that pays for settlement', async () => {
        const g = await setup('0');
        expect((await open(g, 'seed')).transactions).toHaveTransaction({ to: g.game.address, success: false });
    });

    it('accepts the seed only after betting closes and before the reveal deadline', async () => {
        const g = await setup();
        await open(g, 'timed-seed');
        expect((await reveal(g, 'timed-seed')).transactions).toHaveTransaction({ to: g.game.address, success: false });
        closeBetting(g);
        expect((await reveal(g, 'wrong-seed')).transactions).toHaveTransaction({ to: g.game.address, success: false });
        expect((await reveal(g, 'timed-seed')).transactions).toHaveTransaction({ to: g.game.address, success: true });
        expect(await g.game.getRevealedSeed()).toBe('timed-seed');
        expect(await g.game.getPhase()).toBe(0n);

        await open(g, 'late-seed');
        g.chain.now! += BET_WINDOW + REVEAL_WINDOW;
        expect((await reveal(g, 'late-seed')).transactions).toHaveTransaction({ to: g.game.address, success: false });
    });
});

describe('multiplier', () => {
    it('matches the off-chain formula, also for inputs longer than one cell', async () => {
        // Real seeds are 64 hex characters, so with a 64-byte client seed the hashed
        // string is 140 bytes and spans two cells.
        const seed = 'f'.repeat(30) + '0123456789abcdef'.repeat(2) + 'e'.repeat(2);
        const g = await setup();
        await open(g, seed);
        expect(await g.game.getCrashPoint('client', 0n)).toBe(0n);
        closeBetting(g);
        await reveal(g, seed);
        const longClient = 'c'.repeat(64);
        for (const [client, nonce] of [['client', 0], ['client', 1], ['client', 42], ['client', 4294967295], [longClient, 7]] as const) {
            expect(await g.game.getCrashPoint(client, BigInt(nonce))).toBe(crash(seed, client, nonce));
        }
    });

    it('rejects seeds longer than 64 bytes, and such a round expires', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        await open(g, 's'.repeat(65));
        expect((await bet(g, player, 200n, 'c'.repeat(65), 0n)).transactions)
            .toHaveTransaction({ from: player.address, to: g.game.address, success: false });
        await bet(g, player, 200n, 'c'.repeat(64), 0n);
        closeBetting(g);
        expect((await reveal(g, 's'.repeat(65))).transactions).toHaveTransaction({ to: g.game.address, success: false });
        g.chain.now! += REVEAL_WINDOW;
        const res = await g.game.send(player.getSender(), { value: toNano('0.05') }, 'expire');
        expect(res.transactions).toHaveTransaction({ from: g.game.address, to: player.address, value: payoutFor(toNano('1'), 200n) });
    });

    it('gives every target from 1.01x to 100x the same 1% edge', () => {
        // floor(99E / (E - h)) >= T exactly when h >= E - 99E/T, which holds for floor(99E/T)
        // of the E equally likely values of h. A bet on T returns T/100 times that share.
        for (let target = 101n; target <= 10000n; target += 1n) {
            const share = Number((99n * E) / target) / Number(E);
            const expected = (Number(target) / 100) * share;
            expect(Math.abs(expected - 0.99)).toBeLessThan(1e-12);
        }
    });
});

describe('bets', () => {
    it('pays a winning bet exactly stake × target / 100', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        const nonce = findNonce('win-seed', 'p', x => x >= 250n);
        await open(g, 'win-seed');
        await bet(g, player, 200n, 'p', nonce);
        closeBetting(g);
        const res = await reveal(g, 'win-seed');
        expect(res.transactions).toHaveTransaction({
            from: g.game.address, to: player.address, value: payoutFor(toNano('1'), 200n), success: true,
        });
        expect(await g.game.getReserved()).toBe(0n);
    });

    it('keeps the stake of a losing bet', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        const nonce = findNonce('lose-seed', 'p', x => x < 200n);
        await open(g, 'lose-seed');
        await bet(g, player, 200n, 'p', nonce);
        closeBetting(g);
        const res = await reveal(g, 'lose-seed');
        expect(res.transactions).not.toHaveTransaction({ from: g.game.address, to: player.address });
        expect(await g.game.getReserved()).toBe(0n);
    });

    it('rejects targets outside 1.01x–100x and stakes below the minimum', async () => {
        const g = await setup();
        const player = await g.chain.treasury('player');
        await open(g, 'limits');
        for (const [target, value] of [[100n, toNano('1')], [10001n, toNano('1')], [200n, toNano('0.06')]] as const) {
            expect((await bet(g, player, target, 'p', 0n, value)).transactions)
                .toHaveTransaction({ from: player.address, to: g.game.address, success: false });
        }
        expect(await g.game.getBetCount()).toBe(0n);
    });

    it('rejects a bet the bankroll cannot cover, and accepts it after funding', async () => {
        const g = await setup('1');
        const player = await g.chain.treasury('player');
        await open(g, 'small-bank');
        expect((await bet(g, player, 1000n, 'p', 0n)).transactions)
            .toHaveTransaction({ from: player.address, to: g.game.address, success: false });
        await g.game.send(g.owner.getSender(), { value: toNano('20') }, 'fund');
        expect((await bet(g, player, 1000n, 'p', 0n)).transactions)
            .toHaveTransaction({ from: player.address, to: g.game.address, success: true });
        expect(await g.game.getReserved()).toBe(payoutFor(toNano('1'), 1000n));
    });
});

describe('settlement', () => {
    it('settles 200 bets in batches of 25 and pays every winner', async () => {
        const g = await setup('500');
        const seed = 'a'.repeat(64);                    // the longest inputs, so the gas is the worst case
        await open(g, seed);
        const players = [];
        for (let i = 0; i < 200; i++) {
            const player = await g.chain.treasury(`player-${i}`);
            const target = BigInt(101 + (i % 7) * 50);
            const client = `${i}`.padStart(64, 'c');
            await bet(g, player, target, client, BigInt(4_000_000_000 + i), toNano('0.5'));
            players.push({ player, target, client, nonce: BigInt(4_000_000_000 + i) });
        }
        closeBetting(g);
        const before = (await g.chain.getContract(g.game.address)).balance;
        const res = await reveal(g, seed);

        let paid = 0n;
        for (const p of players) {
            const wins = crash(seed, p.client, p.nonce) >= p.target;
            const payout = payoutFor(toNano('0.5'), p.target);
            if (wins) {
                expect(res.transactions).toHaveTransaction({ from: g.game.address, to: p.player.address, value: payout });
                paid += payout;
            } else {
                expect(res.transactions).not.toHaveTransaction({ from: g.game.address, to: p.player.address });
            }
        }
        const batches = res.transactions.filter(t =>
            t.inMessage?.info.src?.toString() === g.game.address.toString() && t.inMessage?.info.dest?.toString() === g.game.address.toString());
        expect(batches.length).toBe(8);
        const maxGas = Math.max(...batches.map(t => Number((t.description as any).computePhase.gasUsed)));
        expect(maxGas).toBeLessThan(600_000);   // the limit of one transaction is 1,000,000
        expect(await g.game.getPhase()).toBe(0n);
        expect(await g.game.getSettledCount()).toBe(200n);
        expect(await g.game.getReserved()).toBe(0n);
        const fees = before - (await g.chain.getContract(g.game.address)).balance - paid;
        expect(fees / 200n).toBeLessThan(toNano('0.02'));   // the gas reserve kept from each bet covers it
    }, 300_000);

    it('pays every bet as a win when the owner does not reveal in time', async () => {
        const g = await setup();
        const a = await g.chain.treasury('a'), b = await g.chain.treasury('b');
        const stranger = await g.chain.treasury('stranger');
        await open(g, 'withheld');
        await bet(g, a, 150n, 'a', 0n);
        await bet(g, b, 300n, 'b', 0n);
        closeBetting(g);
        expect((await g.game.send(stranger.getSender(), { value: toNano('0.05') }, 'expire')).transactions)
            .toHaveTransaction({ to: g.game.address, success: false });   // too early
        g.chain.now! += REVEAL_WINDOW;
        const res = await g.game.send(stranger.getSender(), { value: toNano('0.05') }, 'expire');
        expect(res.transactions).toHaveTransaction({ from: g.game.address, to: a.address, value: payoutFor(toNano('1'), 150n) });
        expect(res.transactions).toHaveTransaction({ from: g.game.address, to: b.address, value: payoutFor(toNano('1'), 300n) });
        expect(await g.game.getExpired()).toBe(true);
        expect((await reveal(g, 'withheld')).transactions).toHaveTransaction({ to: g.game.address, success: false });
    });
});

describe('owner', () => {
    it('withdraws only between rounds and never below the float', async () => {
        const g = await setup('10');
        await open(g, 'busy');
        const busy = await g.game.send(g.owner.getSender(), { value: toNano('0.05') }, { $$type: 'Withdraw', amount: toNano('1') });
        expect(busy.transactions).toHaveTransaction({ to: g.game.address, success: false });
        closeBetting(g);
        await reveal(g, 'busy');
        const all = await g.game.send(g.owner.getSender(), { value: toNano('0.05') }, { $$type: 'Withdraw', amount: toNano('10') });
        expect(all.transactions).toHaveTransaction({ to: g.game.address, success: false });
        const some = await g.game.send(g.owner.getSender(), { value: toNano('0.05') }, { $$type: 'Withdraw', amount: toNano('9') });
        expect(some.transactions).toHaveTransaction({ from: g.game.address, to: g.owner.address, value: toNano('9') });
    });
});

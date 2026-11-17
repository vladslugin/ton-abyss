import { toNano } from '@ton/core';
import { Fairness } from '../build/Fairness/Fairness_Fairness';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address!;
    const fairness = provider.open(await Fairness.fromInit(owner));

    await fairness.send(
        provider.sender(),
        { value: toNano('0.05') },
        { $$type: 'Deploy', queryId: 0n },
    );

    await provider.waitForDeploy(fairness.address);

    console.log('Fairness deployed at', fairness.address.toString());
    console.log('owner ', (await fairness.getOwner()).toString());
    console.log('round ', await fairness.getRound());
    console.log('Send "fund" with at least 0.6 TON before the first Open.');
}

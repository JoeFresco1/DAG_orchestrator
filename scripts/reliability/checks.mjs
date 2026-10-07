import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, sourceIdentity } from './contracts.mjs';
import { marker } from './protocol.mjs';
import { atomic } from './ledger.mjs';
/** Cache only deterministic checks, bound to sources, environment and contract. */
export async function checked(command, { cfg, revision, cwd, directory, execute }) {
    const source = sourceIdentity(cwd, cfg);
    let key, path;
    if (cfg.policy.reuseChecks) {
        if (!cfg.commands.environment)
            throw Error('Check reuse requires an environment fingerprint adapter');
        const environment = await execute(cfg.commands.environment), packet = marker(environment.output, 'DAG_ENVIRONMENT');
        if (environment.code !== 0 || !packet || !/^[a-f0-9]{64}$/.test(packet.digest || ''))
            throw Error('Environment fingerprint unavailable');
        key = hash({ source, revision, command, environment: packet.digest, processEnvironment: hash(Object.entries(process.env).filter(([key]) => key !== 'DAG_CONTROLLER_TOKEN').sort(([a], [b]) => a.localeCompare(b))) });
        mkdirSync(join(directory, 'checks'), { recursive: true });
        path = join(directory, 'checks', key + '.json');
        if (existsSync(path)) {
            const receipt = JSON.parse(readFileSync(path, 'utf8'));
            if (receipt.key === key && receipt.code === 0 && receipt.source === source && receipt.revision === revision)
                return { ...receipt, reused: true };
        }
    }
    const result = await execute(command), receipt = { ...result, key: key || null, source, revision, reused: false, at: Date.now() };
    if (path && result.code === 0 && sourceIdentity(cwd, cfg) === source)
        atomic(path, receipt);
    return receipt;
}

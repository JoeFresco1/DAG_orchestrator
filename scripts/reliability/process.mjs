import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { command } from './contracts.mjs';
export function processTable() {
    if (process.platform === 'win32') {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="birth";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        if (r.status !== 0)
            throw new Error('Cannot verify process ownership');
        return [JSON.parse(r.stdout)].flat().map(x => ({ pid: x.ProcessId, parent: x.ParentProcessId, birth: x.birth }));
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0)
        throw new Error('Cannot verify process ownership');
    return r.stdout.trim().split('\n').map(line => { const parts = line.trim().split(/\s+/); return { pid: Number(parts.shift()), parent: Number(parts.shift()), birth: parts.join(' ') }; });
}
export function identity(pid) { return processTable().find(p => p.pid === pid) || null; }
export function sameProcess(owner, table = processTable()) { return !!owner && table.some(p => p.pid === owner.pid && p.birth === owner.birth); }
export function terminateOwned(owners) {
    const table = processTable();
    for (const owner of [...owners].reverse()) {
        if (!sameProcess(owner, table))
            continue;
        if (process.platform === 'win32')
            spawnSync('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        else
            try {
                process.kill(owner.pid, 'SIGKILL');
            }
            catch { }
    }
}
export function descendants(root, table = processTable()) {
    if (!sameProcess(root, table))
        return [];
    const out = [root], known = new Set([root.pid]);
    for (let changed = true; changed;) {
        changed = false;
        for (const p of table)
            if (!known.has(p.pid) && known.has(p.parent)) {
                known.add(p.pid);
                out.push(p);
                changed = true;
            }
    }
    return out;
}
export function runCommand(spec, { cwd, deadline = Infinity, env = {}, tokens = {}, logPath, onStart, onProgress, onFinish, signal } = {}) {
    command(spec);
    const timeoutMs = Math.min(spec.timeoutMs, deadline - Date.now());
    if (timeoutMs <= 0)
        throw Object.assign(new Error('Durable wall budget exhausted'), { failure: { version: 1, code: 'budget', stage: spec.stage || 'command', evidence: ['Original run deadline reached'] } });
    const expand = s => s.replace(/\{([A-Za-z]+)\}/g, (all, key) => Object.hasOwn(tokens, key) ? String(tokens[key]) : all);
    const program = expand(spec.program), args = spec.args.map(expand);
    let output = '', ended = false;
    return new Promise((accept, reject) => {
        const childEnv = { ...process.env, ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(program, args, { cwd, env: childEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let owners = [], timer, poll, drain, startedAt = Date.now();
        const notify = () => { try {
            const root = identity(child.pid);
            if (root) {
                const observed = descendants(root);
                owners = [...new Map([...owners, ...observed].map(p => [`${p.pid}:${p.birth}`, p])).values()];
                onStart?.({ owners, program, args, startedAt, deadline: startedAt + timeoutMs });
            }
        }
        catch (e) {
            settle(null, e);
        } };
        const release = () => { clearTimeout(timer); clearInterval(poll); clearTimeout(drain); signal?.removeEventListener('abort', abort); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); };
        const settle = (code, error) => {
            if (ended)
                return;
            ended = true;
            release();
            if (error)
                try {
                    child.kill();
                }
                catch { }
            try {
                terminateOwned(owners.filter(p => p.pid !== child.pid));
                onFinish?.({ code, endedAt: Date.now(), program, args });
            }
            catch (e) {
                error ??= e;
            }
            if (error)
                reject(error);
            else
                accept({ code, output, program, args, elapsedMs: Date.now() - startedAt });
        };
        const abort = () => { try {
            terminateOwned(owners);
        }
        catch { } child.kill(); settle(null, Object.assign(new Error('Controller stopped by operator'), { failure: { version: 1, code: 'user_stop', stage: spec.stage || 'command', evidence: ['Explicit stop signal'] } })); };
        const collect = bytes => { const text = bytes.toString(); output = (output + text).slice(-8 * 1024 * 1024); if (logPath)
            appendFileSync(logPath, text); if (!/rmcp|codex_mcp|MCP.*(?:reconnect|initializ|retry)/i.test(text))
            onProgress?.({ at: Date.now(), bytes: bytes.length }); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('spawn', () => { notify(); if (ended)
            return; poll = setInterval(notify, 2000); poll.unref(); });
        child.once('error', e => settle(null, Object.assign(e, { failure: { version: 1, code: 'environment', stage: spec.stage || 'spawn', evidence: [e.message] } })));
        child.once('exit', (code) => { drain = setTimeout(() => settle(code), 150); });
        child.once('close', code => settle(code));
        timer = setTimeout(() => { try {
            terminateOwned(owners);
        }
        catch { } child.kill(); settle(null, Object.assign(new Error(`Stage deadline exceeded (${timeoutMs}ms)`), { failure: { version: 1, code: 'environment', stage: spec.stage || 'command', evidence: ['Owned command exceeded stage deadline'] } })); }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
    });
}

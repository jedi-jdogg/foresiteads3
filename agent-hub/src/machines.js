// The Macs as workers. Discovery comes from Tailscale (`tailscale status --json`), control goes over SSH with
// a key the hub generates, and every action an agent can run is one of a short allowlist. Jobs run in the
// background on the worker and their output is collected into logs/jobs/.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url);
export const MACHINES_PATH = new URL('machines.json', ROOT);            // per-install registry (gitignored)
export const ACTIONS_PATH = new URL('actions.json', ROOT);              // the allowlist (committed)
const JOBS_DIR = new URL('logs/jobs/', ROOT);
const KEY_PATH = join(homedir(), '.ssh', 'agent-hub_ed25519');

const TAILSCALE_BIN = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'];

export class Machines {
  constructor({ exec = run, sshBin = 'ssh' } = {}) {
    this.exec = exec;
    this.sshBin = sshBin;
    this.jobs = new Map();
  }

  // ── registry ──
  async list() {
    try { this.cached = JSON.parse(await readFile(MACHINES_PATH, 'utf8')); } catch { this.cached = []; }
    return this.cached;
  }
  async save(list) { this.cached = list; await writeFile(MACHINES_PATH, JSON.stringify(list, null, 2) + '\n'); }

  // The Macs as agents: one per registered Mac plus "any free Mac". Online state comes from the last overview().
  agents() {
    const online = this.online ?? new Map();
    const macs = (this.cached ?? []).map((m) => ({
      id: `mac:${m.id}`, name: `${m.name} (Claude Code)`, vendor: 'your Mac', provider: 'worker', machine: m.id, tools: false, council: false,
      role: `Does hands-on work on ${m.name}${m.note ? `: ${m.note}` : ''}. Files, browser, exports, scripts, anything Claude Code can do there. Runs on your Claude subscription.`,
      callable: online.get(m.id) === true, verified: online.get(m.id) === true ? true : null, keyEnv: null, missing: online.get(m.id) === true ? null : 'offline',
    }));
    const free = macs.find((a) => a.callable && !(this.busy?.get(a.machine)));
    macs.push({ id: 'mac:any', name: 'Any free Mac (Claude Code)', vendor: 'your Macs', provider: 'worker', machine: free?.machine ?? null, tools: false, council: false,
      role: 'Hands-on work on whichever Mac is online and idle: create or edit files, work in a browser, run scripts, export data. Runs on your Claude subscription.',
      callable: Boolean(free), verified: free ? true : null, keyEnv: null, missing: free ? null : (this.cached?.length ? 'no Mac is online' : 'no Macs registered') });
    return macs;
  }

  // Run a Claude Code task and wait for it (for use as an agent answer).
  async runAndWait(machineId, prompt, { timeoutMs = 15 * 60 * 1000 } = {}) {
    const r = await this.runAction(machineId, 'claude', { prompt });
    if (!r.ok) throw new Error(r.error);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const j = this.jobs.get(r.job);
      if (j.status !== 'running') {
        if (j.status === 'done') return { text: j.output.trim() || '(finished with no output)', job: r.job };
        throw new Error(`${j.status === 'timeout' ? 'The task ran out of time' : 'The task failed'} on that Mac${j.output ? `: ${j.output.trim().slice(-800)}` : ''}`);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error('Still running after the wait limit; check it in the Machines tab under Jobs.');
  }
  async register({ id, host, user, name, note, registeredBy }) {
    if (!host) throw new Error("Missing the Mac's Tailscale name.");
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user ?? '')) throw new Error('Enter the Mac login name (the short user name on that Mac; Terminal → whoami shows it).');
    id = (id || host.split('.')[0]).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 31) || 'mac';
    const list = await this.list();
    const i = list.findIndex((m) => m.id === id || m.host.toLowerCase() === host.toLowerCase());
    const entry = { id: list[i]?.id ?? id, host, user, name: name || list[i]?.name || prettyName(host), note: note ?? list[i]?.note ?? '', addedAt: list[i]?.addedAt ?? new Date().toISOString(), registeredBy: registeredBy ?? list[i]?.registeredBy ?? 'hub' };
    if (i >= 0) list[i] = entry; else list.push(entry);
    await this.save(list);
    return entry;
  }
  async remove(id) { await this.save((await this.list()).filter((m) => m.id !== id)); }

  async actions() {
    return JSON.parse(await readFile(ACTIONS_PATH, 'utf8')).actions;
  }

  // ── tailscale ──
  async tailscale() {
    for (const bin of TAILSCALE_BIN) {
      try {
        const { stdout } = await this.exec(bin, ['status', '--json']);
        const st = JSON.parse(stdout);
        const peer = (p) => ({ host: (p.DNSName ?? '').replace(/\.$/, ''), name: p.HostName, online: Boolean(p.Online), os: p.OS, ip: p.TailscaleIPs?.[0], lastSeen: p.LastSeen });
        return { ok: true, self: peer(st.Self), peers: Object.values(st.Peer ?? {}).map(peer).filter((p) => p.os === 'macOS') };
      } catch (err) { if (bin === TAILSCALE_BIN.at(-1)) return { ok: false, error: 'Tailscale is not installed on this computer, or not signed in.', self: null, peers: [] }; }
    }
  }

  // Registered Macs merged with what Tailscale sees, plus Tailscale Macs not yet registered.
  async overview() {
    const [list, ts] = await Promise.all([this.list(), this.tailscale()]);
    const workerUrl = this.workerUrl ?? null;
    const byHost = new Map(ts.peers.map((p) => [p.host.toLowerCase(), p]));
    const short = (h) => h.toLowerCase().split('.')[0];
    const machines = list.map((m) => {
      const p = byHost.get(m.host.toLowerCase()) ?? ts.peers.find((x) => short(x.host) === short(m.host));
      return { ...m, online: p?.online ?? null, ip: p?.ip, lastSeen: p?.lastSeen, tailscale: Boolean(p), running: [...this.jobs.values()].filter((j) => j.machine === m.id && j.status === 'running').length };
    });
    this.online = new Map(machines.map((m) => [m.id, m.online === true]));
    this.busy = new Map(machines.map((m) => [m.id, m.running > 0]));
    const known = new Set(list.map((m) => short(m.host)));
    const unregistered = ts.peers.filter((p) => !known.has(short(p.host)) && p.host !== ts.self?.host);
    return { tailscale: ts.ok, tailscaleError: ts.error, self: ts.self, machines, unregistered, workerUrl };
  }

  // ── ssh ──
  async ensureKey() {
    if (!existsSync(KEY_PATH)) {
      await mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
      await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'agent-hub', '-f', KEY_PATH]);
    }
    return (await readFile(KEY_PATH + '.pub', 'utf8')).trim();
  }

  sshArgs(m, command) {
    return ['-i', KEY_PATH, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=accept-new', `${m.user}@${m.host}`, command];
  }

  async ssh(m, command, { timeoutMs = 30000 } = {}) {
    const { stdout, stderr } = await this.exec(this.sshBin, this.sshArgs(m, command), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async machine(id) {
    const m = (await this.list()).find((x) => x.id === id);
    if (!m) throw new Error(`No machine "${id}". Registered: ${(await this.list()).map((x) => x.id).join(', ') || 'none'}`);
    return m;
  }

  // Quick health: reachable, uptime, load, disk, whether Claude Code is installed and signed in.
  async status(id) {
    const m = await this.machine(id);
    const started = Date.now();
    try {
      const { stdout } = await this.ssh(m, 'uptime; df -h / | tail -1; sw_vers -productVersion; (command -v claude >/dev/null && claude --version) || echo "claude: not installed"; ls ~/agent-hub-jobs 2>/dev/null | head -20', { timeoutMs: 15000 });
      const [uptime, disk, macos, claude, ...scripts] = stdout.split('\n');
      return { id, ok: true, ms: Date.now() - started, uptime, disk, macos, claude, scripts: scripts.filter(Boolean) };
    } catch (err) {
      return { id, ok: false, ms: Date.now() - started, error: sshError(err) };
    }
  }

  // Build the exact remote command for an allowlisted action, or refuse.
  async command(actionId, args = {}) {
    const action = (await this.actions()).find((a) => a.id === actionId);
    if (!action) throw new Error(`Action "${actionId}" is not on the allowlist (actions.json).`);
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    switch (action.kind) {
      case 'shell': return { action, cmd: action.command, async: false };
      case 'open-url': {
        if (!/^https?:\/\/[^\s'"]+$/i.test(args.url ?? '')) throw new Error('open-url needs an http(s) URL.');
        return { action, cmd: `open ${q(args.url)}`, async: false };
      }
      case 'script': {
        if (!/^[a-zA-Z0-9_.-]+$/.test(args.name ?? '')) throw new Error('script needs a file name from ~/agent-hub-jobs (letters, digits, dash, dot).');
        return { action, cmd: `cd ~/agent-hub-jobs && test -f ${q(args.name)} && bash ${q(args.name)}`, async: true };
      }
      case 'claude': {
        if (!args.prompt?.trim()) throw new Error('claude needs a prompt.');
        // Headless Claude Code on the worker, using that Mac's own Claude login. Works inside ~/agent-hub-jobs/work.
        return { action, cmd: `mkdir -p ~/agent-hub-jobs/work && cd ~/agent-hub-jobs/work && export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && claude -p ${q(args.prompt)} --output-format text ${action.flags ?? ''}`, async: true };
      }
      default: throw new Error(`Unknown action kind "${action.kind}".`);
    }
  }

  // Run an action. Short ones return their output; long ones (scripts, Claude tasks) return a job id to poll.
  async runAction(id, actionId, args = {}) {
    const m = await this.machine(id);
    const { action, cmd, async } = await this.command(actionId, args);
    if (!async) {
      const started = Date.now();
      try {
        const out = await this.ssh(m, cmd, { timeoutMs: (action.timeoutSec ?? 30) * 1000 });
        return { machine: id, action: actionId, ok: true, ms: Date.now() - started, output: (out.stdout || out.stderr).slice(0, 20000) };
      } catch (err) { return { machine: id, action: actionId, ok: false, ms: Date.now() - started, error: sshError(err) }; }
    }
    const job = { id: randomBytes(4).toString('hex'), machine: id, action: actionId, args, status: 'running', startedAt: new Date().toISOString(), output: '' };
    this.jobs.set(job.id, job);
    await mkdir(JOBS_DIR, { recursive: true });
    const log = new URL(`${job.id}.log`, JOBS_DIR);
    const child = spawn(this.sshBin, this.sshArgs(m, cmd));
    const sink = (chunk) => { job.output = (job.output + chunk).slice(-40000); appendFile(log, chunk).catch(() => {}); };
    child.stdout.on('data', sink); child.stderr.on('data', sink);
    const timer = setTimeout(() => { child.kill('SIGTERM'); job.status = 'timeout'; }, (action.timeoutSec ?? 900) * 1000);
    child.on('close', (code) => { clearTimeout(timer); if (job.status === 'running') job.status = code === 0 ? 'done' : 'failed'; job.exitCode = code; job.endedAt = new Date().toISOString(); });
    child.on('error', (err) => { clearTimeout(timer); job.status = 'failed'; job.output += `\n${sshError(err)}`; job.endedAt = new Date().toISOString(); });
    return { machine: id, action: actionId, ok: true, job: job.id, status: 'running', note: 'Running in the background. Check it with machines__job.' };
  }

  job(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`No job ${jobId} in this hub session.`);
    return { ...j, output: j.output.slice(-20000) };
  }

  recentJobs(limit = 30) {
    return [...this.jobs.values()].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1)).slice(0, limit).map((j) => ({ ...j, output: j.output.slice(-600) }));
  }

  // The paste-once script that prepares a worker Mac. Carries the hub's public key so no copying is needed.
  async setupScript({ hubHost, pubkey, hubUser, bare = false }) {
    const template = await readFile(new URL('../worker/setup-worker.sh', import.meta.url), 'utf8');
    const body = template.replace('__HUB_PUBKEY__', pubkey).replace(/__HUB_HOST__/g, hubHost ?? '').replace(/__HUB_USER__/g, hubUser ?? '').replace(/__HUB_PORT__/g, String(this.port ?? 4747));
    if (bare) return body;   // fetched by curl and piped to bash: no wrapper needed
    // Wrapped so the user's interactive shell (zsh) hands the whole text to bash untouched: no history
    // expansion on "!", no line-by-line execution. Same shape as the installer.
    return `bash <<'HUB_SETUP'\n${body.replace(/^#!.*\n/, '')}\nHUB_SETUP\n`;
  }
}

function prettyName(host) {
  return host.split('.')[0].replace(/-\d+$/, '').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ').replace(/^Jonathans /, "Jonathan's ");
}

function sshError(err) {
  const m = `${err.stderr ?? ''} ${err.message ?? ''}`;
  if (/Permission denied/i.test(m)) return 'SSH refused the key. Run the setup script on that Mac so it trusts the hub.';
  if (/Connection refused/i.test(m)) return 'Remote Login is off on that Mac (System Settings → General → Sharing → Remote Login).';
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(m)) return 'Could not find that Mac on Tailscale. Check the host name and that Tailscale is running on both.';
  if (/timed out|Operation timed out|ETIMEDOUT/i.test(m)) return 'That Mac did not answer (asleep, offline, or Tailscale off).';
  return m.trim().slice(0, 300) || 'SSH failed.';
}

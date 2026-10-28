import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machines } from '../src/machines.js';
import { tools as machineTools } from '../src/sources/machines.js';

// Stand-in `ssh`: echoes the remote command so tests can see exactly what would run, and fails for mac-down.
const fakeSsh = join(await mkdtemp(join(tmpdir(), 'hub-ssh-')), 'ssh');
await writeFile(fakeSsh, `#!/bin/bash
host="\${@: -2:1}"; cmd="\${@: -1}"
case "$host" in *mac-down*) echo "ssh: connect to host mac-down port 22: Connection refused" >&2; exit 255;; esac
echo "[$host] $cmd"
`, { mode: 0o755 });

// Stand-in tailscale status.
const tsJson = JSON.stringify({ Self: { DNSName: 'hub.tail.ts.net.', HostName: 'hub', Online: true, OS: 'macOS', TailscaleIPs: ['100.1.1.1'] },
  Peer: { a: { DNSName: 'mac-1.tail.ts.net.', HostName: 'mac-1', Online: true, OS: 'macOS', TailscaleIPs: ['100.1.1.2'] },
          b: { DNSName: 'mac-4.tail.ts.net.', HostName: 'mac-4', Online: false, OS: 'macOS', TailscaleIPs: ['100.1.1.5'] },
          c: { DNSName: 'phone.tail.ts.net.', HostName: 'phone', Online: true, OS: 'iOS' } } });
const fakeExec = async (bin, args, opts) => {
  if (/tailscale/i.test(bin)) return { stdout: tsJson, stderr: '' };
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(bin, args, opts);
};

// Keep the registry in a temp file for the test run.
const { MACHINES_PATH } = await import('../src/machines.js');
const realRegistry = await readFile(MACHINES_PATH, 'utf8').catch(() => null);
const M = new Machines({ exec: fakeExec, sshBin: fakeSsh });
await M.save([]);
after(async () => { if (realRegistry === null) await M.save([]); else await writeFile(MACHINES_PATH, realRegistry); });

test('register validates ids and merges with Tailscale', async () => {
  await assert.rejects(M.register({ host: 'x.tail.ts.net', user: '' }), /login name/);
  // Id and name derive from the Tailscale host when not given; re-registering the same host updates in place.
  const auto = await M.register({ host: 'jonathans-mac-mini-1.tail.ts.net', user: 'jonathan' });
  assert.equal(auto.id, 'jonathans-mac-mini-1');
  assert.equal(auto.name, "Jonathan's Mac Mini");
  await M.register({ host: 'jonathans-mac-mini-1.tail.ts.net', user: 'jonathan', note: 'spare' });
  assert.equal((await M.list()).filter((m) => m.host.startsWith('jonathans')).length, 1);
  await M.remove('jonathans-mac-mini-1');
  await M.register({ id: 'mac-1', host: 'mac-1.tail.ts.net', user: 'jonathan', name: 'Mac 1', note: 'Shopify signed in' });
  await M.register({ id: 'mac-down', host: 'mac-down.tail.ts.net', user: 'jonathan' });
  const o = await M.overview();
  assert.equal(o.tailscale, true);
  assert.equal(o.machines.find((m) => m.id === 'mac-1').online, true);
  assert.equal(o.machines.find((m) => m.id === 'mac-down').online, null);   // registered but not on tailscale
  assert.deepEqual(o.unregistered.map((p) => p.name), ['mac-4']);           // phone is not macOS; hub is self
});

test('only allowlisted actions build commands, and arguments are checked', async () => {
  await assert.rejects(M.command('rm-rf'), /not on the allowlist/);
  await assert.rejects(M.command('open-url', { url: 'file:///etc/passwd' }), /http\(s\) URL/);
  await assert.rejects(M.command('script', { name: '../../.ssh/id_rsa' }), /letters, digits/);
  await assert.rejects(M.command('open-url', { url: "https://x.com/a'b" }), /http\(s\) URL/);
  const open = await M.command('open-url', { url: 'https://admin.shopify.com/store/lindas?x=1&y=2' });
  assert.equal(open.cmd, `open 'https://admin.shopify.com/store/lindas?x=1&y=2'`);
  const c = await M.command('claude', { prompt: 'Export last month to CSV' });
  assert.match(c.cmd, /claude -p 'Export last month to CSV' --output-format text --permission-mode acceptEdits/);
  assert.equal(c.async, true);
});

test('short actions run over ssh and return output; failures read as next steps', async () => {
  const ok = await M.runAction('mac-1', 'status');
  assert.equal(ok.ok, true);
  assert.match(ok.output, /^\[jonathan@mac-1\.tail\.ts\.net\] uptime;/);
  const down = await M.runAction('mac-down', 'status');
  assert.equal(down.ok, false);
  assert.match(down.error, /Remote Login is off/);
});

test('long actions become background jobs that finish with their output', async () => {
  const r = await M.runAction('mac-1', 'claude', { prompt: 'say hi' });
  assert.equal(r.status, 'running');
  await new Promise((res) => setTimeout(res, 400));
  const j = M.job(r.job);
  assert.equal(j.status, 'done');
  assert.match(j.output, /claude -p 'say hi'/);
  assert.equal(M.recentJobs()[0].id, r.job);
});

test('agent tools expose list/run/job with the allowlist as an enum', async () => {
  const tools = await machineTools({}, { machines: M });
  assert.deepEqual(tools.map((t) => t.name), ['list', 'run', 'job']);
  const run = tools.find((t) => t.name === 'run');
  assert.deepEqual(run.input_schema.properties.action.enum, ['status', 'whoami', 'open-url', 'script', 'claude']);
  const list = await tools[0].run({});
  assert.ok(list.some((m) => m.id === 'mac-1' && m.online === true));
});

test('the setup script carries the hub key and leaves no placeholders', async () => {
  const text = await M.setupScript({ hubHost: 'hub.tail.ts.net', pubkey: 'ssh-ed25519 AAAATEST agent-hub', hubUser: 'jonathan' });
  assert.match(text, /^bash <<'HUB_SETUP'\n/);
  assert.match(text, /\nHUB_SETUP\n$/);
  assert.ok(!/^#!/m.test(text));
  assert.match(text, /HUB_PUBKEY='ssh-ed25519 AAAATEST agent-hub'/);
  assert.ok(!/__HUB_/.test(text));
  assert.match(text, /http:\/\/hub\.tail\.ts\.net:4747\/register/);
  assert.match(text, /systemsetup -setremotelogin on/);
  assert.match(text, /authorized_keys/);
});

test('a Mac acts as an agent: the task runs through Claude Code there and the summary comes back', async () => {
  await M.overview();
  const agents = M.agents();
  const mac1 = agents.find((a) => a.id === 'mac:mac-1');
  assert.equal(mac1.callable, true);
  assert.equal(agents.find((a) => a.id === 'mac:mac-down').callable, false);
  assert.equal(agents.find((a) => a.id === 'mac:any').machine, 'mac-1');
  const out = await M.runAndWait('mac-1', 'Make a hello.txt');
  assert.match(out.text, /claude -p 'Make a hello.txt' --output-format text --permission-mode acceptEdits --allowedTools/);
});

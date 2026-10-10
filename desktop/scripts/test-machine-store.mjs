// Unit tests for src/main/machine-store.ts: token encryption round-trip,
// legacy plaintext migration, the plaintext fallback when OS encryption is
// unavailable, corrupt-file backup, entry validation and 0600 permissions.
//
// The store has no Electron imports; safeStorage is replaced by a fake
// reversible cipher. Runs through esbuild; no test framework.
import { build } from 'esbuild';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), 'vr-machine-store-'));
const bundle = join(dir, 'machine-store.mjs');
await build({
  entryPoints: ['src/main/machine-store.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const { MachineStore, validateMachine, validateMachines } = await import(bundle);

// Fake safeStorage: reversible, and visibly not plaintext on disk.
const fakeCrypto = (available = true) => ({
  isAvailable: () => available,
  encrypt: (plain) => Buffer.from('ENC:' + [...plain].reverse().join(''), 'utf-8'),
  decrypt: (buf) => {
    const s = buf.toString('utf-8');
    if (!s.startsWith('ENC:')) throw new Error('bad ciphertext');
    return [...s.slice(4)].reverse().join('');
  },
});

let caseNo = 0;
const newStore = (opts = {}) => {
  const caseDir = mkdtempSync(join(dir, `case-${++caseNo}-`));
  const warnings = [];
  const store = new MachineStore({
    path: join(caseDir, 'machines.json'),
    crypto: fakeCrypto(opts.encryption ?? true),
    warn: (m) => warnings.push(m),
  });
  return { store, file: join(caseDir, 'machines.json'), caseDir, warnings };
};
const mode = (p) => statSync(p).mode & 0o777;
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const machine = { name: 'dev', addr: '100.64.0.1', port: 8765, token: 'secret-token-123' };

// --- Encrypt round-trip ---
{
  const { store, file, caseDir } = newStore();
  store.save([machine]);
  const raw = readFileSync(file, 'utf-8');
  if (raw.includes(machine.token)) fail('plaintext token written to disk while encryption is available');
  const [rec] = readJSON(file);
  if (rec.token !== undefined) fail('encrypted record still carries a plaintext token field');
  if (typeof rec.tokenEnc !== 'string') fail('record has no tokenEnc');
  if (Buffer.from(rec.tokenEnc, 'base64').toString('utf-8') !== 'ENC:' + [...machine.token].reverse().join('')) {
    fail('tokenEnc is not base64 of the encrypted token');
  }
  if (mode(file) !== 0o600) fail(`new file mode ${mode(file).toString(8)}, want 600`);
  const loaded = store.load();
  if (JSON.stringify(loaded) !== JSON.stringify([machine])) fail('round-trip mismatch: ' + JSON.stringify(loaded));
  const leftovers = readdirSync(caseDir).filter((f) => f !== 'machines.json');
  if (leftovers.length) fail('atomic write left files behind: ' + leftovers.join(', '));
}

// --- Existing 0644 file is tightened on write and on startup ---
{
  const { store, file } = newStore();
  writeFileSync(file, JSON.stringify([machine]), { mode: 0o644 });
  chmodSync(file, 0o644);
  store.tightenPermissions();
  if (mode(file) !== 0o600) fail(`tightenPermissions left mode ${mode(file).toString(8)}`);
  chmodSync(file, 0o644);
  store.save([machine]);
  if (mode(file) !== 0o600) fail(`save over a 0644 file left mode ${mode(file).toString(8)}`);
}

// --- Legacy plaintext migration ---
{
  const { store, file } = newStore();
  writeFileSync(file, JSON.stringify([machine], null, 2));
  const loaded = store.load();
  if (loaded[0]?.token !== machine.token) fail('legacy plaintext token not read');
  // Loading already migrates: a user who never opens the machine manager must
  // not keep a plaintext token on disk indefinitely.
  const [rec] = readJSON(file);
  if (rec.token !== undefined || typeof rec.tokenEnc !== 'string') fail('load did not migrate legacy token to tokenEnc');
  if (readFileSync(file, 'utf-8').includes(machine.token)) fail('plaintext token still on disk after migration');
  if (mode(file) !== 0o600) fail('migrated file is not 0600');
  if (store.load()[0].token !== machine.token) fail('migrated token does not decrypt back');
}

// --- Legacy plaintext stays readable (and untouched) without encryption ---
{
  const { store, file } = newStore({ encryption: false });
  const original = JSON.stringify([machine], null, 2);
  writeFileSync(file, original);
  if (store.load()[0]?.token !== machine.token) fail('legacy token not read without encryption');
  if (readFileSync(file, 'utf-8') !== original) fail('load rewrote the file although it could not encrypt');
}

// --- Fallback when encryption is unavailable ---
{
  const { store, file, warnings } = newStore({ encryption: false });
  store.save([machine]);
  store.save([machine]);
  const [rec] = readJSON(file);
  if (rec.token !== machine.token || rec.tokenEnc !== undefined) fail('fallback did not store a plaintext token');
  if (warnings.length !== 1 || !/plaintext/i.test(warnings[0])) {
    fail('fallback should warn exactly once, got ' + JSON.stringify(warnings));
  }
  if (mode(file) !== 0o600) fail('fallback file is not 0600');
  if (store.load()[0].token !== machine.token) fail('fallback token not read back');
}

// --- Encrypted file but encryption now unavailable: error, not data loss ---
{
  const { store, file } = newStore();
  store.save([machine]);
  const before = readFileSync(file, 'utf-8');
  const locked = new MachineStore({ path: file, crypto: fakeCrypto(false), warn: () => {} });
  let threw = false;
  try { locked.load(); } catch { threw = true; }
  if (!threw) fail('loading tokenEnc without encryption should throw');
  if (readFileSync(file, 'utf-8') !== before || existsSync(file + '.bak')) {
    fail('an undecryptable file must be left in place, not treated as corrupt');
  }
}

// --- Corrupt or non-array file → .bak + empty list ---
for (const [label, contents] of [
  ['invalid JSON', '{not json'],
  ['non-array', JSON.stringify({ name: 'dev' })],
  ['invalid entry', JSON.stringify([{ name: 'dev', addr: '', port: 8765, token: 't' }])],
]) {
  const { store, file, warnings } = newStore();
  writeFileSync(file, contents);
  const loaded = store.load();
  if (!Array.isArray(loaded) || loaded.length !== 0) fail(`${label}: want empty list, got ${JSON.stringify(loaded)}`);
  if (!existsSync(file + '.bak')) fail(`${label}: no .bak backup`);
  if (readFileSync(file + '.bak', 'utf-8') !== contents) fail(`${label}: .bak does not hold the original contents`);
  if (mode(file + '.bak') !== 0o600) fail(`${label}: .bak is not 0600`);
  if (existsSync(file)) fail(`${label}: corrupt file left in place`);
  if (!warnings.some((w) => /corrupt/.test(w))) fail(`${label}: no warning logged`);
}

// --- Missing file → empty list, no backup ---
{
  const { store, file } = newStore();
  if (store.load().length !== 0) fail('missing file should load as empty');
  if (existsSync(file + '.bak')) fail('missing file should not create a backup');
}

// --- Entry validation ---
const bad = [
  ['null', null],
  ['array', []],
  ['empty name', { ...machine, name: '' }],
  ['blank name', { ...machine, name: '   ' }],
  ['numeric name', { ...machine, name: 5 }],
  ['missing addr', { name: 'dev', port: 8765, token: 't' }],
  ['empty token', { ...machine, token: '' }],
  ['port 0', { ...machine, port: 0 }],
  ['port 65536', { ...machine, port: 65536 }],
  ['fractional port', { ...machine, port: 80.5 }],
  ['string port', { ...machine, port: '8765' }],
];
for (const [label, value] of bad) {
  if (validateMachine(value) === null) fail(`validateMachine accepted ${label}`);
}
for (const port of [1, 8765, 65535]) {
  if (validateMachine({ ...machine, port }) !== null) fail(`validateMachine rejected port ${port}`);
}
for (const value of [null, {}, 'x', [machine, { ...machine, port: 0 }]]) {
  let threw = false;
  try { validateMachines(value); } catch { threw = true; }
  if (!threw) fail('validateMachines accepted ' + JSON.stringify(value));
}
const cleaned = validateMachines([{ ...machine, extra: 'drop me' }]);
if ('extra' in cleaned[0]) fail('validateMachines kept an unknown field');

// --- save() rejects bad input and leaves the existing file untouched ---
{
  const { store, file } = newStore();
  store.save([machine]);
  const before = readFileSync(file, 'utf-8');
  let threw = false;
  try { store.save([{ ...machine, port: 70000 }]); } catch { threw = true; }
  if (!threw) fail('save() accepted an invalid machine');
  threw = false;
  try { store.save({ not: 'an array' }); } catch { threw = true; }
  if (!threw) fail('save() accepted a non-array');
  if (readFileSync(file, 'utf-8') !== before) fail('rejected save modified the file');
}

rmSync(dir, { recursive: true, force: true });
console.log('machine-store checks passed');

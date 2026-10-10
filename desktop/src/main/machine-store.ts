import * as fs from 'fs';
import * as path from 'path';
import type { MachineConfig } from '../shared/protocol';

// Persistence for machines.json, kept free of Electron imports so it can be
// unit-tested in plain node (scripts/test-machine-store.mjs). The main process
// injects safeStorage as the TokenCrypto.
//
// On disk each machine is {name, addr, port, tokenEnc}, where tokenEnc is the
// base64 of the OS-keychain-encrypted token. When encryption is unavailable
// (e.g. Linux without a secret service) the token is stored as plaintext
// `token` instead, with a warning. Legacy plaintext entries are read and, when
// encryption is available, immediately rewritten as tokenEnc. The renderer only ever sees plaintext
// MachineConfig, so the IPC contract is unchanged.

export interface TokenCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export interface MachineStoreOptions {
  path: string;
  crypto: TokenCrypto;
  warn?: (message: string) => void;
}

type StoredMachine = {
  name: string;
  addr: string;
  port: number;
  token?: string;
  tokenEnc?: string;
};

const FILE_MODE = 0o600;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isValidPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

// validateMachine returns a reason string for an invalid entry, or null.
// Shared by save-machines (renderer input) and load (file contents).
export function validateMachine(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const m = value as Record<string, unknown>;
  if (!isNonEmptyString(m.name)) return 'name must be a non-empty string';
  if (!isNonEmptyString(m.addr)) return 'addr must be a non-empty string';
  if (!isValidPort(m.port)) return 'port must be an integer from 1 to 65535';
  if (!isNonEmptyString(m.token)) return 'token must be a non-empty string';
  return null;
}

// validateMachines checks a whole save-machines payload and returns it typed,
// or throws with the first problem found.
export function validateMachines(value: unknown): MachineConfig[] {
  if (!Array.isArray(value)) throw new Error('machines must be an array');
  value.forEach((entry, i) => {
    const reason = validateMachine(entry);
    if (reason) throw new Error(`machine #${i + 1}: ${reason}`);
  });
  // Copy only the known fields so stray renderer properties never hit disk.
  return (value as MachineConfig[]).map(({ name, addr, port, token }) => ({ name, addr, port, token }));
}

class CorruptFileError extends Error {}

export class MachineStore {
  private readonly file: string;
  private readonly crypto: TokenCrypto;
  private readonly warn: (message: string) => void;
  private warnedPlaintext = false;

  constructor(opts: MachineStoreOptions) {
    this.file = opts.path;
    this.crypto = opts.crypto;
    this.warn = opts.warn ?? ((message) => console.warn(message));
  }

  get backupPath(): string {
    return `${this.file}.bak`;
  }

  // tightenPermissions chmods an existing file to 0600. writeFileSync's mode
  // only applies when it creates the file, so files written by older versions
  // (0644) need this explicitly.
  tightenPermissions(): void {
    for (const p of [this.file, this.backupPath]) {
      try {
        if (fs.existsSync(p)) fs.chmodSync(p, FILE_MODE);
      } catch (e) {
        this.warn(`could not chmod ${p}: ${(e as Error).message}`);
      }
    }
  }

  // load returns the machines with plaintext tokens. A missing file is an
  // empty list. A structurally corrupt file is moved to machines.json.bak and
  // also yields an empty list, so the user can start over without losing it.
  // A token that fails to decrypt throws instead: that is a keychain problem,
  // not corruption, and silently dropping it would let the next save destroy
  // the encrypted tokens.
  load(): MachineConfig[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    this.tightenPermissions();
    let machines: MachineConfig[];
    try {
      machines = this.parse(raw);
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e;
      this.backupCorrupt(e.message);
      return [];
    }
    this.migratePlaintext(raw, machines);
    return machines;
  }

  // migratePlaintext re-saves a file that still holds plaintext tokens as soon
  // as encryption is available, rather than waiting for the user's next edit in
  // the machine manager (which may never come). A failure only warns: the
  // tokens were read fine, so the app must keep working.
  private migratePlaintext(raw: string, machines: MachineConfig[]): void {
    if (machines.length === 0 || !this.crypto.isAvailable()) return;
    const stored = JSON.parse(raw) as StoredMachine[];
    if (!stored.some((m) => m.tokenEnc === undefined)) return;
    try {
      this.save(machines);
    } catch (e) {
      this.warn(`could not encrypt legacy plaintext tokens: ${(e as Error).message}`);
    }
  }

  // save validates, encrypts and atomically writes the list. Throws on invalid
  // input so the renderer's save fails visibly instead of persisting junk.
  save(input: unknown): void {
    const machines = validateMachines(input);
    const encrypt = this.crypto.isAvailable();
    if (!encrypt) this.warnPlaintext();
    const records: StoredMachine[] = machines.map(({ name, addr, port, token }) =>
      encrypt
        ? { name, addr, port, tokenEnc: this.crypto.encrypt(token).toString('base64') }
        : { name, addr, port, token },
    );
    this.writeAtomic(JSON.stringify(records, null, 2));
  }

  private parse(raw: string): MachineConfig[] {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new CorruptFileError(`invalid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(data)) throw new CorruptFileError('top level is not an array');
    return data.map((entry, i) => {
      const machine = this.decode(entry);
      const reason = validateMachine(machine);
      if (reason) throw new CorruptFileError(`machine #${i + 1}: ${reason}`);
      return machine as MachineConfig;
    });
  }

  // decode turns a stored record into a MachineConfig-shaped object (still to
  // be validated). tokenEnc wins over a legacy token if both are present.
  private decode(entry: unknown): unknown {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
    const { name, addr, port, token, tokenEnc } = entry as Record<string, unknown>;
    if (tokenEnc === undefined) return { name, addr, port, token };
    if (typeof tokenEnc !== 'string' || tokenEnc === '') {
      throw new CorruptFileError('tokenEnc must be a non-empty base64 string');
    }
    if (!this.crypto.isAvailable()) {
      throw new Error(`cannot decrypt the token for "${String(name)}": OS encryption is unavailable`);
    }
    try {
      return { name, addr, port, token: this.crypto.decrypt(Buffer.from(tokenEnc, 'base64')) };
    } catch (e) {
      throw new Error(`cannot decrypt the token for "${String(name)}": ${(e as Error).message}`);
    }
  }

  private backupCorrupt(reason: string): void {
    try {
      fs.renameSync(this.file, this.backupPath);
      fs.chmodSync(this.backupPath, FILE_MODE);
      this.warn(`machines.json is corrupt (${reason}); moved it to ${this.backupPath}`);
    } catch (e) {
      this.warn(`machines.json is corrupt (${reason}) and could not be backed up: ${(e as Error).message}`);
    }
  }

  // writeAtomic writes a temp file in the same directory and renames it over
  // the target, so a crash mid-write never leaves a truncated machines.json.
  private writeAtomic(contents: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, contents, { mode: FILE_MODE });
      // mode is ignored if a stale temp file already existed.
      fs.chmodSync(tmp, FILE_MODE);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw e;
    }
    fs.chmodSync(this.file, FILE_MODE);
  }

  private warnPlaintext(): void {
    if (this.warnedPlaintext) return;
    this.warnedPlaintext = true;
    this.warn('OS encryption is unavailable; machine tokens are stored as plaintext in machines.json (mode 0600)');
  }
}

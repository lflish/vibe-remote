// chat/availability.ts: whether the directory picker's "Chat" card can be
// chosen, and why not (R1.3, R1.4, R17.2, c3). Every reason resolves to a key
// that exists in both locales.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

const { chatAvailability } = await load('src/renderer/chat/availability.ts');
const { dictionaries } = await load('src/renderer/i18n.ts');
const { test, run } = runner('test-chat-availability');

const info = (chat, proto = 3) => ({
  hostname: 'h', tmux_enabled: true, default_workdir: '/w', allowed_roots: ['/w'], proto, chat,
});
const ok = { supported: true, claudeVersion: '2.1.210', minClaudeVersion: '2.1.210' };

function text(a, locale = 'zh') {
  assert.ok(a.reasonKey, 'a disabled card names its reason');
  const s = dictionaries[locale][a.reasonKey];
  assert.ok(s, `key ${a.reasonKey} exists in ${locale}`);
  return s.replace(/\{(\w+)\}/g, (_, k) => String(a.params?.[k] ?? `{${k}}`));
}

test('supported and trusted: selectable', () => {
  const a = chatAvailability(info(ok), undefined, 'trusted');
  assert.equal(a.enabled, true);
  assert.equal(a.reasonKey, undefined);
});

test('not_claude', () => {
  const a = chatAvailability(info({ supported: false, reason: 'not_claude', minClaudeVersion: '2.1.210' }), undefined, 'trusted');
  assert.equal(a.enabled, false);
  assert.match(text(a), /对话界面只支持 claude/);
  assert.match(text(a, 'en'), /only supports claude/i);
  assert.equal(a.upgrade, undefined);
});

test('old daemon / too old: proto 2 means upgrade vibe-remoted', () => {
  const a = chatAvailability(info(undefined, 2), undefined, undefined);
  assert.equal(a.enabled, false);
  assert.equal(a.upgrade, 'daemon');
  assert.match(text(a), /vibe-remoted/);
  assert.match(text(a), /升级/);
});

test('old daemon / too old: no chat field means upgrade vibe-remoted', () => {
  const a = chatAvailability(info(undefined, 3), undefined, 'trusted');
  assert.equal(a.enabled, false);
  assert.equal(a.upgrade, 'daemon');
  // A daemon too old to report proto at all reads as protocol 1.
  const b = chatAvailability({ hostname: 'h', tmux_enabled: true, default_workdir: '/', allowed_roots: [] });
  assert.equal(b.upgrade, 'daemon');
  assert.match(text(b), /1/);
});

test('proto 2', () => {
  // R17.2: the terminal still works; only the chat card points at the daemon.
  const a = chatAvailability(info({ supported: true, minClaudeVersion: '2.1.210' }, 2), undefined, 'trusted');
  assert.equal(a.enabled, false);
  assert.equal(a.upgrade, 'daemon');
});

test('old daemon / too old: claude too old means upgrade claude, with both versions', () => {
  const a = chatAvailability(info({ supported: false, reason: 'claude_too_old', claudeVersion: '1.0.51', minClaudeVersion: '2.1.210' }), undefined, 'trusted');
  assert.equal(a.enabled, false);
  assert.equal(a.upgrade, 'claude');
  assert.match(text(a), /1\.0\.51/);
  assert.match(text(a), /2\.1\.210/);
  assert.match(text(a), /claude/);
});

test('other daemon reasons each have their own text', () => {
  const seen = new Set();
  for (const reason of ['claude_not_found', 'shell_syntax', 'conflicting_args', 'state_dir_unwritable', 'something_new']) {
    const a = chatAvailability(info({ supported: false, reason, minClaudeVersion: '2.1.210' }), undefined, 'trusted');
    assert.equal(a.enabled, false, reason);
    seen.add(text(a));
  }
  assert.equal(seen.size, 5);
  const unknown = chatAvailability(info({ supported: false, reason: 'something_new', minClaudeVersion: '2.1.210' }), undefined, 'trusted');
  assert.match(text(unknown), /something_new/);
});

test('workdir untrusted', () => {
  for (const trust of ['untrusted', 'unknown', undefined]) {
    const a = chatAvailability(info(ok), undefined, trust);
    assert.equal(a.enabled, false, String(trust));
    assert.equal(a.reasonKey, 'picker.ui.chat.reason.workdir_untrusted');
    assert.match(text(a), /先用终端界面在该目录打开一次 claude 以信任此目录/);
  }
  assert.equal(chatAvailability(info(ok), undefined, 'trusted').enabled, true);
});

test('info not loaded yet / failed', () => {
  const loading = chatAvailability(undefined, undefined, 'trusted');
  assert.equal(loading.enabled, false);
  assert.equal(loading.reasonKey, 'picker.ui.chat.reason.checking');
  const failed = chatAvailability(undefined, new Error('info failed: 500'), 'trusted');
  assert.equal(failed.enabled, false);
  assert.match(text(failed), /info failed: 500/);
});

test('proto3_daemon_supports_chat', () => {
  // Chat availability is gated on CHAT_MIN_PROTO (3), not PROTOCOL_VERSION (4),
  // so a proto-3 daemon that reports chat support stays selectable.
  const a = chatAvailability(info(ok, 3), undefined, 'trusted');
  assert.equal(a.enabled, true);
  assert.equal(a.reasonKey, undefined);
});

test('proto2_reason_still_says_3', () => {
  const a = chatAvailability(info(undefined, 2), undefined, undefined);
  assert.equal(a.enabled, false);
  assert.match(text(a), /协议 2/);
  assert.match(text(a), /需要协议 3/);
});

await run();
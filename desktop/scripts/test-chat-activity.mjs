// chat/activity.ts: the sidebar dot of a chat session and whether to notify
// (R16.1–R16.4, d12). Events come from an open view's live frames or from the
// 5 s REST poll (activitySeq / epoch / state) for sessions not open here.
import { strict as assert } from 'node:assert';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

const { nextDot } = await load('src/renderer/chat/activity.ts');
const { test, run } = runner('test-chat-activity');

const bg = { isActive: false, windowFocused: true };
const fg = { isActive: true, windowFocused: true };
const away = { isActive: true, windowFocused: false };

test('chat frame lights the grey dot on a background session (R16.1)', () => {
  assert.deepEqual(nextDot('none', { kind: 'chat' }, bg), { dot: 'output', notify: false });
  assert.deepEqual(nextDot('idle', { kind: 'chat' }, bg), { dot: 'output', notify: false });
  // A waiting session stays yellow until its prompt is handled.
  assert.equal(nextDot('waiting', { kind: 'chat' }, bg).dot, 'waiting');
  // The session being looked at shows no dot.
  assert.deepEqual(nextDot('none', { kind: 'chat' }, fg), { dot: 'none', notify: false });
});

test('result turns it green (R16.2)', () => {
  assert.deepEqual(nextDot('output', { kind: 'result' }, bg), { dot: 'idle', notify: false });
  assert.deepEqual(nextDot('none', { kind: 'result' }, fg), { dot: 'none', notify: false });
});

test('pending prompt turns it yellow and notifies (R16.3)', () => {
  assert.deepEqual(nextDot('output', { kind: 'prompt' }, bg), { dot: 'waiting', notify: true });
  // Window not focused: notify even for the open session, but no dot on it.
  assert.deepEqual(nextDot('none', { kind: 'prompt' }, away), { dot: 'none', notify: true });
  // Looking right at it: nothing to tell.
  assert.deepEqual(nextDot('none', { kind: 'prompt' }, fg), { dot: 'none', notify: false });
  // Handled (here or elsewhere): yellow goes back to grey.
  assert.deepEqual(nextDot('waiting', { kind: 'promptsCleared' }, bg), { dot: 'output', notify: false });
  assert.equal(nextDot('idle', { kind: 'promptsCleared' }, bg).dot, 'idle');
});

test('REST activitySeq / state (R16.4: no hooks needed)', () => {
  const snap = (state, activitySeq, epoch = 'e1') => ({ state, activitySeq, epoch });
  // First sight of a session: no dot (nothing new since we started).
  assert.deepEqual(nextDot('none', { kind: 'rest', next: snap('running', 5) }, bg), { dot: 'none', notify: false });
  // Unchanged.
  assert.deepEqual(nextDot('none', { kind: 'rest', prev: snap('idle', 5), next: snap('idle', 5) }, bg), { dot: 'none', notify: false });
  // New messages → grey.
  assert.deepEqual(nextDot('none', { kind: 'rest', prev: snap('running', 5), next: snap('running', 9) }, bg), { dot: 'output', notify: false });
  // New epoch (reload) with the same seq number is still new activity.
  assert.equal(nextDot('none', { kind: 'rest', prev: snap('idle', 5, 'e1'), next: snap('idle', 5, 'e2') }, bg).dot, 'output');
  // Turn finished → green.
  assert.deepEqual(nextDot('output', { kind: 'rest', prev: snap('running', 9), next: snap('idle', 12) }, bg), { dot: 'idle', notify: false });
  // Needs you → yellow + notification.
  assert.deepEqual(nextDot('output', { kind: 'rest', prev: snap('running', 9), next: snap('waiting', 10) }, bg), { dot: 'waiting', notify: true });
  // Still waiting on the next poll: no second notification.
  assert.deepEqual(nextDot('waiting', { kind: 'rest', prev: snap('waiting', 10), next: snap('waiting', 10) }, bg), { dot: 'waiting', notify: false });
  // Answered elsewhere, turn continues.
  assert.equal(nextDot('waiting', { kind: 'rest', prev: snap('waiting', 10), next: snap('running', 14) }, bg).dot, 'output');
});

test('fallback does not switch', () => {
  // Unsigned build (d12): the Dock bounces and the dot stays yellow; the
  // current session is never switched for the user.
  const r = nextDot('waiting', { kind: 'notifyResult', result: 'fallback' }, bg);
  assert.deepEqual(r, { dot: 'waiting', notify: false });
  assert.equal('open' in r, false);
  assert.equal('open' in nextDot('waiting', { kind: 'notifyResult', result: 'shown' }, bg), false);
  // Only a click on a real notification opens the session.
  assert.deepEqual(nextDot('waiting', { kind: 'notificationClick' }, bg), { dot: 'none', notify: false, open: true });
});

test('machine overview shown: the hidden chat is not current, its prompt shows yellow and notifies (R16.3)', async () => {
  const page = await indexDom();
  const app = await loadIndex();
  const machine = { name: 'dev', addr: '127.0.0.1', port: 1234, token: 't' };
  const mk = '127.0.0.1:1234';
  app.setMachines([machine]);
  app.machineOnline.set(mk, true);
  app.machineSessions.set(mk, [{ id: 's', title: 'conversation', workdir: '/w', created: '2026-11-14', mode: 'normal', ui: 'chat', state: 'running' }]);
  const view = { key: `${mk}::s`, sessionId: 's', machine, container: document.createElement('div'), activity: 'none', ui: 'chat', client: { state: 'connected' }, show() {} };
  document.getElementById('terminal-container').appendChild(view.container);
  app.views.set(view.key, view);
  app.setActive(view.key);
  // While it is the session on screen, a prompt is no news.
  app.applyViewActivity(view, { kind: 'prompt' }, { kind: 'permission', toolName: 'Bash' });
  assert.equal(view.activity, 'none');
  assert.equal(page.notifications.length, 0);
  // The user goes to the machine overview: the chat is hidden, so not current.
  app.showMachineOverview(machine);
  assert.equal(view.container.style.display, 'none');
  app.applyViewActivity(view, { kind: 'prompt' }, { kind: 'permission', toolName: 'Bash' });
  app.renderSidebar();
  await Promise.resolve();
  assert.equal(view.activity, 'waiting', 'view dot');
  assert.equal(document.querySelector('.session-item').dataset.dot, 'waiting', 'sidebar dot');
  assert.equal(page.notifications.length, 1, 'notified');
  assert.equal(page.notifications[0].tag, view.key);
  page.dom.window.close();
});

await run();

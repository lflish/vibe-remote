// session-form.ts (T9): the name field shared by the new-worktree dialog and the
// directory picker's Worktree mode, and the picker built on the shared sections.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { indexDom, load, runner } from './chat-test-util.mjs';
import { INFO_V4, afterDebounce, click, fakeDaemon, overlay, planFor, settle, tid, typeInto } from './dialog-test-util.mjs';

await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
const { createNameSection } = await load('src/renderer/session-form.ts', { platform: 'browser' });
const { openDirPicker } = await load('src/renderer/dirpicker.ts', { platform: 'browser' });
const { t } = await load('src/renderer/i18n.ts', { platform: 'browser' });

const { test, run } = runner('test-session-form');
const M = { name: 'this-mac', addr: '10.0.0.9', port: 8765, token: 't' };
const vectors = JSON.parse(readFileSync('../vibe-remoted/internal/session/testdata/worktree-names.json', 'utf8'));

function mountSection(plan) {
  let changes = 0;
  const section = createNameSection({ plan, onChange: () => { changes++; } });
  document.body.appendChild(section.el);
  return { section, input: tid('wt-name-input', section.el), error: tid('wt-name-error', section.el), changes: () => changes, remove: () => section.el.remove() };
}

async function openPicker(mode, routes) {
  const daemon = fakeDaemon(routes);
  const result = openDirPicker(M, mode);
  await settle(8);
  return { daemon, result, root: overlay(), confirm: tid('dialog-confirm', overlay()), cancel: tid('dialog-cancel', overlay()) };
}

async function closePicker(p) {
  if (overlay()) click(p.cancel);
  await p.result;
  p.daemon.restore();
}

const pickerPlan = (workdir, name) => {
  if (name === 'a~b') return { ...planFor(name), ok: false, error: 'invalid_worktree_name', message: 'bad', branch: undefined, path: undefined };
  return planFor(name);
};

test('invalid_name_disables_confirm', async () => {
  const p = await openPicker('worktree', { plan: pickerPlan });
  const input = tid('wt-name-input', p.root);
  const error = tid('wt-name-error', p.root);
  assert.ok(input && error, 'the Worktree mode shows the name field');

  typeInto(input, 'fix-login');
  await afterDebounce();
  assert.equal(error.textContent, '');
  assert.equal(p.confirm.disabled, false, 'a usable name enables the confirm button');

  let checked = 0;
  for (const v of vectors) {
    // A single-line input drops line breaks itself; those vectors are covered in test-worktree-name.
    if (!v.local || /[\r\n]/.test(v.name)) continue;
    typeInto(input, v.name);
    assert.equal(error.textContent, t(`wt.name.${v.reason}`), `${JSON.stringify(v.name)} → ${v.reason}`);
    assert.equal(error.hidden, false);
    assert.equal(p.confirm.disabled, true, `${JSON.stringify(v.name)} keeps the confirm button disabled`);
    checked++;
  }
  assert.ok(checked >= 12);
  for (const reason of ['empty', 'whitespace', 'dotdot', 'leading_dash', 'invalid']) {
    assert.notEqual(t(`wt.name.${reason}`), `wt.name.${reason}`, `wt.name.${reason} exists`);
  }
  // None of those reached the daemon: the local rules answered.
  const asked = p.daemon.plans().map((q) => q.name);
  assert.deepEqual(asked.filter((n) => n !== '' && n !== 'fix-login'), []);

  // A name only git can judge: the daemon's answer shows up under the field.
  typeInto(input, 'a~b');
  assert.equal(p.confirm.disabled, true, 'not usable until the daemon has answered');
  await afterDebounce();
  assert.equal(error.textContent, 'git 不接受这个分支名');
  assert.equal(p.confirm.disabled, true);
  assert.equal(document.querySelectorAll('.modal-overlay').length, 1);
  await closePicker(p);
});

test('base_info_text', async () => {
  const s = mountSection(async (name) => planFor(name));
  s.section.refresh();
  await settle();
  assert.equal(tid('wt-base-info', s.section.el).textContent, '基于 main @ a1b2c3d，不包含未提交的改动');
  assert.equal(s.error.textContent, '', 'an untouched empty name shows no error');
  assert.equal(s.section.ready(), false);
  typeInto(s.input, 'change/foo');
  await afterDebounce();
  assert.equal(tid('wt-target-path', s.section.el).textContent, '/r/devflow-worktrees/change-foo');
  assert.equal(tid('wt-base-info', s.section.el).textContent, '基于 main @ a1b2c3d，不包含未提交的改动');
  assert.equal(s.section.ready(), true);
  assert.equal(s.section.value(), 'change/foo');
  assert.ok(s.changes() >= 2, 'onChange fires when the state changes');
  s.remove();
});

test('detached_base_text', async () => {
  const s = mountSection(async (name) => planFor(name, { base: { head: '9f8e7d6', detached: true } }));
  s.section.refresh();
  await settle();
  const text = tid('wt-base-info', s.section.el).textContent;
  assert.equal(text, t('wt.new.baseDetached', { head: '9f8e7d6' }));
  assert.ok(text.includes('9f8e7d6') && text.includes('不在任何分支上'), text);
  s.remove();
});

test('last_plan_wins', async () => {
  const pending = [];
  const s = mountSection((name) => new Promise((resolve) => pending.push({ name, resolve })));
  typeInto(s.input, 'aa');
  await afterDebounce();
  typeInto(s.input, 'bb');
  await afterDebounce();
  assert.deepEqual(pending.map((p) => p.name), ['aa', 'bb'], 'both requests are in flight');
  // The later request answers first; the earlier one arrives after it.
  pending[1].resolve(planFor('bb'));
  await settle();
  pending[0].resolve({ ...planFor('aa'), ok: false, error: 'worktree_branch_exists', conflict: 'aa' });
  await settle();
  assert.equal(s.error.textContent, '', 'the stale rejection is not shown');
  assert.equal(tid('wt-target-path', s.section.el).textContent, '/r/devflow-worktrees/bb');
  assert.equal(s.section.ready(), true);

  // Same when the stale answer is the good one.
  typeInto(s.input, 'cc');
  await afterDebounce();
  typeInto(s.input, 'dd');
  await afterDebounce();
  pending[3].resolve({ ...planFor('dd'), ok: false, error: 'worktree_branch_exists', conflict: 'dd' });
  await settle();
  pending[2].resolve(planFor('cc'));
  await settle();
  assert.equal(s.error.textContent, '分支 dd 已存在');
  assert.equal(s.section.ready(), false);
  s.remove();
});

test('plan_failure_is_shown_and_not_ready', async () => {
  const s = mountSection(async () => { throw new Error('network down'); });
  typeInto(s.input, 'fix-login');
  await afterDebounce();
  assert.ok(s.error.textContent.includes('network down'), s.error.textContent);
  assert.equal(s.section.ready(), false);
  assert.equal(await s.section.confirm(), null);
  s.remove();
});

test('picker_worktree_mode_name_segment', async () => {
  const p = await openPicker('worktree', { plan: pickerPlan });
  for (const id of ['wt-name-input', 'wt-name-error', 'wt-base-info', 'wt-target-path']) {
    assert.ok(tid(id, p.root), `the picker's Worktree mode has ${id}`);
  }
  assert.equal(p.confirm.disabled, true, 'an empty name keeps the confirm button disabled');
  assert.equal(tid('wt-base-info', p.root).textContent, '基于 main @ a1b2c3d，不包含未提交的改动');
  const note = [...p.root.querySelectorAll('.modal-mode-note')].find((n) => n.textContent === t('picker.modeNote'));
  assert.ok(!note || note.hidden, 'picker.modeNote is not shown next to the name field');
  assert.deepEqual(p.daemon.plans()[0], { workdir: '/r/devflow', name: '' }, 'the base comes from a plan for the listed folder');

  typeInto(tid('wt-name-input', p.root), 'change/foo');
  await afterDebounce();
  assert.equal(p.confirm.disabled, false);
  assert.equal(tid('wt-target-path', p.root).textContent, '/r/devflow-worktrees/change-foo');
  click(p.confirm);
  const picked = await p.result;
  assert.deepEqual(picked, {
    workdir: '/r/devflow', flags: ['skip'], mode: 'worktree', ui: 'terminal',
    worktreeName: 'change/foo', worktreePath: '/r/devflow-worktrees/change-foo',
  });
  assert.equal(overlay(), null);
  p.daemon.restore();
});

test('picker_name_segment_follows_mode_and_folder', async () => {
  const p = await openPicker('normal', {
    plan: (workdir, name) => (workdir === '/r/notes' ? { ok: false, error: 'not_git', message: 'not a repo' } : planFor(name)),
    fs: (path) => ({ path: path || '/r/devflow', entries: [{ name: 'notes', path: '/r/notes' }], parent: '/r', chatTrust: 'trusted' }),
  });
  assert.equal(tid('wt-name-input', p.root), null, 'no name field in normal mode');
  assert.equal(p.confirm.disabled, false);
  const cards = [...p.root.querySelectorAll('.modal-mode-card:not(.modal-ui-card)')];
  click(cards[1]);
  await settle();
  assert.ok(tid('wt-name-input', p.root));
  assert.equal(p.confirm.disabled, true);
  // Browse into a folder that is not a repository: the reason shows, the field is off.
  click([...p.root.querySelectorAll('.modal-item')].find((b) => b.textContent.includes('notes')));
  await settle(8);
  assert.equal(tid('wt-name-error', p.root).textContent, '这个目录不在 git 仓库里');
  assert.equal(tid('wt-name-input', p.root).disabled, true);
  assert.equal(p.confirm.disabled, true);
  // Back to normal mode: the field goes away and the folder can be opened.
  click(cards[0]);
  await settle();
  assert.equal(tid('wt-name-input', p.root), null);
  assert.equal(p.confirm.disabled, false);
  await closePicker(p);
});

test('picker_proto3_has_no_name_segment', async () => {
  const p = await openPicker('worktree', { info: { ...INFO_V4, proto: 3 } });
  assert.equal(tid('wt-name-input', p.root), null);
  const note = [...p.root.querySelectorAll('.modal-mode-note')].find((n) => n.textContent === t('picker.modeNote'));
  assert.ok(note && !note.hidden, 'the old mode note stays for a protocol 3 daemon');
  assert.equal(p.confirm.disabled, false);
  click(p.confirm);
  const picked = await p.result;
  assert.deepEqual(picked, { workdir: '/r/devflow', flags: ['skip'], mode: 'worktree', ui: 'terminal' });
  assert.ok(!('worktreeName' in picked) && !('worktreePath' in picked));
  assert.deepEqual(p.daemon.plans(), [], 'a protocol 3 daemon is never asked for a plan');
  p.daemon.restore();
});

test('picker_normal_mode_unchanged', async () => {
  const p = await openPicker('normal', {});
  assert.ok(tid('picker-ui-terminal', p.root) && tid('picker-ui-chat', p.root) && tid('picker-ui-chat-reason', p.root));
  assert.equal(tid('picker-ui-chat', p.root).disabled, false);
  const boxes = [...p.root.querySelectorAll('.modal-flag input')];
  assert.deepEqual(boxes.map((b) => b.checked), [false, true]);
  click(tid('picker-ui-chat', p.root));
  boxes[0].checked = true;
  click(p.confirm);
  const picked = await p.result;
  assert.deepEqual(picked, { workdir: '/r/devflow', flags: ['continue', 'skip'], mode: 'normal', ui: 'chat' });
  assert.ok(!('worktreeName' in picked));
  p.daemon.restore();
});

await run();

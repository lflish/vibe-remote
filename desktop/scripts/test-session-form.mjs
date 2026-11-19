// session-form.ts (T9): the name field shared by the new-worktree dialog and the
// directory picker's Worktree mode, and the picker built on the shared sections.
// T15: the note under the launch options that says what -c does when the
// directory already has a session.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { indexDom, load, runner } from './chat-test-util.mjs';
import { INFO_V4, afterDebounce, click, fakeDaemon, overlay, planFor, settle, tid, typeInto } from './dialog-test-util.mjs';

await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
const { createNameSection, createFlagsSection } = await load('src/renderer/session-form.ts', { platform: 'browser' });
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

async function openPicker(mode, routes, opts) {
  const daemon = fakeDaemon(routes);
  const result = openDirPicker(M, mode, opts);
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

// The daemon may refuse for a reason this desktop has no text for (a newer
// daemon; e.g. a repository with no commit to start from). It is a refusal
// all the same: the daemon's own words are shown, and the name is not usable.
test('unknown_plan_reason_is_shown_not_taken_for_success', async () => {
  const refuse = (over) => (name) => Promise.resolve({ ok: false, error: 'source_has_no_commits', message: 'the repository has no commits yet', project: '/r/devflow', projectName: 'devflow', ...over });
  // Asked about a typed name.
  const s = mountSection(refuse({}));
  typeInto(s.input, 'fix-login');
  await afterDebounce();
  assert.equal(s.error.textContent, 'the repository has no commits yet');
  assert.equal(s.error.hidden, false);
  assert.equal(s.section.ready(), false);
  assert.equal(await s.section.confirm(), null, 'confirming does not go through either');
  assert.equal(tid('wt-target-path', s.section.el).textContent, '—');
  assert.equal(s.input.disabled, false, 'the field stays usable: the reason may not be about the directory');
  s.remove();

  // No message with it: a general sentence, never an empty error or the bare code.
  const bare = mountSection(refuse({ message: undefined }));
  typeInto(bare.input, 'fix-login');
  await afterDebounce();
  assert.equal(bare.error.textContent, t('wt.error.refused'));
  assert.notEqual(t('wt.error.refused'), 'wt.error.refused', 'the text exists');
  assert.equal(bare.section.ready(), false);
  bare.remove();
  // Not even a reason code.
  const empty = mountSection(() => Promise.resolve({ ok: false }));
  typeInto(empty.input, 'fix-login');
  await afterDebounce();
  assert.equal(empty.error.textContent, t('wt.error.refused'));
  assert.equal(empty.section.ready(), false);
  empty.remove();

  // Already known when the dialog opens (the first question carries no name):
  // shown at once, before anything is typed.
  const early = mountSection(refuse({}));
  early.section.refresh();
  await settle();
  assert.equal(early.error.textContent, 'the repository has no commits yet');
  assert.equal(early.error.hidden, false);
  assert.equal(early.section.ready(), false);
  // The usual answer to the nameless first question stays silent.
  early.remove();
  const quiet = mountSection(async (name) => planFor(name));
  quiet.section.refresh();
  await settle();
  assert.equal(quiet.error.textContent, '', 'an untouched empty name shows no error');
  quiet.remove();

  // In the picker the confirm button stays off.
  const p = await openPicker('worktree', { plan: (workdir, name) => ({ ok: false, error: 'source_has_no_commits', message: 'the repository has no commits yet' }) });
  assert.equal(tid('wt-name-error', p.root).textContent, 'the repository has no commits yet');
  typeInto(tid('wt-name-input', p.root), 'fix-login');
  await afterDebounce();
  assert.equal(tid('wt-name-error', p.root).textContent, 'the repository has no commits yet');
  assert.equal(p.confirm.disabled, true);
  await closePicker(p);
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

// The machine info can arrive after the folder listing (or not at all). Until
// it is in, the picker does not know whether the daemon names worktrees, nor
// which launch options are on by default: confirming then created a worktree
// with no name (`vibe/<session id>`) and dropped the default options.
test('picker_waits_for_machine_info', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p = await openPicker('worktree', { plan: pickerPlan, info: async () => { await gate; return INFO_V4; } });
  assert.equal(p.root.querySelector('.modal-path').textContent, '/r/devflow', 'the folder listing is in');
  assert.equal(tid('wt-name-input', p.root), null, 'the info is not: no name field yet');
  assert.equal(p.confirm.disabled, true, 'Worktree mode cannot be confirmed before the machine info is in');
  const cards = [...p.root.querySelectorAll('.modal-mode-card:not(.modal-ui-card)')];
  click(cards[0]);
  await settle();
  assert.equal(p.confirm.disabled, true, 'normal mode waits as well: the default launch options are not known yet');
  click(cards[1]);
  await settle();
  assert.equal(p.confirm.disabled, true);

  release();
  await settle(8);
  assert.ok(tid('wt-name-input', p.root), 'the name field appears once the daemon is known to be protocol 4');
  assert.equal(p.confirm.disabled, true, 'and an empty name keeps the button off');
  typeInto(tid('wt-name-input', p.root), 'fix-login');
  await afterDebounce();
  assert.equal(p.confirm.disabled, false);
  click(p.confirm);
  assert.deepEqual(await p.result, {
    workdir: '/r/devflow', flags: ['skip'], mode: 'worktree', ui: 'terminal',
    worktreeName: 'fix-login', worktreePath: '/r/devflow-worktrees/fix-login',
  });
  p.daemon.restore();

  // Normal mode, late info: the default options are sent once it is in.
  let release2;
  const gate2 = new Promise((resolve) => { release2 = resolve; });
  const q = await openPicker('normal', { info: async () => { await gate2; return INFO_V4; } });
  assert.equal(q.confirm.disabled, true);
  release2();
  await settle(8);
  assert.equal(q.confirm.disabled, false);
  click(q.confirm);
  assert.deepEqual(await q.result, { workdir: '/r/devflow', flags: ['skip'], mode: 'normal', ui: 'terminal' });
  q.daemon.restore();
});

test('picker_info_failed', async () => {
  const p = await openPicker('normal', { plan: pickerPlan, info: new Error('offline') });
  assert.equal(p.confirm.disabled, false, 'a folder can still be opened in a terminal session');
  assert.equal(tid('picker-worktree-unavailable', p.root), null);
  const cards = [...p.root.querySelectorAll('.modal-mode-card:not(.modal-ui-card)')];
  click(cards[1]);
  await settle();
  // Whether this daemon names worktrees is unknown: creating one could leave
  // an unnamed worktree and branch behind.
  assert.equal(p.confirm.disabled, true, 'Worktree mode is off when the machine info could not be read');
  const why = tid('picker-worktree-unavailable', p.root);
  assert.ok(why && !why.hidden, 'and the dialog says why');
  assert.equal(why.textContent, t('picker.worktreeNeedsInfo'));
  assert.notEqual(t('picker.worktreeNeedsInfo'), 'picker.worktreeNeedsInfo', 'the text exists');
  assert.equal(tid('wt-name-input', p.root), null);
  assert.deepEqual(p.daemon.plans(), [], 'no plan is asked for');
  click(cards[0]);
  await settle();
  assert.equal(p.confirm.disabled, false);
  assert.equal(tid('picker-worktree-unavailable', p.root), null, 'the reason goes away with the mode');
  click(p.confirm);
  assert.deepEqual(await p.result, { workdir: '/r/devflow', flags: [], mode: 'normal', ui: 'terminal' });
  p.daemon.restore();
});

// --- T15: what -c does when the directory already has a session (R6) ---

const flagBox = (root, id) => root.querySelector(`.modal-flag input[name="claude-flag-${id}"]`);
const DEFAULT_CONTINUE = {
  ...INFO_V4,
  claude_flags: [{ id: 'continue', label: '续上次会话 (-c)', default: true }, { id: 'skip', label: '跳过权限确认' }],
};

test('continue_note_shown', async () => {
  const asked = [];
  const p = await openPicker('normal', {}, { sessionCountAt: (dir) => { asked.push(dir); return 1; } });
  assert.ok(asked.includes('/r/devflow'), 'the count is asked for the listed folder');
  assert.equal(tid('continue-note', p.root), null, 'nothing to say until -c is checked');
  click(flagBox(p.root, 'continue'));
  const note = tid('continue-note', p.root);
  assert.ok(note, 'the note appears');
  assert.notEqual(t('wt.session.continueNote'), 'wt.session.continueNote', 'the text exists');
  assert.equal(note.textContent, t('wt.session.continueNote'));
  assert.ok(p.root.querySelector('.modal-body').contains(note), 'the note is in the scrolling body, not in the footer');
  assert.equal(p.confirm.disabled, false, 'the note only informs: the confirm button stays usable');
  click(flagBox(p.root, 'continue'));
  assert.equal(tid('continue-note', p.root), null, 'unchecking takes it away');
  // Checked again, the dialog still confirms with the flag.
  click(flagBox(p.root, 'continue'));
  assert.ok(tid('continue-note', p.root));
  click(p.confirm);
  assert.deepEqual(await p.result, { workdir: '/r/devflow', flags: ['continue', 'skip'], mode: 'normal', ui: 'terminal' });
  p.daemon.restore();
});

// In a short window the launch options sit at the bottom edge of the dialog's
// scrolling body: the note that appears under the option the user just ticked
// has to be brought into view, or it explains nothing (review D11; the real
// geometry is measured by shell-layout.mjs).
test('continue_note_is_scrolled_into_view_when_ticked', async () => {
  const scrolled = [];
  const proto = window.HTMLElement.prototype;
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (opts) { scrolled.push([this.dataset.testid, opts]); };
  try {
    const p = await openPicker('normal', { info: DEFAULT_CONTINUE }, { sessionCountAt: () => 1 });
    assert.ok(tid('continue-note', p.root), 'on by default: the note is there from the start');
    assert.deepEqual(scrolled, [], 'opening the dialog scrolls nothing: the user has not asked for anything yet');
    click(flagBox(p.root, 'continue'));
    assert.equal(tid('continue-note', p.root), null);
    assert.deepEqual(scrolled, []);
    click(flagBox(p.root, 'continue'));
    assert.ok(tid('continue-note', p.root));
    assert.deepEqual(scrolled, [['continue-note', { block: 'nearest' }]], 'ticking the option brings its note into view');
    // Another option does not move the dialog.
    click(flagBox(p.root, 'skip'));
    assert.equal(scrolled.length, 1);
    await closePicker(p);
  } finally {
    if (original) proto.scrollIntoView = original;
    else delete proto.scrollIntoView;
  }
});

test('continue_note_hidden_without_sessions', async () => {
  const p = await openPicker('normal', {}, { sessionCountAt: () => 0 });
  click(flagBox(p.root, 'continue'));
  assert.equal(flagBox(p.root, 'continue').checked, true);
  assert.equal(tid('continue-note', p.root), null, 'no session in the folder: no note in the DOM');
  await closePicker(p);
  // A caller that passes no count gets no note either.
  const q = await openPicker('normal', {});
  click(flagBox(q.root, 'continue'));
  assert.equal(tid('continue-note', q.root), null);
  await closePicker(q);
});

test('continue_note_default_checked', async () => {
  const p = await openPicker('normal', { info: DEFAULT_CONTINUE }, { sessionCountAt: () => 2 });
  assert.equal(flagBox(p.root, 'continue').checked, true);
  assert.ok(tid('continue-note', p.root), 'shown as soon as the dialog is up');
  assert.equal(p.confirm.disabled, false);
  await closePicker(p);
});

test('continue_note_other_flag', async () => {
  const p = await openPicker('normal', {}, { sessionCountAt: () => 1 });
  assert.equal(flagBox(p.root, 'skip').checked, true, 'another option is on');
  assert.equal(tid('continue-note', p.root), null);
  click(flagBox(p.root, 'skip'));
  click(flagBox(p.root, 'skip'));
  assert.equal(tid('continue-note', p.root), null, 'toggling another option does not bring it up');
  await closePicker(p);
  // A machine whose options have no `continue` id never shows it.
  const q = await openPicker('normal', {
    info: { ...INFO_V4, claude_flags: [{ id: 'resume-last', label: '续上次会话 (-c)', default: true }] },
  }, { sessionCountAt: () => 3 });
  assert.equal(flagBox(q.root, 'resume-last').checked, true);
  assert.equal(tid('continue-note', q.root), null);
  await closePicker(q);
});

test('picker_count_follows_directory', async () => {
  const p = await openPicker('normal', {
    plan: (workdir, name) => planFor(name),
    fs: (path) => (path === '/r/devflow/src'
      ? { path, entries: [], parent: '/r/devflow', chatTrust: 'trusted' }
      : { path: '/r/devflow', entries: [{ name: 'src', path: '/r/devflow/src' }], parent: '/r', chatTrust: 'trusted' }),
  }, { sessionCountAt: (dir) => (dir === '/r/devflow' ? 1 : 0) });
  click(flagBox(p.root, 'continue'));
  assert.ok(tid('continue-note', p.root), 'the listed folder has a session');
  // Into a subfolder with no session of its own.
  click([...p.root.querySelectorAll('.modal-item')].find((b) => b.textContent.includes('src')));
  await settle(8);
  assert.equal(p.root.querySelector('.modal-path').textContent, '/r/devflow/src');
  assert.equal(flagBox(p.root, 'continue').checked, true, 'the option stays checked');
  assert.equal(tid('continue-note', p.root), null, 'sessions of the parent folder do not count');
  // Back up: the note returns.
  click(p.root.querySelector('.modal-item-up'));
  await settle(8);
  assert.equal(p.root.querySelector('.modal-path').textContent, '/r/devflow');
  assert.ok(tid('continue-note', p.root));
  // Worktree mode starts in a new worktree: nothing is running there.
  const cards = [...p.root.querySelectorAll('.modal-mode-card:not(.modal-ui-card)')];
  click(cards[1]);
  await settle();
  assert.equal(tid('continue-note', p.root), null, 'no note in Worktree mode');
  click(cards[0]);
  await settle();
  assert.ok(tid('continue-note', p.root), 'back in normal mode it applies again');
  await closePicker(p);

  // A protocol 3 daemon's Worktree mode (no name field) is a new worktree as well.
  const q = await openPicker('worktree', { info: { ...INFO_V4, proto: 3 } }, { sessionCountAt: () => 1 });
  click(flagBox(q.root, 'continue'));
  assert.equal(tid('continue-note', q.root), null);
  await closePicker(q);
});

test('flags_section_note_follows_count', () => {
  const section = createFlagsSection({ existingSessions: 0 });
  document.body.appendChild(section.el);
  section.setFlags(DEFAULT_CONTINUE.claude_flags);
  assert.equal(tid('continue-note', section.el), null);
  section.setExistingSessions(1);
  assert.ok(tid('continue-note', section.el));
  assert.equal(tid('continue-note', section.el).getAttribute('role'), 'note');
  // Loading the options again (same dialog) keeps a single note.
  section.setFlags(DEFAULT_CONTINUE.claude_flags);
  assert.equal(section.el.querySelectorAll('[data-testid="continue-note"]').length, 1);
  section.setExistingSessions(0);
  assert.equal(tid('continue-note', section.el), null);
  section.el.remove();
});

await run();

// chat/permission.ts: prompt kind, question parsing, the "don't ask again"
// choice and the response each answer sends (design 6.7). Rewritten from
// 69d8c70 permission.test.ts (vitest) plus describeSuggestion / buildAnswer /
// questionComplete cases from the test plan.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const P = await load('src/renderer/chat/permission.ts');
const { test, run } = runner('test-chat-permission');

// Shapes from probe V2 / V9 (evidence/probe-stream-json.md).
const addRules = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
const addDirs = { type: 'addDirectories', directories: ['/home/u/proj'], destination: 'session' };
const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
const bash = (suggestions) => ({
  subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test', description: 'Run tests' },
  ...(suggestions ? { permission_suggestions: suggestions } : {}),
});

test('classifyPermissionKind', () => {
  assert.equal(P.classifyPermissionKind('ExitPlanMode'), 'plan');
  assert.equal(P.classifyPermissionKind('AskUserQuestion'), 'question');
  assert.equal(P.classifyPermissionKind('Bash'), 'tool');
  assert.equal(P.classifyPermissionKind('Edit'), 'tool');
});

test('parsePermissionQuestions', () => {
  const qs = P.parsePermissionQuestions({
    questions: [
      { question: 'Which lib?', header: 'Lib', options: [{ label: 'date-fns' }, { label: 'dayjs', description: 'smaller' }], multiSelect: false },
      { question: 'Fruits?', options: ['Apple', { label: 'Banana' }], multiSelect: true },
    ],
  });
  assert.deepEqual(qs, [
    { question: 'Which lib?', header: 'Lib', options: [{ label: 'date-fns', description: undefined }, { label: 'dayjs', description: 'smaller' }], multiSelect: false },
    { question: 'Fruits?', header: undefined, options: [{ label: 'Apple' }, { label: 'Banana', description: undefined }], multiSelect: true },
  ]);
  assert.equal(P.parsePermissionQuestions({ command: 'ls' }), undefined);
  assert.equal(P.parsePermissionQuestions(null), undefined);
});

test('summarizePermissionInput', () => {
  assert.equal(P.summarizePermissionInput('Bash', { command: 'echo hi' }), 'echo hi');
  assert.equal(P.summarizePermissionInput('Edit', { file_path: '/tmp/a.ts' }), '/tmp/a.ts');
  assert.equal(P.summarizePermissionInput('Grep', { pattern: 'metaMu' }), 'metaMu');
});

test('describeSuggestion', () => {
  // All three kinds offered (V2): the rule wins, setMode is left out.
  const c = P.describeSuggestion(bash([addRules, addDirs, setMode]), '/cwd');
  assert.equal(c.kind, 'rules');
  assert.equal(c.labelKey, 'chat.perm.alwaysRules');
  assert.deepEqual(c.params, { rule: 'npm test', scope: '/home/u/proj' });
  assert.equal(c.destinationKey, 'chat.perm.dest.localSettings');
  assert.deepEqual(c.updatedPermissions, [addRules, addDirs]);
  // Without addDirectories the scope is the session's directory.
  const d = P.describeSuggestion(bash([addRules]), '/cwd');
  assert.equal(d.params.scope, '/cwd');
  assert.deepEqual(d.updatedPermissions, [addRules]);
  const proj = P.describeSuggestion(bash([{ ...addRules, destination: 'projectSettings' }]));
  assert.equal(proj.destinationKey, 'chat.perm.dest.projectSettings');
});

test('suggestion grouping', () => {
  // A rule suggestion mixed with setMode: sending must not switch the mode.
  const c = P.describeSuggestion(bash([setMode, addRules]));
  const a = P.buildAnswer(bash([setMode, addRules]), { kind: 'always', suggestion: c });
  assert.deepEqual(a.response.updatedPermissions, [addRules]);
  assert.ok(!a.response.updatedPermissions.some((s) => s.type === 'setMode'));
  assert.equal(a.setMode, undefined);
});

test('only setMode suggestion', () => {
  const c = P.describeSuggestion(bash([setMode]));
  assert.equal(c.kind, 'mode');
  assert.equal(c.labelKey, 'chat.perm.alwaysEdits', '"allow all edits in this session"');
  assert.equal(c.destinationKey, 'chat.perm.dest.session');
  const a = P.buildAnswer(bash([setMode]), { kind: 'always', suggestion: c });
  assert.deepEqual(a.response, { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' }, updatedPermissions: [setMode] });
});

test('no suggestions', () => {
  assert.equal(P.describeSuggestion(bash()), null, 'R5.2b: only allow / deny');
  assert.equal(P.describeSuggestion(bash([])), null);
  assert.equal(P.describeSuggestion(bash([addDirs])), null, 'directories alone are not a rule');
});

test('buildAnswer allow / deny', () => {
  assert.deepEqual(P.buildAnswer(bash(), { kind: 'allow' }), { response: { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } } });
  assert.deepEqual(P.buildAnswer(bash(), { kind: 'deny', message: ' 先别改这个文件 ' }), { response: { behavior: 'deny', message: '先别改这个文件' } });
  assert.deepEqual(P.buildAnswer(bash(), { kind: 'deny' }), { response: { behavior: 'deny', message: P.DEFAULT_DENY_MESSAGE } });
});

test('buildAnswer plan options', () => {
  const plan = { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan\n1. do it', planFilePath: '/p.md' }, requires_user_interaction: true };
  assert.deepEqual(P.buildAnswer(plan, { kind: 'plan', option: 1 }), { response: { behavior: 'allow', updatedInput: plan.input }, setMode: 'acceptEdits' });
  assert.deepEqual(P.buildAnswer(plan, { kind: 'plan', option: 2 }), { response: { behavior: 'allow', updatedInput: plan.input }, setMode: 'default' });
  const three = P.buildAnswer(plan, { kind: 'plan', option: 3, message: 'use a2' });
  assert.deepEqual(three, { response: { behavior: 'deny', message: 'use a2' } });
  assert.equal(three.setMode, undefined);
});

test('buildAnswer question', () => {
  const input = {
    questions: [
      { question: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }], multiSelect: false },
      { question: 'Which fruits do you like?', options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }], multiSelect: true },
      { question: 'Favorite color?', options: [{ label: 'Red' }], multiSelect: false },
    ],
  };
  const req = { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input };
  const questions = P.parsePermissionQuestions(input);
  const a = P.buildAnswer(req, {
    kind: 'question', questions,
    selections: [{ labels: ['Tea'] }, { labels: ['Apple', 'Banana'] }, { labels: [], other: 'Purple with green stripes' }],
  });
  // Single: label; multi: labels joined by ", "; other: the free text (V10).
  assert.deepEqual(a.response, {
    behavior: 'allow',
    updatedInput: {
      ...input,
      answers: { 'Tea or coffee?': 'Tea', 'Which fruits do you like?': 'Apple, Banana', 'Favorite color?': 'Purple with green stripes' },
    },
  });
});

test('questionComplete', () => {
  const questions = P.parsePermissionQuestions({ questions: [{ question: 'A?', options: [{ label: 'x' }] }, { question: 'B?', options: [{ label: 'y' }] }, { question: 'C?', options: [] }] });
  assert.deepEqual(P.questionComplete(questions, [{ labels: ['x'] }, undefined, { labels: [], other: '  ' }]), { complete: false, missing: [1, 2] });
  assert.deepEqual(P.questionComplete(questions, [{ labels: ['x'] }, { labels: ['y'] }, { labels: [], other: 'z' }]), { complete: true, missing: [] });
});

await run();

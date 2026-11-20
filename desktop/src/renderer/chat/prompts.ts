// Prompt cards for can_use_tool requests (R5–R7, design 6.7). A card replaces
// the composer while a request is open (prototype scenes 2 and 3): tool
// permission (allow / don't ask again / deny with a note), plan review (three
// options), and AskUserQuestion (single / multi / other, submit only when
// complete). Answers are built by permission.ts; the card only collects input
// and reflects the prompt state (open → submitting → closed / handled
// elsewhere). Text from claude is set with textContent; the plan goes through
// renderMarkdown (the sanitizing renderer).

import { t } from '../i18n';
import {
  describeSuggestion,
  parsePermissionQuestions,
  questionComplete,
  summarizePermissionInput,
  type AnswerChoice,
  type QuestionSelection,
} from './permission';
import { renderDiff } from './tools';
import type { Prompt, PromptState } from './types';

export interface PromptContext {
  /** Session working directory (scope of a "don't ask again" rule without directories). */
  cwd: string;
  renderMarkdown: (text: string) => DocumentFragment;
  /** The session's permission mode is fixed (bypass): plans are approved without switching it. */
  locked: boolean;
  onAnswer: (prompt: Prompt, choice: AnswerChoice) => void;
  onInterrupt: () => void;
}

export interface PromptCard {
  readonly el: HTMLElement;
  readonly requestId: string;
  update(state: PromptState, more: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function optionButton(key: string, label: string, testid: string, primary = false): HTMLButtonElement {
  const b = el('button', `opt${primary ? ' pri' : ''}`);
  b.type = 'button';
  b.dataset.testid = testid;
  b.append(el('span', 'k', key), el('span', 'o-label', label));
  return b;
}

function str(input: unknown, key: string): string {
  if (input && typeof input === 'object') {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Builds the card for a prompt. */
export function createPromptCard(prompt: Prompt, ctx: PromptContext): PromptCard {
  const root = el('div', 'perm');
  root.dataset.requestId = prompt.requestId;
  root.tabIndex = -1;
  const head = el('div', 'perm-h');
  const title = el('span', 'perm-title');
  const more = el('span', 'perm-more');
  head.append(title, more);
  const body = el('div', 'perm-body');
  const foot = el('div', 'perm-f');
  const footLeft = el('span');
  const footRight = el('span', 'perm-state');
  foot.append(footLeft, footRight);
  root.append(head, body, foot);

  // Everything the user can click or type in; disabled while submitting.
  const controls: (HTMLButtonElement | HTMLInputElement)[] = [];
  const keyed = new Map<string, () => void>();
  let refreshSubmit = () => {};
  // Question cards also keep their submit button off while an answer is in flight.
  let setBusy = (_busy: boolean) => {};

  const req = prompt.request;
  const input = req.input ?? {};

  if (prompt.kind === 'tool') {
    root.dataset.testid = 'chat-perm';
    const tool = prompt.toolName;
    const lower = tool.toLowerCase();
    const path = str(input, 'file_path') || str(input, 'notebook_path');
    if (lower === 'bash') {
      title.textContent = t('chat.perm.titleBash');
      body.appendChild(el('pre', 'perm-cmd', str(input, 'command')));
    } else if (path) {
      title.textContent = t('chat.perm.titleEdit', { file: baseName(path) });
      const diff = renderDiff(tool, input);
      if (diff) body.appendChild(diff);
      else body.appendChild(el('pre', 'perm-cmd', path));
    } else {
      title.textContent = t('chat.perm.titleTool', { tool });
      body.appendChild(el('pre', 'perm-cmd', summarizePermissionInput(tool, input)));
    }
    const desc = typeof req.description === 'string' ? req.description : '';
    if (desc) body.appendChild(el('div', 'perm-d', desc));

    const opts = el('div', 'opts');
    const allow = optionButton('1', t('chat.perm.allow'), 'chat-perm-allow', true);
    allow.addEventListener('click', () => ctx.onAnswer(prompt, { kind: 'allow' }));
    opts.appendChild(allow);
    controls.push(allow);
    keyed.set('1', () => allow.click());

    const suggestion = describeSuggestion(req, ctx.cwd);
    let denyKey = '2';
    if (suggestion) {
      const always = optionButton('2', t(suggestion.labelKey, suggestion.params), 'chat-perm-always');
      always.addEventListener('click', () => ctx.onAnswer(prompt, { kind: 'always', suggestion }));
      opts.appendChild(always);
      controls.push(always);
      keyed.set('2', () => always.click());
      denyKey = '3';
      footLeft.textContent =
        suggestion.kind === 'rules'
          ? t('chat.perm.saveTo', { where: t(suggestion.destinationKey) })
          : t('chat.perm.modeNote');
    }
    const rej = el('div', 'rej');
    const deny = optionButton(denyKey, t('chat.perm.deny'), 'chat-perm-deny');
    const note = el('input');
    note.type = 'text';
    note.dataset.testid = 'chat-perm-deny-text';
    note.placeholder = t('chat.perm.denyPlaceholder');
    note.setAttribute('aria-label', t('chat.perm.denyPlaceholder'));
    const sendDeny = () => ctx.onAnswer(prompt, { kind: 'deny', message: note.value });
    deny.addEventListener('click', sendDeny);
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        sendDeny();
      }
    });
    rej.append(deny, note);
    opts.appendChild(rej);
    controls.push(deny, note);
    keyed.set(denyKey, () => note.focus());
    body.appendChild(opts);
  } else if (prompt.kind === 'plan') {
    root.dataset.testid = 'chat-plan';
    title.textContent = t('chat.plan.title');
    const doc = el('div', 'plan-doc md');
    doc.appendChild(ctx.renderMarkdown(str(input, 'plan')));
    body.appendChild(doc);
    const opts = el('div', 'opts');
    // A locked (bypass) session keeps its mode: one plain approve option
    // (no setMode) instead of the two mode-switching ones.
    const approves: HTMLButtonElement[] = [];
    if (ctx.locked) {
      const ok = optionButton('1', t('chat.plan.approve'), 'chat-plan-approve', true);
      ok.addEventListener('click', () => ctx.onAnswer(prompt, { kind: 'planApprove' }));
      approves.push(ok);
    } else {
      const o1 = optionButton('1', t('chat.plan.opt1'), 'chat-plan-opt-1', true);
      o1.addEventListener('click', () => ctx.onAnswer(prompt, { kind: 'plan', option: 1 }));
      const o2 = optionButton('2', t('chat.plan.opt2'), 'chat-plan-opt-2');
      o2.addEventListener('click', () => ctx.onAnswer(prompt, { kind: 'plan', option: 2 }));
      approves.push(o1, o2);
    }
    const reviseKey = String(approves.length + 1);
    const rej = el('div', 'rej');
    const o3 = optionButton(reviseKey, t('chat.plan.opt3'), 'chat-plan-opt-3');
    const note = el('input');
    note.type = 'text';
    note.placeholder = t('chat.plan.revisePlaceholder');
    note.setAttribute('aria-label', t('chat.plan.revisePlaceholder'));
    const revise = () => ctx.onAnswer(prompt, { kind: 'plan', option: 3, message: note.value });
    o3.addEventListener('click', revise);
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        revise();
      }
    });
    rej.append(o3, note);
    opts.append(...approves, rej);
    body.appendChild(opts);
    controls.push(...approves, o3, note);
    approves.forEach((b, i) => keyed.set(String(i + 1), () => b.click()));
    keyed.set(reviseKey, () => note.focus());
    footLeft.textContent = ctx.locked ? t('chat.plan.noteLocked') : t('chat.plan.note');
  } else {
    root.dataset.testid = 'chat-question';
    root.classList.add('ask');
    title.textContent = t('chat.question.title');
    const questions = parsePermissionQuestions(input) ?? [];
    const selections: QuestionSelection[] = questions.map(() => ({ labels: [] }));
    const blocks: HTMLElement[] = [];
    questions.forEach((q, qi) => {
      const block = el('div', 'q');
      block.appendChild(el('div', 'qt', `${qi + 1}. ${q.question}`));
      const name = `q-${prompt.requestId}-${qi}`;
      const boxes: HTMLInputElement[] = [];
      const sync = () => {
        selections[qi].labels = boxes.filter((b) => b.checked && b.value !== '\0other').map((b) => b.value);
        const otherOn = boxes.some((b) => b.checked && b.value === '\0other');
        selections[qi].other = otherOn ? otherText.value : undefined;
        refreshSubmit();
      };
      const addOption = (value: string, label: string, description?: string) => {
        const row = el('label', 'qo');
        const box = el('input');
        box.type = q.multiSelect ? 'checkbox' : 'radio';
        box.name = name;
        box.value = value;
        box.addEventListener('change', sync);
        const copy = el('span');
        copy.appendChild(el('b', undefined, label));
        if (description) copy.appendChild(el('small', undefined, description));
        row.append(box, copy);
        block.appendChild(row);
        boxes.push(box);
        controls.push(box);
        return row;
      };
      for (const o of q.options) addOption(o.label, o.label, o.description);
      // "Other": free text, sent as the answer (R7.2, V10).
      const otherRow = addOption('\0other', t('chat.question.other'));
      const otherText = el('input', 'qo-other');
      otherText.type = 'text';
      otherText.placeholder = t('chat.question.otherPlaceholder');
      otherText.setAttribute('aria-label', t('chat.question.otherPlaceholder'));
      otherText.addEventListener('input', () => {
        const otherBox = boxes[boxes.length - 1];
        if (otherText.value && !otherBox.checked) {
          if (!q.multiSelect) for (const b of boxes) b.checked = false;
          otherBox.checked = true;
        }
        sync();
      });
      otherRow.appendChild(otherText);
      controls.push(otherText);
      blocks.push(block);
      body.appendChild(block);
    });
    const btns = el('div', 'btns');
    const submit = el('button', 'btn-p', t('chat.question.submit'));
    submit.type = 'button';
    submit.dataset.testid = 'chat-question-submit';
    const missingNote = el('small');
    btns.append(submit, missingNote);
    body.appendChild(btns);
    let busy = false;
    refreshSubmit = () => {
      const { complete, missing } = questionComplete(questions, selections);
      // Unanswered questions are marked and submit stays off (R7.3).
      blocks.forEach((b, i) => b.classList.toggle('missing', missing.includes(i)));
      missingNote.textContent = complete ? '' : t('chat.question.missing', { n: missing.map((i) => i + 1).join(', ') });
      submit.disabled = busy || !complete || questions.length === 0;
    };
    submit.addEventListener('click', () => {
      if (submit.disabled) return;
      ctx.onAnswer(prompt, { kind: 'question', questions, selections: selections.map((s) => ({ ...s, labels: [...s.labels] })) });
    });
    setBusy = (b: boolean) => {
      busy = b;
      refreshSubmit();
    };
    refreshSubmit();
  }

  // Digits pick options when focus is not in a text field; Esc interrupts (R8.2).
  root.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
    if (e.key === 'Escape') {
      e.preventDefault();
      ctx.onInterrupt();
      return;
    }
    if (!typing && keyed.has(e.key) && root.dataset.state === 'open') {
      e.preventDefault();
      keyed.get(e.key)!();
    }
  });

  const update = (state: PromptState, moreCount: number) => {
    root.dataset.state = state;
    const locked = state !== 'open';
    for (const c of controls) c.disabled = locked;
    setBusy(locked);
    footRight.textContent =
      state === 'submitting'
        ? t('chat.perm.submitting')
        : state === 'handledElsewhere'
          ? t('chat.perm.handledElsewhere')
          : t('chat.perm.escHint');
    more.textContent = moreCount > 0 ? t('chat.perm.more', { n: moreCount }) : '';
  };
  return { el: root, requestId: prompt.requestId, update };
}

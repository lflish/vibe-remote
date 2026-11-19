// session-form.ts — the form sections shared by the new-session dialogs (design
// 7.4): the interface cards, the launch options, and the worktree name field.
// Each returns its root element for the caller to put into a .modal-body.
// Everything shown comes from the daemon or the user, so it only ever goes into
// the DOM as textContent.
import type { SessionUI, WorktreePlan } from '../shared/protocol';
import type { ClaudeFlagInfo } from './rest';
import type { ChatAvailability } from './chat/availability';
import { t } from './i18n';
import { validateWorktreeName, worktreeErrorText } from './worktree-name';

const NAME_DEBOUNCE_MS = 250;

/** The terminal / chat cards with the reason the chat card is greyed out. */
export function createUiSection(opts: { onChange(): void }): {
  el: HTMLElement;
  value(): SessionUI;
  setAvailability(a: ChatAvailability): void;
} {
  // Terminal by default; chat only when the machine and the folder allow it.
  let ui: SessionUI = 'terminal';

  const box = el('div', 'modal-modes modal-ui');
  const title = el('div', 'modal-flags-title');
  title.textContent = t('picker.ui.title');
  const cards = el('div', 'modal-ui-cards');
  const termCard = uiCard('terminal', t('picker.ui.terminal.title'), t('picker.ui.terminal.desc'));
  const chatCard = uiCard('chat', t('picker.ui.chat.title'), t('picker.ui.chat.desc'), t('picker.ui.chat.only'));
  const chatReason = el('span', 'modal-ui-reason');
  chatReason.dataset.testid = 'picker-ui-chat-reason';
  chatCard.appendChild(chatReason);
  cards.append(termCard, chatCard);
  const note = el('div', 'modal-mode-note');
  const fixed = el('div', 'modal-mode-note');
  fixed.textContent = t('picker.ui.note.fixed');
  box.append(title, cards, note, fixed);

  function render() {
    termCard.setAttribute('aria-pressed', String(ui === 'terminal'));
    chatCard.setAttribute('aria-pressed', String(ui === 'chat'));
    note.textContent = ui === 'chat' ? t('picker.ui.note.chat') : t('picker.ui.note.terminal');
  }
  function choose(next: SessionUI) {
    ui = next;
    render();
    opts.onChange();
  }
  termCard.addEventListener('click', () => choose('terminal'));
  chatCard.addEventListener('click', () => {
    if (!chatCard.disabled) choose('chat');
  });
  render();

  return {
    el: box,
    value: () => ui,
    // Chat stays chosen when it becomes unavailable (the user browsed into a
    // folder it can't use); the caller keeps its confirm button disabled then.
    setAvailability(a) {
      chatCard.disabled = !a.enabled;
      chatCard.setAttribute('aria-disabled', String(!a.enabled));
      chatCard.classList.toggle('unavailable', !a.enabled);
      chatReason.hidden = a.enabled;
      chatReason.textContent = a.enabled || !a.reasonKey ? '' : t(a.reasonKey, a.params);
    },
  };
}

// The launch option that continues the directory's latest conversation. The
// daemon does not say which option that is; its own reload logic and the
// example config use this id for it.
const CONTINUE_FLAG_ID = 'continue';

/**
 * The launch-flag checkboxes. Empty until setFlags is called with at least one
 * flag. `existingSessions` is the number of live sessions already running in
 * the directory the new one will start in: with the continue option checked
 * and at least one such session, a note says what will happen (R6). It only
 * informs — whether that conversation is really in use is not known here.
 */
export function createFlagsSection(opts: { existingSessions: number }): {
  el: HTMLElement;
  setFlags(flags: ClaudeFlagInfo[]): void;
  value(): string[];
  setExistingSessions(n: number): void;
  setUI(ui: SessionUI): void;
} {
  let existingSessions = opts.existingSessions;
  const checks: Array<{ id: string; input: HTMLInputElement; row: HTMLElement }> = [];
  const box = el('div', 'modal-flags');
  // How -c / bypass behave in the chat interface.
  const chatNote = el('div', 'modal-mode-note modal-ui-flag-note');
  chatNote.textContent = t('picker.ui.flagNote');
  chatNote.hidden = true;
  const continueNote = el('div', 'modal-continue-note');
  continueNote.dataset.testid = 'continue-note';
  continueNote.setAttribute('role', 'note');
  continueNote.textContent = t('wt.session.continueNote');

  // In the DOM only while it applies, right under the option it is about.
  // `reveal`: the user has just ticked the option. In a short window the
  // options sit at the bottom edge of the dialog's scrolling body, so the note
  // would appear below the fold; bring it into view.
  function syncContinueNote(reveal = false) {
    const check = checks.find((c) => c.id === CONTINUE_FLAG_ID);
    if (check && check.input.checked && existingSessions > 0) {
      check.row.after(continueNote);
      if (reveal) continueNote.scrollIntoView?.({ block: 'nearest' });
    } else {
      continueNote.remove();
    }
  }

  return {
    el: box,
    setFlags(flags) {
      box.textContent = '';
      checks.length = 0;
      if (flags.length === 0) return;
      const title = el('div', 'modal-flags-title');
      title.textContent = t('picker.launchOptions');
      box.appendChild(title);
      for (const f of flags) {
        const row = el('label', 'modal-flag');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = `claude-flag-${f.id}`;
        input.checked = f.default === true;
        input.addEventListener('change', () => syncContinueNote(f.id === CONTINUE_FLAG_ID));
        const span = document.createElement('span');
        span.textContent = f.label;
        row.append(input, span);
        box.appendChild(row);
        checks.push({ id: f.id, input, row });
      }
      box.appendChild(chatNote);
      syncContinueNote();
    },
    value: () => checks.filter((c) => c.input.checked).map((c) => c.id),
    setExistingSessions(n) {
      existingSessions = n;
      syncContinueNote();
    },
    setUI(ui) {
      chatNote.hidden = ui !== 'chat';
    },
  };
}

/**
 * The worktree name field (R3.3–R3.6): the name is the new branch. What can be
 * judged without git is answered as the user types; the rest comes from
 * `plan` (GET /api/v1/worktrees/plan), asked once typing pauses. Answers that
 * arrive for an older value are dropped.
 *
 * `ready()`: the daemon has answered that the current value can be used.
 * `acceptable()`: the local rules have nothing against it (the daemon may not
 * have been asked yet). `refresh()` asks again for the current value — call it
 * when the section is first shown and whenever the directory `plan` works on
 * changes. `confirm()`
 * asks once more right away and returns the plan only if the name can be used;
 * otherwise the reason is shown under the field and it returns null.
 */
export function createNameSection(opts: { plan(name: string): Promise<WorktreePlan>; onChange(): void }): {
  el: HTMLElement;
  input: HTMLInputElement;
  value(): string;
  ready(): boolean;
  acceptable(): boolean;
  confirm(): Promise<WorktreePlan | null>;
  refresh(): void;
} {
  const box = el('div', 'modal-name');
  const label = document.createElement('label');
  label.className = 'modal-flags-title';
  label.textContent = t('wt.new.nameLabel');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-name-input';
  input.id = `wt-name-${++nameFieldSeq}`;
  input.dataset.testid = 'wt-name-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  label.htmlFor = input.id;
  const error = el('div', 'modal-name-error');
  error.dataset.testid = 'wt-name-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const baseInfo = el('div', 'modal-name-base');
  baseInfo.dataset.testid = 'wt-base-info';
  baseInfo.hidden = true;
  const target = el('div', 'modal-name-target');
  const targetLabel = el('span', 'modal-name-target-label');
  targetLabel.textContent = t('wt.new.target');
  const targetPath = el('code', 'modal-name-target-path');
  targetPath.dataset.testid = 'wt-target-path';
  target.append(targetLabel, targetPath);
  box.append(label, input, error, baseInfo, target);

  // An empty name is not called an error until the user has typed something.
  let touched = false;
  // not_git / unsupported_repo: no name can work here, the field is off.
  let blocked: string | null = null;
  let failure: string | null = null;
  let answer: { name: string; plan: WorktreePlan } | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    const name = input.value;
    let text = '';
    let path = '';
    if (blocked) {
      text = worktreeErrorText(blocked, {}) ?? blocked;
    } else {
      const problem = validateWorktreeName(name);
      if (problem) {
        text = problem === 'empty' && !touched ? '' : t(`wt.name.${problem}`);
      } else if (failure !== null) {
        text = failure;
      } else if (answer && answer.name === name) {
        const plan = answer.plan;
        if (plan.ok) path = plan.path ?? '';
        else text = worktreeErrorText(plan.error ?? '', { branch: name, path: plan.path, conflict: plan.conflict }) ?? plan.message ?? plan.error ?? '';
      }
    }
    input.disabled = blocked !== null;
    input.setAttribute('aria-invalid', String(text !== ''));
    error.textContent = text;
    error.hidden = text === '';
    target.hidden = blocked !== null;
    targetPath.textContent = path || '—';
  }

  function showBase(plan: WorktreePlan) {
    const base = plan.base;
    baseInfo.hidden = !base;
    if (!base) return;
    baseInfo.textContent = base.detached || !base.branch
      ? t('wt.new.baseDetached', { head: base.head })
      : t('wt.new.base', { branch: base.branch, head: base.head });
  }

  async function ask(name: string): Promise<WorktreePlan | null> {
    const mine = ++generation;
    try {
      const plan = await opts.plan(name);
      if (mine !== generation) return null;
      showBase(plan);
      blocked = plan.error === 'not_git' || plan.error === 'unsupported_repo' ? plan.error : null;
      failure = null;
      answer = { name, plan };
      return plan;
    } catch (e) {
      if (mine !== generation) return null;
      failure = t('wt.error.planFailed', { msg: e instanceof Error ? e.message : String(e) });
      answer = null;
      return null;
    } finally {
      if (mine === generation) {
        render();
        opts.onChange();
      }
    }
  }

  input.addEventListener('input', () => {
    touched = true;
    clearTimeout(timer);
    // Whatever is still in flight was asked about an older value.
    generation++;
    failure = null;
    answer = null;
    const name = input.value;
    if (!validateWorktreeName(name)) timer = setTimeout(() => void ask(name), NAME_DEBOUNCE_MS);
    render();
    opts.onChange();
  });

  render();

  return {
    el: box,
    input,
    value: () => input.value,
    ready: () => !blocked && answer !== null && answer.name === input.value && answer.plan.ok === true,
    // Nothing known here speaks against the name: confirm() may be asked.
    acceptable: () => !blocked && validateWorktreeName(input.value) === null,
    async confirm() {
      clearTimeout(timer);
      const name = input.value;
      if (blocked || validateWorktreeName(name)) {
        touched = true;
        render();
        return null;
      }
      const plan = await ask(name);
      return plan && plan.ok ? plan : null;
    },
    refresh() {
      clearTimeout(timer);
      const name = input.value;
      // A name the local rules refuse is not sent; an empty one still returns the base.
      void ask(validateWorktreeName(name) ? '' : name);
    },
  };
}

let nameFieldSeq = 0;

function uiCard(value: SessionUI, title: string, description: string, tag?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'modal-mode-card modal-ui-card';
  button.dataset.testid = `picker-ui-${value}`;
  button.dataset.ui = value;
  const head = el('span', 'modal-mode-title');
  head.textContent = title;
  if (tag) {
    const only = el('span', 'modal-ui-only');
    only.textContent = tag;
    head.appendChild(only);
  }
  const desc = el('span', 'modal-mode-description');
  desc.textContent = description;
  button.append(head, desc);
  return button;
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

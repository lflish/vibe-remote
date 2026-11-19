// worktree-dialogs.ts — the dialogs around worktrees (design 7.4). They share
// the picker's shell (.modal-overlay > .modal > header + .modal-body +
// .modal-footer) so the footer buttons stay reachable in a short window, and
// its form sections (session-form.ts). Names, paths, branches and error texts
// come from the daemon or the user and only ever go in as textContent.
import type { MachineConfig } from '../shared/protocol';
import { VibeRemoteRest, type ChatTrust, type MachineInfo } from './rest';
import type { PickedSession } from './dirpicker';
import type { TreeProject, TreeWorktree } from './tree';
import { t } from './i18n';
import { activateModal } from './modal';
import { chatAvailability } from './chat/availability';
import { createFlagsSection, createNameSection, createUiSection } from './session-form';

interface DialogShell {
  overlay: HTMLElement;
  modal: HTMLElement;
  heading: HTMLElement;
  subtitle: HTMLElement;
  body: HTMLElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
}

function dialogShell(testid: string, title: string, subtitleText: string, confirmText: string): DialogShell {
  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');
  modal.dataset.testid = testid;

  const header = el('div', 'modal-header');
  const heading = el('h2', 'modal-title');
  heading.textContent = title;
  const subtitle = el('div', 'modal-subtitle');
  subtitle.textContent = subtitleText;
  header.append(heading, subtitle);

  const body = el('div', 'modal-body');

  const footer = el('div', 'modal-footer');
  const cancel = button('btn-secondary', 'dialog-cancel', t('picker.cancel'));
  const confirm = button('btn-primary', 'dialog-confirm', confirmText);
  footer.append(cancel, confirm);

  modal.append(header, body, footer);
  overlay.appendChild(modal);
  return { overlay, modal, heading, subtitle, body, cancel, confirm };
}

/**
 * "New worktree" on a project row (R3): asks for the name (= the new branch),
 * the interface and the launch options. The worktree starts from the project's
 * main directory. Resolves with what to attach, or null when cancelled; a name
 * the daemon refuses at confirm keeps the dialog open with the reason shown.
 */
export function openNewWorktreeDialog(
  machine: MachineConfig,
  project: TreeProject,
): Promise<(PickedSession & { worktreeName: string; worktreePath: string }) | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    const main = project.worktrees.find((w) => w.main);
    const source = main?.path ?? project.id;
    const shell = dialogShell(
      'new-worktree-dialog',
      t('wt.new.title', { project: project.name }),
      t('wt.new.subtitle', { machine: machine.name, branch: main?.label ?? project.name }),
      t('wt.new.confirm'),
    );
    let info: MachineInfo | undefined;
    let infoError: unknown;
    let trust: ChatTrust | undefined;
    let confirming = false;
    let closed = false;

    const nameSection = createNameSection({ plan: (name) => rest.planWorktree(source, name), onChange: refresh });
    const uiSection = createUiSection({ onChange: refresh });
    // A new worktree has no sessions yet.
    const flagsSection = createFlagsSection({ existingSessions: 0 });
    shell.body.append(nameSection.el, uiSection.el, flagsSection.el);

    function refresh() {
      const a = chatAvailability(info, infoError, trust);
      const ui = uiSection.value();
      uiSection.setAvailability(a);
      flagsSection.setUI(ui);
      // The machine info has to be in (or have failed) first: confirming
      // earlier would drop the launch options that are on by default.
      const settled = info !== undefined || infoError !== undefined;
      shell.confirm.disabled = confirming || !settled || !nameSection.ready() || (ui === 'chat' && !a.enabled);
    }

    let deactivate = () => {};
    function close(result: (PickedSession & { worktreeName: string; worktreePath: string }) | null) {
      if (closed) return;
      closed = true;
      deactivate();
      shell.overlay.remove();
      resolve(result);
    }

    async function submit() {
      if (shell.confirm.disabled) return;
      // Ask once more: the name may have been taken since it was typed.
      confirming = true;
      refresh();
      const plan = await nameSection.confirm();
      confirming = false;
      if (closed) return;
      if (!plan || !plan.branch || !plan.path) {
        refresh();
        return;
      }
      close({
        mode: 'worktree',
        workdir: source,
        ui: uiSection.value(),
        flags: flagsSection.value(),
        worktreeName: plan.branch,
        worktreePath: plan.path,
      });
    }

    rest.info().then(
      (loaded) => {
        if (closed) return;
        info = loaded;
        flagsSection.setFlags(loaded.claude_flags || []);
        refresh();
      },
      (e: unknown) => {
        if (closed) return;
        infoError = e ?? new Error('info failed');
        refresh();
      },
    );
    // A chat session in the new worktree is allowed by the trust of the
    // directory it starts from (design 7.3).
    rest.listDir(source).then(
      (listing) => {
        if (closed) return;
        trust = listing.chatTrust;
        refresh();
      },
      () => { /* trust stays unknown: the chat card keeps its reason */ },
    );

    shell.cancel.addEventListener('click', () => close(null));
    shell.confirm.addEventListener('click', () => void submit());
    nameSection.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    });
    shell.overlay.addEventListener('click', (e) => {
      if (e.target === shell.overlay) close(null);
    });

    document.body.appendChild(shell.overlay);
    deactivate = activateModal(shell.overlay, shell.modal, shell.heading, nameSection.input, () => close(null));
    refresh();
    nameSection.refresh();
  });
}

// A worktree root counts as trusted when its project's main directory is, from
// protocol 4 on (design 7.3). An older daemon only looks at the directory itself.
const WORKTREE_TRUST_MIN_PROTO = 4;

/**
 * "New session" on a worktree row (R4): the directory is fixed, so the dialog
 * only asks for the interface and the launch options. A flat project passes
 * its one worktree, or a node made from the project itself when it is not a
 * git repository. Resolves with what to attach, or null when cancelled.
 *
 * `opts.sessionCountAt(workdir)` is the number of live sessions already running
 * in that directory.
 */
export function openWorktreeSessionDialog(
  machine: MachineConfig,
  project: TreeProject,
  worktree: TreeWorktree,
  opts?: { sessionCountAt?(workdir: string): number },
): Promise<PickedSession | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    const shell = dialogShell(
      'worktree-session-dialog',
      t('wt.session.title', { worktree: worktree.label }),
      t('wt.session.subtitle', { project: project.name, path: worktree.path }),
      t('wt.session.confirm'),
    );
    shell.subtitle.dataset.testid = 'session-dialog-path';
    shell.subtitle.classList.add('modal-subtitle-path');
    shell.subtitle.title = worktree.branch
      ? `${t('label.dir')}: ${worktree.path}\n${t('label.branch')}: ${worktree.branch}`
      : `${t('label.dir')}: ${worktree.path}`;
    let info: MachineInfo | undefined;
    let infoError: unknown;
    let trust: ChatTrust | undefined;
    let closed = false;

    const uiSection = createUiSection({ onChange: refresh });
    const flagsSection = createFlagsSection({ existingSessions: opts?.sessionCountAt?.(worktree.path) ?? 0 });
    shell.body.append(uiSection.el, flagsSection.el);

    // Where to send the user when the chat card is off for lack of trust: the
    // project's main directory, if this is another worktree of it and the
    // daemon applies the worktree rule.
    function mainPath(): string | undefined {
      if (!project.git || worktree.main || (info?.proto ?? 1) < WORKTREE_TRUST_MIN_PROTO) return undefined;
      return project.worktrees.find((w) => w.main)?.path;
    }

    function refresh() {
      const a = chatAvailability(info, infoError, trust, { mainPath: mainPath() });
      const ui = uiSection.value();
      uiSection.setAvailability(a);
      flagsSection.setUI(ui);
      // Wait for the machine info (or its failure): confirming earlier would
      // drop the launch options that are on by default.
      const settled = info !== undefined || infoError !== undefined;
      shell.confirm.disabled = !settled || (ui === 'chat' && !a.enabled);
    }

    let deactivate = () => {};
    function close(result: PickedSession | null) {
      if (closed) return;
      closed = true;
      deactivate();
      shell.overlay.remove();
      resolve(result);
    }

    rest.info().then(
      (loaded) => {
        if (closed) return;
        info = loaded;
        flagsSection.setFlags(loaded.claude_flags || []);
        refresh();
      },
      (e: unknown) => {
        if (closed) return;
        infoError = e ?? new Error('info failed');
        refresh();
      },
    );
    rest.listDir(worktree.path).then(
      (listing) => {
        if (closed) return;
        trust = listing.chatTrust;
        refresh();
      },
      () => { /* trust stays unknown: the chat card keeps its reason */ },
    );

    shell.cancel.addEventListener('click', () => close(null));
    shell.confirm.addEventListener('click', () => {
      if (shell.confirm.disabled) return;
      close({ mode: 'normal', workdir: worktree.path, ui: uiSection.value(), flags: flagsSection.value() });
    });
    shell.overlay.addEventListener('click', (e) => {
      if (e.target === shell.overlay) close(null);
    });

    document.body.appendChild(shell.overlay);
    const termCard = uiSection.el.querySelector<HTMLElement>('[data-testid="picker-ui-terminal"]')!;
    deactivate = activateModal(shell.overlay, shell.modal, shell.heading, termCard, () => close(null));
    refresh();
  });
}

function button(className: string, testid: string, text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.dataset.testid = testid;
  btn.textContent = text;
  return btn;
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

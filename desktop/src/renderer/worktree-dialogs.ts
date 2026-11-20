// worktree-dialogs.ts — the dialogs around worktrees (design 7.4). They share
// the picker's shell (.modal-overlay > .modal > header + .modal-body +
// .modal-footer) so the footer buttons stay reachable in a short window, and
// its form sections (session-form.ts). Names, paths, branches and error texts
// come from the daemon or the user and only ever go in as textContent.
import type { MachineConfig, WorktreeRemoveRequest, WorktreeStatus } from '../shared/protocol';
import { RestError, VibeRemoteRest, type ChatTrust, type MachineInfo } from './rest';
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
  footer: HTMLElement;
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
  subtitle.hidden = subtitleText === '';
  header.append(heading, subtitle);

  const body = el('div', 'modal-body');

  const footer = el('div', 'modal-footer');
  const cancel = button('btn-secondary', 'dialog-cancel', t('picker.cancel'));
  const confirm = button('btn-primary', 'dialog-confirm', confirmText);
  footer.append(cancel, confirm);

  modal.append(header, body, footer);
  overlay.appendChild(modal);
  return { overlay, modal, heading, subtitle, body, footer, cancel, confirm };
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

    // Everything but the name allows confirming. The machine info has to be in
    // (or have failed) first: confirming earlier would drop the launch options
    // that are on by default.
    function submittable(): boolean {
      const settled = info !== undefined || infoError !== undefined;
      const chatOff = uiSection.value() === 'chat' && !chatAvailability(info, infoError, trust).enabled;
      return !confirming && settled && !chatOff;
    }

    function refresh() {
      const a = chatAvailability(info, infoError, trust);
      const ui = uiSection.value();
      uiSection.setAvailability(a);
      flagsSection.setUI(ui);
      shell.confirm.disabled = !submittable() || !nameSection.ready();
    }

    let deactivate = () => {};
    function close(result: (PickedSession & { worktreeName: string; worktreePath: string }) | null) {
      if (closed) return;
      closed = true;
      deactivate();
      shell.overlay.remove();
      resolve(result);
    }

    // The button is on once the pre-check of the name has answered. Enter in
    // the name field does not wait for that (typing a name and pressing Enter
    // is one motion): a name the local rules accept is submitted, and the
    // check below decides. A refusal shows under the field as usual.
    async function submit() {
      if (!submittable() || !nameSection.acceptable()) return;
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

/**
 * Puts a confirmation on screen. The focus starts on `initial()`, the default
 * button; Enter runs the button that has the focus, or the default one when
 * the focus is elsewhere in the dialog. Escape, the Cancel button and a click
 * outside all call `cancel`. Returns `{ close, markDefault }`: `close` takes the
 * dialog down, `markDefault` re-reads `initial()` after the dialog changed.
 */
function showConfirm(shell: DialogShell, initial: () => HTMLButtonElement, cancel: () => void): { close(): void; markDefault(): void } {
  const buttons = [shell.cancel, shell.confirm];
  const markDefault = () => {
    const def = initial();
    for (const b of buttons) b.toggleAttribute('data-default', b === def);
  };
  shell.overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const target = e.target as HTMLElement | null;
    const focused = target && target.tagName === 'BUTTON' && shell.modal.contains(target) ? (target as HTMLButtonElement) : initial();
    if (!focused.disabled) focused.click();
  });
  shell.overlay.addEventListener('click', (e) => {
    if (e.target === shell.overlay) cancel();
  });
  shell.cancel.addEventListener('click', cancel);
  markDefault();
  document.body.appendChild(shell.overlay);
  const deactivate = activateModal(shell.overlay, shell.modal, shell.heading, initial(), cancel);
  return {
    close() {
      deactivate();
      shell.overlay.remove();
    },
    markDefault,
  };
}

/**
 * Confirms deleting a session (R5.1). Resolves true only when the delete
 * button is used; the focus starts on Cancel, so Enter right away cancels.
 *
 * `chat`: a chat session. Its conversation stays in claude's own history
 * files on the remote machine, so the text says that instead of "this cannot
 * be undone".
 *
 * `worktreeLabel` is passed for a session under a worktree other than the main
 * directory: the dialog then says the worktree and its branch stay.
 * `legacyWorktree` is for a worktree-mode session on a daemon older than
 * protocol 4, which removes a clean worktree and its branch with the session
 * (R9.1); that note replaces the other one. `unknownWorktree` is for such a
 * session on a daemon whose version is not known yet: the note then says both
 * things can happen, instead of promising either.
 */
export function confirmDeleteSession(opts: { name: string; chat?: boolean; worktreeLabel?: string; legacyWorktree: boolean; unknownWorktree?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = dialogShell('delete-session-dialog', t('session.delete.title', { name: opts.name }), '', t('session.delete.confirm'));
    shell.confirm.classList.add('btn-danger');
    const text = el('div', 'modal-confirm');
    text.appendChild(paragraph(t(opts.chat ? 'session.delete.chatBody' : 'session.delete.body')));
    const note = opts.legacyWorktree
      ? t('session.delete.legacyWorktree')
      : opts.unknownWorktree
        ? t('session.delete.unknownWorktree')
        : opts.worktreeLabel
          ? t('session.delete.keepsWorktree', { worktree: opts.worktreeLabel })
          : '';
    if (note) text.appendChild(paragraph(note, 'delete-session-note'));
    shell.body.appendChild(text);

    let closed = false;
    const finish = (confirmed: boolean) => {
      if (closed) return;
      closed = true;
      shown.close();
      resolve(confirmed);
    };
    shell.confirm.addEventListener('click', () => finish(true));
    const shown = showConfirm(shell, () => shell.cancel, () => finish(false));
  });
}

/**
 * Confirms deleting a worktree (design 6.2). `status` is what the daemon just
 * reported; the dialog shows every part of it that means something is lost and
 * resolves with the request to send — what the user saw (`head`, `sessions`,
 * `branch`) plus what they agreed to — or null when cancelled.
 *
 * Uncommitted files, or commits of a detached worktree that are on no branch,
 * are lost for good: the dialog then warns, its confirm button is "Delete
 * anyway" and Enter cancels. Unmerged commits on a branch vibe-remote created
 * come with a choice, "keep the branch" preselected; Enter deletes only while
 * nothing irrecoverable is selected or shown. A worktree vibe-remote did not
 * create never loses its branch.
 *
 * `opts.changed`: this is a re-confirmation after the state changed.
 * `opts.error`: the last attempt failed with this message. `opts.ended`:
 * sessions this flow has already ended.
 */
export function confirmDeleteWorktree(
  status: WorktreeStatus,
  opts: { label: string; changed: boolean; error?: string; ended?: number },
): Promise<WorktreeRemoveRequest | null> {
  return new Promise((resolve) => {
    const branch = status.detached ? undefined : status.branch;
    const files = status.dirtyFiles > 0;
    const unmerged = status.unmergedCommits;
    const strayCommits = !branch && unmerged > 0; // on no branch once the directory is gone
    const branchChoice = !!branch && status.managed && unmerged > 0;
    const warns = files || strayCommits;
    const variant = files ? 'files' : strayCommits ? 'detached' : branchChoice ? 'commits' : !status.managed ? 'external' : 'clean';
    const title = variant === 'files' ? t('wt.delete.title.files', { name: opts.label })
      : variant === 'detached' ? t('wt.delete.title.detached', { name: opts.label, n: unmerged })
      : variant === 'commits' ? t('wt.delete.title.commits', { name: opts.label, n: unmerged })
      : t('wt.delete.title.clean', { name: opts.label });

    const shell = dialogShell('delete-wt-dialog', title, '', warns ? t('wt.delete.force') : t('wt.delete.confirm'));
    shell.modal.dataset.variant = variant;
    const text = el('div', 'modal-confirm');
    shell.body.appendChild(text);
    const line = (className: string, content: string, testid?: string) => {
      const p = paragraph(content, testid);
      p.classList.add(className);
      text.appendChild(p);
    };

    if (opts.error !== undefined) line('modal-alert', t('wt.delete.failed', { msg: opts.error }), 'delete-wt-error');
    if (opts.changed) line('modal-notice', t('wt.delete.changed'), 'delete-wt-changed');
    if (opts.ended && opts.ended > 0) line('modal-notice', t('wt.delete.ended', { n: opts.ended }), 'delete-wt-ended');
    if (files) line('modal-warning', t('wt.delete.files', { n: status.dirtyFiles }), 'delete-wt-files');
    if (strayCommits) line('modal-warning', t('wt.delete.detached', { n: unmerged }), 'delete-wt-commits');
    if (status.sessions.length > 0) line('modal-plain', t('wt.delete.sessions', { n: status.sessions.length }), 'delete-wt-sessions');

    let deleteBranchChoice: HTMLInputElement | null = null;
    if (branchChoice) {
      line('modal-plain', t('wt.delete.commits', { n: unmerged }), 'delete-wt-commits');
      const group = el('div', 'modal-options');
      group.setAttribute('role', 'radiogroup');
      const keep = radioOption('delete-wt-keep-branch', t('wt.delete.keepBranch'), t('wt.delete.keepBranchDesc', { branch: branch! }));
      const drop = radioOption('delete-wt-delete-branch', t('wt.delete.deleteBranch'), t('wt.delete.deleteBranchDesc', { n: unmerged }));
      keep.input.checked = true;
      deleteBranchChoice = drop.input;
      group.append(keep.el, drop.el);
      text.appendChild(group);
    }
    if (!status.managed) {
      line('modal-plain', branch ? t('wt.delete.external', { branch }) : t('wt.delete.externalDetached'), 'delete-wt-external');
    }
    if (!files && unmerged === 0) {
      if (!branch) line('modal-plain', t('wt.delete.cleanDetached'));
      else if (status.managed) line('modal-plain', t('wt.delete.clean'));
    } else if (files && branch && status.managed && unmerged === 0) {
      // Nothing else on screen would say that the branch goes too.
      line('modal-plain', t('wt.delete.branchToo', { branch }));
    }
    if (status.ignoredFiles > 0) line('modal-note', t('wt.delete.ignored', { n: status.ignoredFiles }), 'delete-wt-ignored');
    else if (status.ignoredFiles < 0) line('modal-note', t('wt.delete.ignoredUnknown'), 'delete-wt-ignored');
    text.appendChild(keyValues([[t('label.dir'), status.path], [t('label.branch'), branch ?? '']]));

    if (warns) {
      // The dangerous button steps back: outlined, left of Cancel, and Cancel
      // is the one Enter presses.
      shell.confirm.dataset.testid = 'delete-wt-force';
      shell.confirm.className = 'btn-secondary btn-danger-outline';
      shell.cancel.className = 'btn-primary btn-neutral';
      const hint = el('span', 'modal-footer-hint');
      hint.textContent = t('wt.delete.cancelDefault');
      shell.footer.replaceChildren(hint, shell.confirm, shell.cancel);
    } else {
      shell.confirm.classList.add('btn-danger');
    }

    const request = (): WorktreeRemoveRequest => {
      const req: WorktreeRemoveRequest = { path: status.path, head: status.head, sessions: [...status.sessions] };
      // What the dialog showed: the daemon refuses if it is another branch by now.
      if (branch) req.branch = branch;
      if (files) req.discardFiles = true;
      if (branch && status.managed) {
        if (unmerged === 0) {
          req.deleteBranch = true;
        } else if (deleteBranchChoice?.checked) {
          req.deleteBranch = true;
          req.dropCommits = true;
        }
      }
      if (strayCommits) req.dropCommits = true;
      return req;
    };

    let closed = false;
    const finish = (result: WorktreeRemoveRequest | null) => {
      if (closed) return;
      closed = true;
      shown.close();
      resolve(result);
    };
    shell.confirm.addEventListener('click', () => finish(request()));
    // Enter must never cause a loss that cannot be undone (H22, d25).
    const defaultButton = () => (warns || deleteBranchChoice?.checked ? shell.cancel : shell.confirm);
    const shown = showConfirm(shell, defaultButton, () => finish(null));
    text.addEventListener('change', () => shown.markDefault());
  });
}

/**
 * Tells the user that a removal failed after git had already dropped the
 * worktree from its list (R5.12): what git said, how many sessions were ended,
 * where the rest of the directory is, and that the branch was kept. One button.
 */
export function showDeleteWorktreeFailure(opts: { label: string; message: string; ended: number; path: string }): Promise<void> {
  return new Promise((resolve) => {
    const shell = dialogShell('delete-wt-failed', t('wt.delete.failedTitle', { name: opts.label }), '', '');
    shell.cancel.textContent = t('wt.delete.close');
    shell.cancel.className = 'btn-primary btn-neutral';
    shell.footer.replaceChildren(shell.cancel);
    const text = el('div', 'modal-confirm');
    const error = paragraph(t('wt.delete.failed', { msg: opts.message }), 'delete-wt-error');
    error.classList.add('modal-alert');
    text.appendChild(error);
    if (opts.ended > 0) {
      const ended = paragraph(t('wt.delete.ended', { n: opts.ended }), 'delete-wt-ended');
      ended.classList.add('modal-notice');
      text.appendChild(ended);
    }
    const partial = paragraph(t('wt.delete.partial', { path: opts.path }), 'delete-wt-partial');
    partial.classList.add('modal-plain');
    text.appendChild(partial);
    shell.body.appendChild(text);

    let closed = false;
    const shown = showConfirm(shell, () => shell.cancel, () => {
      if (closed) return;
      closed = true;
      shown.close();
      resolve();
    });
  });
}

/** What a delete-worktree flow did: whether the worktree is gone, and which sessions were ended on the way. */
export type DeleteWorktreeOutcome = { removed: boolean; endedSessions: string[] };

/**
 * Deletes a worktree with the user's consent: reads its state, confirms, asks
 * the daemon, and goes round again when the daemon answers that the state is
 * no longer what was confirmed (409) or that the removal failed (500).
 *
 * Returns null only when no removal was ever requested (cancelled at the first
 * confirmation, or the worktree was already gone). Once a request went out the
 * result is never null: sessions may have been ended even though the worktree
 * is still there, and the caller has to close their views and refresh.
 * `notify` shows one line of text (the status bar). `onRequest(true)` is called
 * when a removal request goes out and `onRequest(false, removed)` when its
 * outcome is known (it can take the daemon many seconds): the caller shows the
 * worktree as being deleted in between. It is not in flight while a dialog is
 * open. `removed` says the worktree is gone: the caller's list still has its
 * row then, and the caller keeps showing it as being deleted until it has
 * refreshed that list.
 */
export async function deleteWorktreeFlow(
  rest: Pick<VibeRemoteRest, 'worktreeStatus' | 'removeWorktree'>,
  target: { path: string; label: string },
  notify: (text: string) => void,
  onRequest?: (inFlight: boolean, removed?: boolean) => void,
): Promise<DeleteWorktreeOutcome | null> {
  let inFlight = false;
  let removed = false;
  const setInFlight = (value: boolean) => {
    if (inFlight === value) return;
    inFlight = value;
    onRequest?.(value, removed);
  };
  const ended: string[] = [];
  const addEnded = (ids: unknown) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === 'string' && !ended.includes(id)) ended.push(id);
  };
  const outcome = (isRemoved: boolean): DeleteWorktreeOutcome => {
    // Read by setInFlight(false) on the way out.
    removed = isRemoved;
    return { removed: isRemoved, endedSessions: [...ended] };
  };
  const gone = (e: unknown) => e instanceof RestError && e.status === 404;

  let status: WorktreeStatus;
  try {
    status = await rest.worktreeStatus(target.path);
  } catch (e) {
    notify(gone(e) ? t('wt.delete.gone') : t('wt.delete.failed', { msg: errorText(e) }));
    return null;
  }

  let requested = false;
  let changed = false;
  let error: string | undefined;
  for (;;) {
    const req = await confirmDeleteWorktree(status, { label: target.label, changed, error, ended: ended.length });
    if (!req) return requested ? outcome(false) : null;
    requested = true;
    setInFlight(true);
    try {
      const res = await rest.removeWorktree(req);
      addEnded(res.endedSessions);
      if (res.branchError) notify(t('wt.delete.branchKept', { msg: res.branchError }));
      return outcome(true);
    } catch (e) {
      if (!(e instanceof RestError)) {
        // Timeout or network failure: the daemon carries a removal through
        // regardless, so the outcome is unknown. Look once.
        try {
          await rest.worktreeStatus(target.path);
        } catch (again) {
          if (gone(again)) {
            addEnded(req.sessions);
            return outcome(true);
          }
        }
        notify(t('wt.delete.timeout'));
        return outcome(false);
      }
      const body = (e.body ?? {}) as { message?: unknown; status?: WorktreeStatus; endedSessions?: unknown };
      addEnded(body.endedSessions);
      const message = typeof body.message === 'string' && body.message ? body.message : e.code;
      if (e.status === 409 && body.status) {
        status = body.status;
        changed = true;
        error = undefined;
        continue;
      }
      if (e.status === 404) {
        // Someone else removed it since the confirmation. The daemon answers
        // 404 before it ends anything, so the sessions the confirmation listed
        // may well be running still: only what an earlier answer of this flow
        // reported as ended is passed on.
        notify(t('wt.delete.gone'));
        return outcome(true);
      }
      if (e.status < 500) {
        notify(t('wt.delete.failed', { msg: message }));
        return outcome(false);
      }
      // Failed: show what is actually left (R5.12).
      try {
        status = await rest.worktreeStatus(target.path);
      } catch (again) {
        if (gone(again)) {
          // git no longer lists it: only part of the directory can be left.
          setInFlight(false);
          await showDeleteWorktreeFailure({ label: target.label, message, ended: ended.length, path: target.path });
        } else {
          notify(t('wt.delete.failed', { msg: message }));
        }
        return outcome(false);
      }
      changed = false;
      error = message;
    } finally {
      // Before the next dialog, and on every way out.
      setInFlight(false);
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof RestError) {
    const message = (e.body as { message?: unknown } | undefined)?.message;
    return typeof message === 'string' && message ? message : e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A radio button presented as a card with a title and a line of explanation. */
function radioOption(testid: string, title: string, description: string): { el: HTMLElement; input: HTMLInputElement } {
  const label = el('label', 'modal-option');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'delete-wt-branch';
  input.dataset.testid = testid;
  const words = el('span', 'modal-option-text');
  const head = el('span', 'modal-option-title');
  head.textContent = title;
  const desc = el('span', 'modal-option-description');
  desc.textContent = description;
  words.append(head, desc);
  label.append(input, words);
  return { el: label, input };
}

/** A small "label: value" list; rows with an empty value are left out. */
function keyValues(rows: [string, string][]): HTMLElement {
  const list = el('dl', 'modal-kv');
  for (const [key, value] of rows) {
    if (!value) continue;
    const dt = el('dt');
    dt.textContent = key;
    const dd = el('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

function paragraph(text: string, testid?: string): HTMLElement {
  const p = el('p', 'modal-confirm-text');
  p.textContent = text;
  if (testid) p.dataset.testid = testid;
  return p;
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

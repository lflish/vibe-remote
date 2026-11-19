// session-form.ts — the form sections shared by the new-session dialogs.
import type { SessionUI, WorktreePlan } from '../shared/protocol';
import type { ClaudeFlagInfo } from './rest';
import type { ChatAvailability } from './chat/availability';

export function createUiSection(_opts: { onChange(): void }): {
  el: HTMLElement; value(): SessionUI; setAvailability(a: ChatAvailability): void;
} {
  return { el: document.createElement('div'), value: () => 'terminal', setAvailability: () => {} };
}

export function createFlagsSection(_opts: { existingSessions: number }): {
  el: HTMLElement; setFlags(flags: ClaudeFlagInfo[]): void; value(): string[]; setExistingSessions(n: number): void; setUI(ui: SessionUI): void;
} {
  return { el: document.createElement('div'), setFlags: () => {}, value: () => [], setExistingSessions: () => {}, setUI: () => {} };
}

export function createNameSection(_opts: { plan(name: string): Promise<WorktreePlan>; onChange(): void }): {
  el: HTMLElement; value(): string; ready(): boolean; confirm(): Promise<WorktreePlan | null>; refresh(): void;
} {
  return { el: document.createElement('div'), value: () => '', ready: () => false, confirm: async () => null, refresh: () => {} };
}

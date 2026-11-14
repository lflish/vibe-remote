// Prompt logic for can_use_tool requests: kind, question parsing, the
// "don't ask again" choice, and the response each answer sends. Pure, zero DOM.
//
// Ported from 69d8c70:packages/core/src/chat/permission.ts; the input is now
// claude's raw can_use_tool request (design 4.12), and describeSuggestion /
// buildAnswer / questionComplete implement design 6.7.

import type { ChatResponse } from '../../shared/protocol';
import type { CanUseToolRequest, PromptKind, Question, QuestionOption } from './types';

/** Prompt card kind from the tool name. */
export function classifyPermissionKind(toolName: string): PromptKind {
  const n = toolName.trim();
  if (n === 'ExitPlanMode' || n === 'exit_plan_mode') return 'plan';
  if (n === 'AskUserQuestion' || n === 'ask_user_question') return 'question';
  return 'tool';
}

/** AskUserQuestion questions from the request input; undefined when the shape does not match. */
export function parsePermissionQuestions(input: unknown): Question[] | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const out: Question[] = [];
  for (const q of questions) {
    if (q == null || typeof q !== 'object') continue;
    const rec = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    const text = typeof rec.question === 'string' ? rec.question : typeof rec.header === 'string' ? rec.header : '';
    if (!text) continue;
    const opts: QuestionOption[] = [];
    if (Array.isArray(rec.options)) {
      for (const o of rec.options) {
        if (typeof o === 'string' && o.trim()) {
          opts.push({ label: o.trim() });
          continue;
        }
        if (o != null && typeof o === 'object') {
          const label = (o as { label?: unknown }).label;
          const description = (o as { description?: unknown }).description;
          if (typeof label === 'string' && label.trim()) {
            opts.push({ label: label.trim(), description: typeof description === 'string' ? description : undefined });
          }
        }
      }
    }
    out.push({
      question: text,
      header: typeof rec.header === 'string' ? rec.header : undefined,
      options: opts,
      multiSelect: rec.multiSelect === true,
    });
  }
  return out.length ? out : undefined;
}

/** Short summary for a tool prompt (Bash shows the command, Edit the path…). */
export function summarizePermissionInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return input == null ? '' : String(input);
  const obj = input as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };
  let primary: string | undefined;
  if (name === 'bash' || name === 'shell') primary = pick('command', 'cmd');
  else if (name.includes('edit') || name === 'write' || name === 'read' || name === 'notebookedit') {
    primary = pick('file_path', 'path', 'notebook_path');
  } else if (name === 'glob' || name === 'grep') primary = pick('pattern', 'path');
  else if (name === 'webfetch') primary = pick('url');
  if (primary) return primary;
  try {
    const raw = JSON.stringify(input);
    return raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
  } catch {
    return '';
  }
}

type Suggestion = Record<string, unknown>;

function suggestionsOf(request: CanUseToolRequest): Suggestion[] {
  const list = request.permission_suggestions;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is Suggestion => s != null && typeof s === 'object' && !Array.isArray(s));
}

const DESTINATIONS = ['localSettings', 'projectSettings', 'userSettings', 'session'] as const;

/**
 * The "allow and don't ask again" option for a tool prompt (R5.2 / R5.2b).
 *  - kind 'rules': addRules suggestions exist. Label "don't ask again for <rule>
 *    in <scope>"; sends every addRules + addDirectories suggestion and never
 *    the setMode one in the same request (that would also switch the mode).
 *  - kind 'mode': only a setMode suggestion. Label "allow all edits in this
 *    session" (acceptEdits); sends just that suggestion.
 * Returns null when claude offered nothing saveable: then only allow / deny.
 * Keys are i18n keys; params fill their {placeholders}.
 */
export interface SuggestionChoice {
  kind: 'rules' | 'mode';
  labelKey: string;
  params: Record<string, string>;
  /** Where claude will save it: chat.perm.dest.<destination>. */
  destinationKey: string;
  /** Sent as response.updatedPermissions; each item is one of claude's suggestions verbatim. */
  updatedPermissions: unknown[];
}

function destinationKey(dest: unknown): string {
  return typeof dest === 'string' && (DESTINATIONS as readonly string[]).includes(dest)
    ? `chat.perm.dest.${dest}`
    : 'chat.perm.dest.other';
}

export function describeSuggestion(request: CanUseToolRequest, cwd = ''): SuggestionChoice | null {
  const all = suggestionsOf(request);
  const rules = all.filter((s) => s.type === 'addRules');
  const dirs = all.filter((s) => s.type === 'addDirectories');
  if (rules.length) {
    const ruleTexts: string[] = [];
    for (const s of rules) {
      const list = Array.isArray(s.rules) ? s.rules : [];
      for (const r of list) {
        if (r == null || typeof r !== 'object') continue;
        const rec = r as { toolName?: unknown; ruleContent?: unknown };
        const tool = typeof rec.toolName === 'string' ? rec.toolName : request.tool_name ?? '';
        ruleTexts.push(typeof rec.ruleContent === 'string' && rec.ruleContent ? rec.ruleContent : tool);
      }
    }
    const dirTexts: string[] = [];
    for (const s of dirs) {
      if (Array.isArray(s.directories)) {
        for (const d of s.directories) if (typeof d === 'string' && d) dirTexts.push(d);
      }
    }
    return {
      kind: 'rules',
      labelKey: 'chat.perm.alwaysRules',
      params: { rule: ruleTexts.join(', '), scope: dirTexts.length ? dirTexts.join(', ') : cwd },
      destinationKey: destinationKey(rules[0].destination),
      updatedPermissions: [...rules, ...dirs],
    };
  }
  const mode = all.find((s) => s.type === 'setMode');
  if (mode) {
    const m = typeof mode.mode === 'string' ? mode.mode : '';
    return {
      kind: 'mode',
      labelKey: m === 'acceptEdits' ? 'chat.perm.alwaysEdits' : 'chat.perm.alwaysMode',
      params: { mode: m },
      destinationKey: destinationKey(mode.destination),
      updatedPermissions: [mode],
    };
  }
  return null;
}

/** One question's selection: chosen option labels plus optional free text ("other"). */
export interface QuestionSelection {
  labels: string[];
  other?: string;
}

/** What the user picked on a prompt card. */
export type AnswerChoice =
  | { kind: 'allow' }
  | { kind: 'always'; suggestion: SuggestionChoice }
  | { kind: 'deny'; message?: string }
  // ExitPlanMode: 1 approve + auto-accept edits, 2 approve + ask before edits,
  // 3 keep planning (message = what to change).
  | { kind: 'plan'; option: 1 | 2 | 3; message?: string }
  | { kind: 'question'; questions: Question[]; selections: QuestionSelection[] };

export interface Answer {
  response: ChatResponse;
  setMode?: 'acceptEdits' | 'default';
}

// Sent to claude (not shown in the UI) when the user denies without a note.
export const DEFAULT_DENY_MESSAGE = 'The user declined this request.';
export const DEFAULT_REVISE_MESSAGE = 'The user wants to keep refining the plan before starting.';

function selectionValue(sel: QuestionSelection | undefined): string {
  if (!sel) return '';
  const values = [...sel.labels];
  const other = sel.other?.trim();
  if (other) values.push(other);
  return values.join(', ');
}

/** Builds the chat_respond payload for a choice (design 6.7). */
export function buildAnswer(request: CanUseToolRequest, choice: AnswerChoice): Answer {
  const input = (request.input ?? {}) as Record<string, unknown>;
  switch (choice.kind) {
    case 'allow':
      return { response: { behavior: 'allow', updatedInput: input } };
    case 'always':
      return {
        response: { behavior: 'allow', updatedInput: input, updatedPermissions: choice.suggestion.updatedPermissions },
      };
    case 'deny':
      return { response: { behavior: 'deny', message: choice.message?.trim() || DEFAULT_DENY_MESSAGE } };
    case 'plan':
      if (choice.option === 3) {
        return { response: { behavior: 'deny', message: choice.message?.trim() || DEFAULT_REVISE_MESSAGE } };
      }
      return {
        response: { behavior: 'allow', updatedInput: input },
        setMode: choice.option === 1 ? 'acceptEdits' : 'default',
      };
    case 'question': {
      // Multi-select joins labels with ", " and "other" is free text; claude
      // takes any string (V10).
      const answers: Record<string, string> = {};
      choice.questions.forEach((q, i) => {
        answers[q.question] = selectionValue(choice.selections[i]);
      });
      return { response: { behavior: 'allow', updatedInput: { ...input, answers } } };
    }
  }
}

/** Whether every question has an answer; `missing` lists unanswered question indexes (0-based). */
export function questionComplete(
  questions: Question[],
  selections: (QuestionSelection | undefined)[],
): { complete: boolean; missing: number[] } {
  const missing: number[] = [];
  questions.forEach((_, i) => {
    if (!selectionValue(selections[i])) missing.push(i);
  });
  return { complete: missing.length === 0, missing };
}

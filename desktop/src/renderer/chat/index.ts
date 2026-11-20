// Chat UI core (zero DOM): types, parser, session state machine, prompts,
// diff and send queue. DOM code (view, markdown, tools, composer) imports
// these directly.
export * from './types';
export { parseChatMessage, flattenResultContent, parseAssistantContent, type ChatEvent } from './parser';
export { ChatSession, endedView, type TurnEvent, type EndedAction, type EndedView } from './session';
export {
  classifyPermissionKind,
  parsePermissionQuestions,
  summarizePermissionInput,
  describeSuggestion,
  buildAnswer,
  questionComplete,
  DEFAULT_DENY_MESSAGE,
  DEFAULT_REVISE_MESSAGE,
  type SuggestionChoice,
  type AnswerChoice,
  type Answer,
  type QuestionSelection,
} from './permission';
export { computeLineDiff, diffFromToolInput, type DiffRow, type DiffRowKind } from './diff';
export { SendQueue, classifySlash, filterSlashCommands, TERMINAL_ONLY_COMMANDS, type QueueItem } from './queue';

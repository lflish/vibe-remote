// Lightweight i18n for the renderer. No framework: a flat key→string table per
// locale, a t() lookup, a persisted current locale, and a change subscription so
// the whole UI re-renders on switch. Keys are dotted for grouping only.

export type Locale = 'zh' | 'en';

type Dict = Record<string, string>;

const STORAGE_KEY = 'vibe-remote.locale';

const zh: Dict = {
  'lang.toggle': 'EN',
  'lang.toggleTitle': '切换到英文',
  'sidebar.expand': '展开会话',
  'sidebar.collapse': '折叠会话',
  // workspace
  'workspace.eyebrow': '机器工作台',
  'workspace.manage': '管理',
  'workspace.summary.sessions': '{count} 个会话',
  'workspace.summary.local': '本地机器',
  'workspace.summary.remote': '远程机器',
  'workspace.connectionIssue.title': '无法连接这台机器',
  'workspace.connectionIssue.auth': 'Token 无效或没有访问权限，请在机器管理中检查认证信息。',
  'workspace.connectionIssue.version': 'Daemon 接口与桌面端不兼容，请更新远程端后重试。',
  'workspace.connectionIssue.unreachable': '请检查 Daemon 是否运行、网络是否可达，以及远程端是否支持当前桌面版本。',
  'workspace.connectionIssue.retry': '重新连接',
  'workspace.connectionIssue.required': '连接机器后才能新建会话',
  'workspace.recent.title': '最近会话',
  'workspace.recent.subtitle': '继续之前的工作。会话会在机器上持续运行。',
  'workspace.recent.empty': '这台机器还没有会话。',
  'workspace.connected': '已连接',
  'workspace.offline': '离线',
  'workspace.badge.running': '运行中',
  'workspace.badge.remote': '远程',
  'workspace.badge.worktree': 'Worktree',
  'workspace.badge.normal': '普通',
  'workspace.start.title': '新建会话',
  'workspace.start.subtitle': '选择这个会话如何使用工作目录。',
  'mode.normal.title': '打开现有目录',
  'mode.normal.desc': '在这台机器的某个目录中运行 Claude，不改动 Git。',
  'mode.normal.hint': '适合快速修改和已有的检出目录。',
  'mode.normal.action': '选择目录',
  'mode.worktree.title': '创建隔离 Worktree',
  'mode.worktree.desc': '先创建独立分支和 worktree，再启动会话。',
  'mode.worktree.hint': '适合需要与主分支隔离的并行任务。',
  'mode.worktree.action': '选择仓库',
  'mode.worktree.tag': '隔离',
  // reconnect banner
  'banner.reconnecting': '连接已断开，正在重连…',
  'banner.retry': '立即重试',
  // session delete
  'session.deleteTitle': '删除会话（会终止远程 Claude，不可撤销）',
  'session.deleteConfirm': '删除会话“{name}”？远程 Claude 进程会被终止、当前画面会丢失，且无法撤销。',
  'session.reloadTitle': '重新加载会话',
  'session.reloadConfirm': '重新加载会话“{name}”？当前 Claude 进程会被停止，并从原工作目录继续最近的对话。正在生成的回复和未发送的终端输入会中断。',
  'session.reloadSuccess': '会话已重新加载：{name}',
  'session.reloadFailed': '重新加载失败：{msg}',
  'session.worktreePreserved': 'Worktree 已保留 · {path} · 分支 {branch}',
  'session.waitingFallback': 'Claude 需要你的确认',
  // toolbar / status
  'status.connected': '已连接',
  'status.connecting': '正在连接…',
  'status.disconnected': '未连接',
  'status.reconnecting': '正在重连…',
  'status.reconnectingAttempt': '正在重连…（第 {n} 次）',
  'status.ready': '就绪',
  'status.noConnection': '无连接',
  'status.sessionExited': '会话已退出（代码 {code}）',
  'status.error': '错误：{msg}',
  // empty state
  'empty.title': '添加你的第一台机器',
  'empty.desc': '这台机器需在同一 tailnet 内并运行 vibe-remoted。',
  'empty.addMachine': '添加机器',
  'empty.hint': '地址：tailscale IP（100.x）或 MagicDNS 名称 · Token：与 vibe-remoted 配置一致',
  // dir picker
  'picker.chooseFolder': '在 {name} 上选择目录',
  'picker.sessionMode': '会话模式',
  'picker.modeNote': 'Worktree 模式会从所选仓库创建一个隔离分支。',
  'picker.launchOptions': '启动选项',
  'picker.cancel': '取消',
  'picker.openHere': '在此打开',
  'picker.loading': '正在读取目录…',
  'picker.listFailed': '目录读取失败：{msg}',
  'picker.up': '.. (上一级)',
  'picker.noSubdirs': '(没有子目录)',
  'picker.mode.normal.title': '打开现有目录',
  'picker.mode.normal.desc': '在所选目录中运行 Claude，不改动 Git。',
  'picker.mode.worktree.title': '创建隔离 Worktree',
  'picker.mode.worktree.desc': '先创建独立分支和 worktree，再启动会话。',
  // machine manager
  'machines.title': '机器',
  'machines.add': '+ 添加机器',
  'machines.done': '完成',
  'machines.saveFailed': '保存失败：{msg}',
  'machines.empty': '还没有机器，添加第一台吧。',
  'machines.edit': '编辑',
  'machines.delete': '删除',
  'machines.deleteConfirm': '删除机器“{name}”？其打开的会话会在本地关闭（远程 Claude 仍继续运行）。',
  'machines.field.name': '名称',
  'machines.field.addr': '地址（tailscale IP 或 MagicDNS）',
  'machines.field.port': '端口',
  'machines.field.token': 'Token',
  'machines.test': '测试连接',
  'machines.save': '保存',
  'machines.cancel': '取消',
  'machines.err.name': '名称不能为空',
  'machines.err.addr': '地址不能为空',
  'machines.err.port': '端口需在 1–65535 之间',
  'machines.err.token': 'Token 不能为空',
  'machines.testing': '正在测试…',
  'machines.testOk': '连接成功',
  'machines.testFail': '连接失败：{msg}',
  'machines.testReason.unreachable': '无法访问 Daemon，请检查服务和网络',
  'machines.testReason.auth': 'Token 无效或没有访问权限',
  'machines.testReason.version': 'Daemon 版本与桌面端不兼容',
};

const en: Dict = {
  'lang.toggle': '中',
  'lang.toggleTitle': 'Switch to Chinese',
  'sidebar.expand': 'Expand sessions',
  'sidebar.collapse': 'Collapse sessions',
  'workspace.eyebrow': 'Machine workspace',
  'workspace.manage': 'Manage',
  'workspace.summary.sessions': '{count} sessions',
  'workspace.summary.local': 'Local machine',
  'workspace.summary.remote': 'Remote machine',
  'workspace.connectionIssue.title': 'Can’t connect to this machine',
  'workspace.connectionIssue.auth': 'The token is invalid or lacks permission. Check the machine credentials.',
  'workspace.connectionIssue.version': 'The daemon API is incompatible with this desktop version. Update the daemon and retry.',
  'workspace.connectionIssue.unreachable': 'Check that the daemon is running, the network is reachable, and the remote version is compatible.',
  'workspace.connectionIssue.retry': 'Reconnect',
  'workspace.connectionIssue.required': 'Connect this machine before starting a session',
  'workspace.recent.title': 'Recent sessions',
  'workspace.recent.subtitle': 'Pick up where you left off. Sessions keep running on the machine.',
  'workspace.recent.empty': 'No sessions on this machine yet.',
  'workspace.connected': 'Connected',
  'workspace.offline': 'Offline',
  'workspace.badge.running': 'Running',
  'workspace.badge.remote': 'Remote',
  'workspace.badge.worktree': 'Worktree',
  'workspace.badge.normal': 'Normal',
  'workspace.start.title': 'Start a session',
  'workspace.start.subtitle': 'Choose how this session touches the working tree.',
  'mode.normal.title': 'Open existing directory',
  'mode.normal.desc': 'Run in a folder on this machine without changing its Git setup.',
  'mode.normal.hint': 'Best for quick edits and existing checkouts.',
  'mode.normal.action': 'Choose directory',
  'mode.worktree.title': 'Create isolated worktree',
  'mode.worktree.desc': 'Create an isolated branch and worktree before launching the session.',
  'mode.worktree.hint': 'Best for parallel work that must stay off your main branch.',
  'mode.worktree.action': 'Choose repository',
  'mode.worktree.tag': 'Isolated',
  'banner.reconnecting': 'Connection lost, reconnecting…',
  'banner.retry': 'Retry now',
  'session.deleteTitle': 'Delete session (kills remote claude — cannot be undone)',
  'session.deleteConfirm': 'Delete session "{name}"? The remote claude process will be killed and its current screen lost. This cannot be undone.',
  'session.reloadTitle': 'Reload session',
  'session.reloadConfirm': 'Reload session "{name}"? The current Claude process will stop and resume the latest conversation from the same working directory. An in-progress response and unsent terminal input will be interrupted.',
  'session.reloadSuccess': 'Session reloaded: {name}',
  'session.reloadFailed': 'Reload failed: {msg}',
  'session.worktreePreserved': 'Worktree preserved · {path} · branch {branch}',
  'session.waitingFallback': 'Claude needs your confirmation',
  'status.connected': 'Connected',
  'status.connecting': 'Connecting…',
  'status.disconnected': 'Disconnected',
  'status.reconnecting': 'Reconnecting…',
  'status.reconnectingAttempt': 'Reconnecting… (attempt {n})',
  'status.ready': 'Ready',
  'status.noConnection': 'No connection',
  'status.sessionExited': 'Session exited (code {code})',
  'status.error': 'Error: {msg}',
  'empty.title': 'Add your first machine',
  'empty.desc': 'The machine must be on the same tailnet and running vibe-remoted.',
  'empty.addMachine': 'Add machine',
  'empty.hint': 'Address: tailscale IP (100.x) or MagicDNS name · Token: matches vibe-remoted config',
  'picker.chooseFolder': 'Choose folder on {name}',
  'picker.sessionMode': 'Session mode',
  'picker.modeNote': 'Worktree mode creates an isolated branch from the selected repository.',
  'picker.launchOptions': 'Launch options',
  'picker.cancel': 'Cancel',
  'picker.openHere': 'Open here',
  'picker.loading': 'Loading folders…',
  'picker.listFailed': 'Failed to list directory: {msg}',
  'picker.up': '.. (up)',
  'picker.noSubdirs': '(no subdirectories)',
  'picker.mode.normal.title': 'Open existing directory',
  'picker.mode.normal.desc': 'Run Claude in the selected folder without touching Git.',
  'picker.mode.worktree.title': 'Create isolated worktree',
  'picker.mode.worktree.desc': 'Create an isolated branch and worktree before launching the session.',
  'machines.title': 'Machines',
  'machines.add': '+ Add machine',
  'machines.done': 'Done',
  'machines.saveFailed': 'Save failed: {msg}',
  'machines.empty': 'No machines yet. Add your first one.',
  'machines.edit': 'Edit',
  'machines.delete': 'Delete',
  'machines.deleteConfirm': 'Delete machine "{name}"? Its open sessions will be closed locally (the remote claude keeps running).',
  'machines.field.name': 'Name',
  'machines.field.addr': 'Address (tailscale IP or MagicDNS)',
  'machines.field.port': 'Port',
  'machines.field.token': 'Token',
  'machines.test': 'Test connection',
  'machines.save': 'Save',
  'machines.cancel': 'Cancel',
  'machines.err.name': 'Name is required',
  'machines.err.addr': 'Address is required',
  'machines.err.port': 'Port must be 1–65535',
  'machines.err.token': 'Token is required',
  'machines.testing': 'Testing…',
  'machines.testOk': 'Connection OK',
  'machines.testFail': 'Connection failed: {msg}',
  'machines.testReason.unreachable': 'The daemon is unreachable. Check the service and network.',
  'machines.testReason.auth': 'The token is invalid or lacks permission.',
  'machines.testReason.version': 'The daemon version is incompatible with this desktop app.',
};

const dicts: Record<Locale, Dict> = { zh, en };

function detectInitial(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return 'zh'; // default Chinese per product decision
}

let current: Locale = detectInitial();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  for (const fn of listeners) fn();
}

export function toggleLocale(): void {
  setLocale(current === 'zh' ? 'en' : 'zh');
}

// onLocaleChange registers a callback fired after every locale switch so the
// caller can re-render. Returns an unsubscribe function.
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// t looks up a key in the current locale and interpolates {placeholder} params.
// Falls back to the key itself if missing, so a forgotten string is visible.
export function t(key: string, params?: Record<string, string | number>): string {
  const template = dicts[current][key] ?? dicts.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

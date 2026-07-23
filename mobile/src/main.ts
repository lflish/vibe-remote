import './styles.css';
import { VibeRemoteClient } from '@net/client';
import { VibeRemoteRest } from '@net/rest';
import { ChatController, type ChatMessage } from './chat';
import { makeLineSplitter } from './lines';
import { makeMachineStore, defaultKV } from './storage';
import { renderMarkdown } from './render';
import { openMachineManager } from './machines';
import type { MachineConfig, SessionInfo } from '@shared/protocol';

const app = document.getElementById('app')!;
const store = makeMachineStore(defaultKV());

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

// Render one chat message. assistant → markdown (sanitized); user/tool → escaped.
function renderMessage(msg: ChatMessage): string {
  if (msg.role === 'assistant') {
    return `<div class="bubble assistant"><div class="md">${renderMarkdown(msg.text)}</div></div>`;
  }
  if (msg.role === 'tool') {
    return `<div class="bubble tool">🔧 ${escapeHtml(msg.text)}</div>`;
  }
  return `<div class="bubble user">${escapeHtml(msg.text)}</div>`;
}

async function renderMachineList() {
  const machines = await store.getMachines();
  app.innerHTML = `
    <div class="header">
      <span class="header-title">vibe-remote</span>
      <button class="header-btn" id="settings-btn">⚙</button>
    </div>
    <div class="list" id="list"></div>`;
  const list = document.getElementById('list')!;

  document.getElementById('settings-btn')!.onclick = () => {
    openMachineManager({
      app,
      getMachines: () => store.getMachines(),
      saveMachines: (m) => store.saveMachines(m),
      onDone: () => renderMachineList(),
    });
  };

  if (machines.length === 0) {
    list.innerHTML = `
      <div class="empty-guide">
        <div class="empty-icon">📡</div>
        <div class="empty-title">尚未添加机器</div>
        <div class="empty-sub">连接你的远程 vibe-remoted 服务器，<br/>开始移动端 Claude 体验</div>
        <button class="btn-primary btn-full" id="empty-add">+ 添加第一台机器</button>
      </div>`;
    document.getElementById('empty-add')!.onclick = () => {
      openMachineManager({
        app,
        getMachines: () => store.getMachines(),
        saveMachines: (m) => store.saveMachines(m),
        onDone: () => renderMachineList(),
      });
    };
    return;
  }
  for (const m of machines) {
    const rest = new VibeRemoteRest(m);
    let sessions: SessionInfo[] = [];
    try {
      sessions = await rest.listSessions();
    } catch {
      // machine unreachable — show it but empty
    }
    const header = document.createElement('div');
    header.className = 'list-item machine-header';
    header.innerHTML = `<div class="title">${escapeHtml(m.name)}</div><div class="sub">${escapeHtml(m.addr)}:${m.port} · ${sessions.length} 个会话</div>`;
    list.appendChild(header);
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'list-item session-item';
      item.innerHTML = `<div class="session-info"><div class="title">${escapeHtml(s.title)}</div><div class="sub">${escapeHtml(s.workdir)}</div></div><div class="chevron">›</div>`;
      item.onclick = () => openChat(m, s);
      list.appendChild(item);
    }
  }
}

function openChat(machine: MachineConfig, session: SessionInfo) {
  const controller = new ChatController();
  app.innerHTML = `
    <div class="header"><button class="back" id="back">‹ 返回</button><span>${escapeHtml(session.title)}</span></div>
    <div class="chat" id="chat"></div>
    <div class="cost" id="cost"></div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="发消息…"></textarea>
      <button id="send">发送</button>
    </div>`;
  const chat = document.getElementById('chat')!;
  const cost = document.getElementById('cost')!;
  const input = document.getElementById('input') as HTMLTextAreaElement;

  controller.onUpdate = () => {
    const loadingText = controller.activity ? `${controller.activity}…` : '思考中…';
    chat.innerHTML =
      controller.messages.map(renderMessage).join('') +
      (controller.loading ? `<div class="loading">${escapeHtml(loadingText)}</div>` : '');
    const parts: string[] = [];
    if (controller.lastCostUsd != null) parts.push(`$${controller.lastCostUsd.toFixed(4)}`);
    if (controller.lastInputTokens != null && controller.lastOutputTokens != null) {
      parts.push(`${controller.lastInputTokens}→${controller.lastOutputTokens} tok`);
    }
    cost.textContent = parts.join(' · ');
    chat.scrollTop = chat.scrollHeight;
  };

  // Load prior history so opening a session shows what happened before.
  const rest = new VibeRemoteRest(machine);
  rest.history(session.workdir, 50)
    .then((turns) => {
      if (controller.messages.length === 0) {
        controller.setHistory(turns.map((t) => ({ role: t.role, text: t.text }) as ChatMessage));
      }
    })
    .catch(() => { /* history is best-effort; empty chat is fine */ });

  const client = new VibeRemoteClient(machine);
  const feed = makeLineSplitter((line) => controller.applyLine(line));
  client.onData = (payload) => feed(base64ToText(payload));
  client.onError = () => controller.applyLine(JSON.stringify({ type: 'result' }));
  client.connect();
  client.attach('', 80, 24, session.workdir, undefined, 'headless');

  // Auto-grow textarea (32→120px) as the user types.
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };
  input.addEventListener('input', autoGrow);

  const send = () => {
    const text = input.value.trim();
    if (!text || controller.loading) return; // don't send while a turn streams
    controller.startUserTurn(text);
    client.sendData(bytesToBase64(new TextEncoder().encode(text)));
    input.value = '';
    autoGrow();
  };
  document.getElementById('send')!.onclick = send;

  document.getElementById('back')!.onclick = () => {
    client.disconnect();
    detachKeyboardAvoidance();
    renderMachineList();
  };

  attachKeyboardAvoidance();
}

// Keyboard avoidance: when the soft keyboard shows, visualViewport shrinks;
// push the composer up by the covered height via the --keyboard-height token.
let vvHandler: (() => void) | null = null;
function attachKeyboardAvoidance() {
  const vv = window.visualViewport;
  if (!vv) return;
  vvHandler = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard-height', covered + 'px');
  };
  vv.addEventListener('resize', vvHandler);
  vv.addEventListener('scroll', vvHandler);
  vvHandler();
}
function detachKeyboardAvoidance() {
  const vv = window.visualViewport;
  if (vv && vvHandler) {
    vv.removeEventListener('resize', vvHandler);
    vv.removeEventListener('scroll', vvHandler);
  }
  vvHandler = null;
  document.documentElement.style.setProperty('--keyboard-height', '0px');
}

renderMachineList();

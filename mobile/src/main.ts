import './styles.css';
import { VibeRemoteClient, ConnectionState } from '@net/client';
import { VibeRemoteRest } from '@net/rest';
import { ChatController } from './chat';
import { makeLineSplitter } from './lines';
import { makeMachineStore, defaultKV } from './storage';
import type { MachineConfig, SessionInfo } from '@shared/protocol';

const app = document.getElementById('app')!;
const store = makeMachineStore(defaultKV());

// base64 <-> bytes (UTF-8 safe) — mobile only needs the encode direction for
// sending prompts and decode for receiving NDJSON lines.
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

// NDJSON can arrive split across frames; buffer partial lines per client.
// (splitter logic lives in ./lines so it can be unit-tested independently)

async function renderMachineList() {
  const machines = await store.getMachines();
  app.innerHTML = `<div class="header">vibe-remote</div><div class="list" id="list"></div>`;
  const list = document.getElementById('list')!;
  if (machines.length === 0) {
    list.innerHTML = `<div class="list-item"><div class="sub">machines.json 为空。请在设备上预置机器清单（name/addr/port/token）。</div></div>`;
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
    header.className = 'list-item';
    header.innerHTML = `<div class="title">${escapeHtml(m.name)}</div><div class="sub">${escapeHtml(m.addr)}:${m.port} · ${sessions.length} sessions</div>`;
    list.appendChild(header);
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `<div class="title">${escapeHtml(s.title)}</div><div class="sub">${escapeHtml(s.workdir)}</div>`;
      item.onclick = () => openChat(m, s);
      list.appendChild(item);
    }
  }
}

function openChat(machine: MachineConfig, session: SessionInfo) {
  const controller = new ChatController();
  app.innerHTML = `
    <div class="header"><button class="back" id="back">‹ 返回</button><span>${session.title}</span></div>
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
    chat.innerHTML = controller.messages
      .map((msg) => `<div class="bubble ${msg.role}">${escapeHtml(msg.text)}</div>`)
      .join('') + (controller.loading ? `<div class="loading">思考中…</div>` : '');
    cost.textContent = controller.lastCostUsd != null ? `本轮成本 $${controller.lastCostUsd.toFixed(4)}` : '';
    chat.scrollTop = chat.scrollHeight;
  };

  const client = new VibeRemoteClient(machine);
  const feed = makeLineSplitter((line) => controller.applyLine(line));
  client.onData = (payload) => feed(base64ToText(payload));
  client.onError = (m) => controller.applyLine(JSON.stringify({ type: 'result' })); // end loading on error
  client.connect();
  // Headless attach: key on workdir, empty sessionId, mode headless.
  client.attach('', 80, 24, session.workdir, undefined, 'headless');

  document.getElementById('send')!.onclick = () => {
    const text = input.value.trim();
    if (!text) return;
    controller.startUserTurn(text);
    client.sendData(bytesToBase64(new TextEncoder().encode(text)));
    input.value = '';
  };
  document.getElementById('back')!.onclick = () => {
    client.disconnect();
    renderMachineList();
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

renderMachineList();

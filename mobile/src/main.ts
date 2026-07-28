import './styles.css';
import { VibeRemoteClient } from '@net/client';
import { VibeRemoteRest } from '@net/rest';
import type { Message } from '@vibe-remote/core';
import { mountChat } from '@vibe-remote/ui';
import '@vibe-remote/ui/styles.css';
import { makeMachineStore, defaultKV } from './storage';
import { openMachineManager } from './machines';
import type { MachineConfig } from '@shared/protocol';

const app = document.getElementById('app')!;
const store = makeMachineStore(defaultKV());

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
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
    // Render the machine header synchronously so a just-added machine is
    // visible immediately — do NOT block on listSessions (an unreachable or
    // slow machine would otherwise leave the whole list blank). Sessions load
    // asynchronously and fill in below the header once they arrive.
    const header = document.createElement('div');
    header.className = 'list-item machine-header';
    header.innerHTML = `
      <div class="machine-head-row">
        <div class="machine-info"><div class="title">${escapeHtml(m.name)}</div><div class="sub">${escapeHtml(m.addr)}:${m.port} · <span class="mcount">连接中…</span></div></div>
        <button class="btn-sm new-session-btn" disabled>+ 新建</button>
      </div>`;
    list.appendChild(header);
    const countEl = header.querySelector('.mcount')!;
    const newBtn = header.querySelector('.new-session-btn') as HTMLButtonElement;

    const rest = new VibeRemoteRest(m);
    // Race a promise against a timeout: the browser fetch has no default
    // timeout, so an unreachable host would leave "连接中…" spinning forever.
    // 6s → mark offline. (rest.ts is shared with desktop; we cap here, not there.)
    const withTimeout = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    // Fetch info to learn the default workdir, then enable "新建会话".
    withTimeout(rest.info(), 6000)
      .then((info) => {
        const workdir = info.default_workdir;
        newBtn.disabled = false;
        newBtn.onclick = () => openChat(m, workdir, '新会话');
      })
      .catch(() => { /* offline handled below */ });

    withTimeout(rest.listSessions(), 6000)
      .then((sessions) => {
        countEl.textContent = `${sessions.length} 个会话`;
        for (const s of sessions) {
          const item = document.createElement('div');
          item.className = 'list-item session-item';
          item.innerHTML = `<div class="session-info"><div class="title">${escapeHtml(s.title)}</div><div class="sub">${escapeHtml(s.workdir)}</div></div><div class="chevron">›</div>`;
          item.onclick = () => openChat(m, s.workdir, s.title);
          header.insertAdjacentElement('afterend', item);
        }
      })
      .catch(() => {
        countEl.textContent = '离线';
        (countEl as HTMLElement).style.color = '#f38ba8';
      });
  }
}

// openChat opens the headless chat view for a workdir on a machine. Because
// headless keys purely on workdir (server runs `claude -c -p` there), opening
// an existing session and starting a new one are the same path: `-c` continues
// the dir's most recent conversation, or starts fresh if none exists.
// 阶段 2：改用共享 core ChatSession + ui ChatView（mountChat），与桌面同一套逻辑/视图。
function openChat(machine: MachineConfig, workdir: string, title: string) {
  app.innerHTML = `
    <div class="header"><button class="back" id="back">‹ 返回</button><span>${escapeHtml(title)}</span></div>
    <div class="chat-host" id="chat-host"></div>`;
  const host = document.getElementById('chat-host')!;

  const client = new VibeRemoteClient(machine);
  const mount = mountChat(host, {
    onSend: (payload) => client.sendData(payload),
    // onStop：interrupt 帧待 headless 双向化（阶段 4）落地后接入。
  });

  // 加载历史，把旧的 {role,text} 回合转成 core Message（纯文本 part）。
  const rest = new VibeRemoteRest(machine);
  rest.history(workdir, 50)
    .then((turns) => {
      const msgs: Message[] = turns.map((t) =>
        t.role === 'assistant'
          ? { role: 'assistant', parts: [{ type: 'text', text: t.text }], streaming: false }
          : { role: 'user', parts: [{ type: 'text', text: t.text }] },
      );
      if (msgs.length) mount.setHistory(msgs);
    })
    .catch(() => { /* history is best-effort; empty chat is fine */ });

  client.onData = (payload) => mount.feed(payload);
  client.onError = () => { /* error 帧：结束当前 turn 由 result 帧处理；此处忽略 */ };
  client.connect();
  client.attach('', 80, 24, workdir, undefined, 'headless');

  document.getElementById('back')!.onclick = () => {
    client.disconnect();
    mount.dispose();
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

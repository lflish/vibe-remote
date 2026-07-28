// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatPane } from './ChatPane';

// stub 掉 WS/REST 网络，只验证组件挂载不抛错、渲染出容器与标题。
vi.mock('@vibe-remote/core', async (orig) => {
  const actual = await orig<typeof import('@vibe-remote/core')>();
  return {
    ...actual,
    VibeRemoteClient: class { onData?: (p: string) => void; connect() {} attach() {} disconnect() {} sendData() {} },
    VibeRemoteRest: class { history() { return Promise.resolve([]); } },
  };
});

afterEach(cleanup);

describe('ChatPane', () => {
  it('挂载渲染标题（workdir）与聊天挂载点', () => {
    const M = { name: 'dev', addr: '1.1.1.1', port: 8765, token: 't' };
    const { container, getByText } = render(<ChatPane machine={M} workdir="/home/proj" onBack={() => {}} />);
    expect(getByText('/home/proj')).toBeTruthy();
    expect(container.querySelector('.chat-host')).toBeTruthy();
  });
});

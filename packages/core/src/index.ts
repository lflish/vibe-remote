// @vibe-remote/core — 框架无关的共享内核（桌面/web/iOS 三端复用）。
//
// 「零 DOM」纪律：core 可用 Web 平台网络 API（WebSocket / fetch / URL，三端运行时
// 都提供），但不得操作 DOM 树（禁止 document./window. 的元素读写）。tsconfig 保留
// DOM lib 仅为拿到这些平台 API 的类型，不是放行 DOM 操作——后者靠审查守。
//
// 阶段 0a：protocol / client / rest 已上提。chat 深度解析内核由 0a-3 填充。

export * from './protocol';
export * from './client';
export * from './rest';
export * from './base64';
export * from './machines';
export * from './chat/index';

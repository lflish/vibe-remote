// The terminal's share of the app theme (design 7.5, R8.2).
//
// Only four colors follow the theme: background, foreground, cursor and
// selection. They come from the --term-* variables in styles.css, read when a
// terminal is created. What the remote program prints is never interpreted;
// its 16 ANSI colors map to the fixed palette below, which is not themed.
import type { ITheme } from '@xterm/xterm';

const ANSI = {
  black: '#3B3A37', red: '#C0564B', green: '#5E8C58', yellow: '#B07D2E',
  blue: '#4A72B0', magenta: '#9A5BA0', cyan: '#3E8C8C', white: '#6B6862',
  brightBlack: '#9B978E', brightRed: '#C0564B', brightGreen: '#5E8C58',
  brightYellow: '#B07D2E', brightBlue: '#4A72B0', brightMagenta: '#9A5BA0',
  brightCyan: '#3E8C8C', brightWhite: '#2B2A28',
} as const;

export function terminalTheme(): ITheme {
  const style = window.getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: value('--term-bg'),
    foreground: value('--term-fg'),
    cursor: value('--term-cursor'),
    selectionBackground: value('--term-selection'),
    ...ANSI,
  };
}

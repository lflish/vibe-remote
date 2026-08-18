export interface ClipboardTerminal {
  element?: HTMLElement;
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

export interface ClipboardBridge {
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<boolean>;
}

export type ClipboardErrorHandler = (error: unknown) => void;
export type ClipboardDiagnostic = (operation: 'copy' | 'paste', details: {
  utf16Length: number;
  utf8Length: number;
}) => void;

const textLengths = (text: string) => ({
  utf16Length: text.length,
  utf8Length: new TextEncoder().encode(text).length,
});

/**
 * Add explicit macOS clipboard shortcuts while preserving xterm's native handlers.
 * The handler returns synchronously so xterm can decide whether to emit PTY input;
 * clipboard IPC and paste are completed asynchronously after the shortcut is consumed.
 */
export function attachMacClipboardShortcuts(
  terminal: ClipboardTerminal,
  bridge: ClipboardBridge,
  onError: ClipboardErrorHandler = () => {},
  onDiagnostic: ClipboardDiagnostic = () => {},
): void {
  const copySelection = (): boolean => {
    const selection = terminal.getSelection();
    if (!selection) return false;
    onDiagnostic('copy', textLengths(selection));
    void bridge.writeClipboardText(selection).catch(onError);
    return true;
  };

  // Electron may route the native Edit → Copy command as a DOM `copy` event
  // without delivering the original keydown to xterm's hidden textarea. Bind the
  // event on xterm's root as the authoritative fallback; stop propagation so
  // xterm's default clipboardData handler cannot race the async native write.
  terminal.element?.addEventListener('copy', (event) => {
    if (!copySelection()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.metaKey || event.altKey) return true;

    const key = event.key.toLowerCase();
    if (key === 'c') {
      return !copySelection();
    }

    if (key === 'v') {
      void bridge.readClipboardText()
        .then((text) => {
          onDiagnostic('paste', textLengths(text));
          terminal.paste(text);
        })
        .catch(onError);
      return false;
    }

    return true;
  });
}

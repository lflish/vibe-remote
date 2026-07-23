import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.viberemote.mobile',
  appName: 'vibe-remote',
  webDir: 'dist',
  server: {
    // Allow cleartext so ws:// to a tailscale/LAN IP works inside the WebView.
    cleartext: true,
  },
};

export default config;

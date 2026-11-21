import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.notesplus.kapsula',
  appName: 'Kapsula',
  webDir: 'dist/mobile',
  android: {
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
    backgroundColor: '#0e0e11',
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
  server: {
    androidScheme: 'https',
    hostname: 'app.kapsula.local',
  },
};

export default config;

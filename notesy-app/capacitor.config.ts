import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.notesy.meetings",
  appName: "Notesy",
  webDir: "dist-android",
  android: {
    allowMixedContent: false,
    backgroundColor: "#fbfaf8",
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;

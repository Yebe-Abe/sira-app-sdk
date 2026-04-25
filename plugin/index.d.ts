import type { ConfigPlugin } from "@expo/config-plugins";

export interface SiraSupportPluginProps {
  android?: {
    captureMode?: "in-app" | "full-screen";
  };
}

declare const plugin: ConfigPlugin<SiraSupportPluginProps>;
export default plugin;

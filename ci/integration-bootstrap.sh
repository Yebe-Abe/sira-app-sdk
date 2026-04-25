#!/usr/bin/env bash
# §2 — Bootstrap a fresh Expo app, install the just-published SDK,
# mechanically apply the README's AI-pair integration prompt, then prepare
# for build.

set -euo pipefail
VERSION="${1:?version required}"

DIR=/tmp/integ-app
rm -rf "$DIR"
npx --yes create-expo-app@latest "$DIR" --template blank-typescript --no-install
cd "$DIR"
npm install
npm install "@sira-screen-share/support-react-native@${VERSION}" react-native-webrtc

# Wire the config plugin
node -e '
const fs = require("fs");
const p = "./app.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.expo.plugins = c.expo.plugins || [];
c.expo.plugins.push(["@sira-screen-share/support-react-native", { android: { captureMode: "full-screen" } }]);
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'

# Wrap the App component with <SiraSupport>
cat > App.tsx <<'EOF'
import { SiraSupport, SiraSupportTrigger } from "@sira-screen-share/support-react-native";
import { Text, View } from "react-native";

export default function App() {
  return (
    <SiraSupport android={{ captureMode: "full-screen" }} appName="IntegTest">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>Integration smoke harness</Text>
        <SiraSupportTrigger testID="sira-help-button">
          <Text style={{ marginTop: 24, color: "#1a73e8" }}>Enter support code</Text>
        </SiraSupportTrigger>
      </View>
    </SiraSupport>
  );
}
EOF

echo "integration scaffold ready at $DIR"

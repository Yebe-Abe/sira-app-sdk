// Test-only harness app. Wraps the SDK and renders a small set of screens
// reachable via deeplink: harness://goto/<screen>.

import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  SiraSupport,
  SiraSupportTrigger,
  getSignalingDiag,
  setSiraDiagEnabled,
} from "@sira-screen-share/support-react-native";

// Debug-only signaling diag accumulator. `__DEV__` is React Native's
// build-time flag — true under Metro / debug APKs, constant-folded to
// false in release bundles. The bundler tree-shakes the entire branch in
// release, so production integrators who ship release builds never carry
// any of this. The harness is a debug-only test tool, so this is fine.
if (__DEV__) {
  setSiraDiagEnabled(true);
}

const SCREENS = {
  paystub: () => (
    <Sensitive title="Paystub">
      <Field label="SSN"><Text style={styles.value}>999-99-9999</Text></Field>
      <Field label="Salary"><Text style={styles.value}>$99,999.99</Text></Field>
    </Sensitive>
  ),
  "paystub-history": () => (
    <Sensitive title="Paystub history">
      <Field label="2026-04 net"><Text style={styles.value}>$99,999.99</Text></Field>
      <Field label="2026-03 net"><Text style={styles.value}>$99,999.99</Text></Field>
    </Sensitive>
  ),
  "employee-profile": () => (
    <Sensitive title="Profile">
      <Field label="DOB"><Text style={styles.value}>01/01/1900</Text></Field>
      <Field label="SSN"><Text style={styles.value}>999-99-9999</Text></Field>
    </Sensitive>
  ),
  "bank-info": () => (
    <Sensitive title="Bank info">
      <Field label="Account"><Text style={styles.value}>INVALID-ACCT-MARKER-001</Text></Field>
    </Sensitive>
  ),
  "payroll-summary": () => (
    <Sensitive title="Payroll summary">
      <Field label="YTD"><Text style={styles.value}>$99,999.99</Text></Field>
    </Sensitive>
  ),
  "employee-documents": () => (
    <Sensitive title="Documents">
      <Field label="Tax doc SSN"><Text style={styles.value}>999-99-9999</Text></Field>
    </Sensitive>
  ),
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Sensitive({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.h1}>{title}</Text>
      {children}
    </ScrollView>
  );
}

function Home({ onGoto }: { onGoto: (s: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.h1}>Sira test harness</Text>
      <SiraSupportTrigger testID="sira-help-button" accessibilityLabel="sira-help-button">
        <Text style={styles.cta}>Enter support code</Text>
      </SiraSupportTrigger>
      <Text style={[styles.h1, { marginTop: 32, fontSize: 16 }]}>Sensitive screens</Text>
      {Object.keys(SCREENS).map((s) => (
        <Pressable key={s} onPress={() => onGoto(s)} style={styles.row}>
          <Text style={{ color: "#1a73e8" }}>{s}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export default function App() {
  const [route, setRoute] = useState<string>("home");
  // Debug-only diag tail. Polled every 500ms; rendered as a fixed-position
  // bottom strip on the harness only when __DEV__. Release bundles strip
  // both the state, the polling effect, and the rendered <Text>.
  const [diag, setDiag] = useState<string>("");
  useEffect(() => {
    if (!__DEV__) return;
    const t = setInterval(() => setDiag(getSignalingDiag() || ""), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const sub = Linking.addEventListener("url", ({ url }) => {
      const parsed = Linking.parse(url);
      // harness://goto/<screen>
      const segments = (parsed.path || "").split("/");
      if (segments[0] === "goto" && segments[1]) setRoute(segments[1]);
    });
    Linking.getInitialURL().then((u) => {
      if (!u) return;
      const parsed = Linking.parse(u);
      const segments = (parsed.path || "").split("/");
      if (segments[0] === "goto" && segments[1]) setRoute(segments[1]);
    });
    return () => sub.remove();
  }, []);

  const Screen = route === "home" ? () => <Home onGoto={setRoute} /> : SCREENS[route as keyof typeof SCREENS];

  return (
    <SiraSupport
      publicKey="pk_test"
      serverUrl={process.env.EXPO_PUBLIC_SIRA_SERVER_URL || undefined}
      appName="Sira Harness"
    >
      <View style={styles.fill}>
        {Screen ? <Screen /> : <Text>unknown route: {route}</Text>}
        {/* Always-visible Home button when not on home — lets navigation
            between sensitive screens without backgrounding the app
            (Android's back button would otherwise exit). */}
        {route !== "home" ? (
          <Pressable
            testID="sira-home"
            accessibilityLabel="sira-home"
            onPress={() => setRoute("home")}
            style={{
              position: "absolute",
              bottom: 60,
              left: 16,
              paddingVertical: 14,
              paddingHorizontal: 24,
              backgroundColor: "#1a73e8",
              borderRadius: 8,
              zIndex: 999,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>Home</Text>
          </Pressable>
        ) : null}
        {/* Debug-only: shows the live signaling timeline. Stripped from
            release bundles by the __DEV__ guard. */}
        {__DEV__ && diag ? (
          <Text
            style={{ position: "absolute", bottom: 4, left: 8, right: 8, color: "#06c", fontSize: 9 }}
            testID="sira-debug-diag"
            numberOfLines={6}
          >
            {diag}
          </Text>
        ) : null}
      </View>
    </SiraSupport>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#fff" },
  screen: { padding: 24, paddingTop: 64 },
  h1: { fontSize: 24, fontWeight: "800", marginBottom: 16 },
  cta: { fontSize: 18, color: "#1a73e8", fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  label: { color: "#666" },
  value: { fontWeight: "700" },
});

// Test-only harness app. Wraps the SDK and renders a small set of
// "sensitive" screens that contain marker strings (SSN 999-99-9999 etc.)
// so the §3 redaction CI can verify nothing leaks.
//
// Screens are reachable via deeplink: harness://goto/<screen> — used by
// ci/appium/redaction.js to navigate without a real router.

import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  SiraRedact,
  SiraSupport,
  SiraSupportTrigger,
  getSignalingDiag,
} from "@sira-screen-share/support-react-native";

const SCREENS = {
  paystub: () => (
    <Sensitive title="Paystub">
      <Field label="SSN"><SiraRedact><Text style={styles.value}>999-99-9999</Text></SiraRedact></Field>
      <Field label="Salary"><SiraRedact><Text style={styles.value}>$99,999.99</Text></SiraRedact></Field>
    </Sensitive>
  ),
  "paystub-history": () => (
    <Sensitive title="Paystub history">
      <Field label="2026-04 net"><SiraRedact><Text style={styles.value}>$99,999.99</Text></SiraRedact></Field>
      <Field label="2026-03 net"><SiraRedact><Text style={styles.value}>$99,999.99</Text></SiraRedact></Field>
    </Sensitive>
  ),
  "employee-profile": () => (
    <Sensitive title="Profile">
      <Field label="DOB"><SiraRedact><Text style={styles.value}>01/01/1900</Text></SiraRedact></Field>
      <Field label="SSN"><SiraRedact><Text style={styles.value}>999-99-9999</Text></SiraRedact></Field>
    </Sensitive>
  ),
  "bank-info": () => (
    <Sensitive title="Bank info">
      <Field label="Account"><SiraRedact><Text style={styles.value}>INVALID-ACCT-MARKER-001</Text></SiraRedact></Field>
    </Sensitive>
  ),
  "payroll-summary": () => (
    <Sensitive title="Payroll summary">
      <Field label="YTD"><SiraRedact><Text style={styles.value}>$99,999.99</Text></SiraRedact></Field>
    </Sensitive>
  ),
  "employee-documents": () => (
    <Sensitive title="Documents">
      <Field label="Tax doc SSN"><SiraRedact><Text style={styles.value}>999-99-9999</Text></SiraRedact></Field>
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

  const [lastEnd, setLastEnd] = useState<string | null>(null);
  const [diag, setDiag] = useState<string>("");
  // Poll signaling diag every 500ms so it ends up in CI page-source dumps.
  useEffect(() => {
    const t = setInterval(() => setDiag(getSignalingDiag() || ""), 500);
    return () => clearInterval(t);
  }, []);

  return (
    <SiraSupport
      publicKey="pk_test"
      android={{ captureMode: process.env.CAPTURE_MODE === "in-app" ? "in-app" : "full-screen" }}
      appName="Sira Harness"
      onSessionEnd={(reason, sid, details) => setLastEnd(`end=${reason} ${details ? `msg=${details} ` : ""}sid=${sid ?? "?"}`)}
    >
      <View style={styles.fill}>
        {Screen ? <Screen /> : <Text>unknown route: {route}</Text>}
        {/* Always-visible Home button when not on home — lets the redaction
            test navigate between sensitive screens without backgrounding
            the app (Android's back button would exit). */}
        {route !== "home" ? (
          <Pressable
            testID="sira-home"
            accessibilityLabel="Home"
            onPress={() => setRoute("home")}
            style={{ position: "absolute", top: 60, right: 16, padding: 12, backgroundColor: "#1a73e8", borderRadius: 6 }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>Home</Text>
          </Pressable>
        ) : null}
        {lastEnd ? (
          <Text
            style={{ position: "absolute", bottom: 8, left: 8, color: "#c00", fontSize: 10 }}
            testID="sira-debug-end"
            accessibilityLabel="sira-debug-end"
          >
            {lastEnd}
          </Text>
        ) : null}
        {diag ? (
          <Text
            style={{ position: "absolute", bottom: 28, left: 8, right: 8, color: "#06c", fontSize: 9 }}
            testID="sira-debug-diag"
            accessibilityLabel="sira-debug-diag"
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

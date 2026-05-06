// Pre-dialog priming shown only on Android in full-screen capture mode.
// Explains the next system dialog in plain language so customers pick
// "Entire screen" — Android 14's MediaProjection picker also offers
// "A single app" as the default, but our product flow requires the
// agent to see whatever the customer is doing across their device.

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

export interface PrimingScreenProps {
  visible: boolean;
  // Reserved for future copy that may reference the host app by name.
  // Currently unused — Entire-screen flow doesn't need to pick a target.
  appName: string;
  onContinue(): void;
  onCancel(): void;
}

export const PrimingScreen: React.FC<PrimingScreenProps> = ({
  visible,
  onContinue,
  onCancel,
}) => (
  <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onCancel}>
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>One quick step</Text>
      <Text style={styles.body}>
        Android will ask what to share. Pick the options shown below so the
        agent can see your whole screen as you move around.
      </Text>

      <View style={styles.step}>
        <Text style={styles.stepNum}>1</Text>
        <Text style={styles.stepText}>
          Choose <Text style={styles.bold}>Entire screen</Text>
        </Text>
      </View>
      <View style={styles.step}>
        <Text style={styles.stepNum}>2</Text>
        <Text style={styles.stepText}>
          Tap <Text style={styles.bold}>Start now</Text>
        </Text>
      </View>

      <Text style={styles.note}>
        The agent can see your screen but cannot tap or type for you. The
        session continues across other apps until you tap End.
      </Text>

      <Pressable style={styles.cta} onPress={onContinue}>
        <Text style={styles.ctaText}>Continue</Text>
      </Pressable>
      <Pressable style={styles.cancel} onPress={onCancel}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </ScrollView>
  </Modal>
);

// Color values are Sira's brand tokens, lifted from sira-mobile's
// tailwind.config.js + global.css (light mode). The orange (#f97316) is
// `--primary`; stone-* greyscale matches `--foreground` / `--muted-
// foreground`. See README "Branding" for the (deliberate) lack of a
// runtime theme prop.
const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  title: { fontSize: 28, fontWeight: "800", marginBottom: 12, color: "#0c0a09" },
  body: { fontSize: 16, color: "#78716c", marginBottom: 24 },
  step: { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 16 },
  stepNum: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#f97316",
    color: "#fafaf9",
    textAlign: "center",
    lineHeight: 36,
    fontWeight: "800",
    fontSize: 18,
  },
  stepText: { fontSize: 18, flex: 1, color: "#0c0a09" },
  bold: { fontWeight: "800" },
  note: { fontSize: 14, color: "#78716c", marginTop: 16, marginBottom: 32, fontStyle: "italic" },
  cta: { backgroundColor: "#f97316", padding: 16, borderRadius: 12, alignItems: "center" },
  ctaText: { color: "#fafaf9", fontWeight: "800", fontSize: 18 },
  cancel: { padding: 16, alignItems: "center", marginTop: 8 },
  cancelText: { color: "#78716c", fontWeight: "600" },
});

// Pre-dialog priming shown only on Android in full-screen capture mode.
// Explains the next system dialog in plain language so customers pick
// "A single app" → host app, not "Entire screen".

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

export interface PrimingScreenProps {
  visible: boolean;
  appName: string;
  onContinue(): void;
  onCancel(): void;
}

export const PrimingScreen: React.FC<PrimingScreenProps> = ({
  visible,
  appName,
  onContinue,
  onCancel,
}) => (
  <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onCancel}>
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>One quick step</Text>
      <Text style={styles.body}>
        Android will ask what to share. Pick the options shown below so the
        agent only sees this app.
      </Text>

      <View style={styles.step}>
        <Text style={styles.stepNum}>1</Text>
        <Text style={styles.stepText}>
          Choose <Text style={styles.bold}>A single app</Text>
        </Text>
      </View>
      <View style={styles.step}>
        <Text style={styles.stepNum}>2</Text>
        <Text style={styles.stepText}>
          Pick <Text style={styles.bold}>{appName}</Text>
        </Text>
      </View>
      <View style={styles.step}>
        <Text style={styles.stepNum}>3</Text>
        <Text style={styles.stepText}>
          Tap <Text style={styles.bold}>Start</Text>
        </Text>
      </View>

      <Text style={styles.note}>
        The agent can see only what's in this app. They cannot tap or type for you.
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

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  title: { fontSize: 28, fontWeight: "800", marginBottom: 12 },
  body: { fontSize: 16, color: "#333", marginBottom: 24 },
  step: { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 16 },
  stepNum: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1a73e8",
    color: "#fff",
    textAlign: "center",
    lineHeight: 36,
    fontWeight: "800",
    fontSize: 18,
  },
  stepText: { fontSize: 18, flex: 1 },
  bold: { fontWeight: "800" },
  note: { fontSize: 14, color: "#666", marginTop: 16, marginBottom: 32, fontStyle: "italic" },
  cta: { backgroundColor: "#1a73e8", padding: 16, borderRadius: 12, alignItems: "center" },
  ctaText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  cancel: { padding: 16, alignItems: "center", marginTop: 8 },
  cancelText: { color: "#666", fontWeight: "600" },
});

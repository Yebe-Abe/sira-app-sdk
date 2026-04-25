// Shown when MediaProjection returned an "Entire screen" capture rather than
// the single-app capture we asked for. The session is still valid; we only
// need a fresh projection token.

import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

export interface RecoveryScreenProps {
  visible: boolean;
  appName: string;
  onTryAgain(): void;
  onCancel(): void;
}

export const RecoveryScreen: React.FC<RecoveryScreenProps> = ({
  visible,
  appName,
  onTryAgain,
  onCancel,
}) => (
  <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onCancel}>
    <View style={styles.container}>
      <Text style={styles.title}>Almost there</Text>
      <Text style={styles.body}>
        Sira can only view the {appName} app. Let's try that again — pick{" "}
        <Text style={styles.bold}>A single app</Text> and choose{" "}
        <Text style={styles.bold}>{appName}</Text>.
      </Text>
      <Pressable style={styles.cta} onPress={onTryAgain}>
        <Text style={styles.ctaText}>Try Again</Text>
      </Pressable>
      <Pressable style={styles.cancel} onPress={onCancel}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  </Modal>
);

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "800", marginBottom: 12 },
  body: { fontSize: 16, color: "#333", marginBottom: 24, lineHeight: 22 },
  bold: { fontWeight: "800" },
  cta: { backgroundColor: "#1a73e8", padding: 16, borderRadius: 12, alignItems: "center" },
  ctaText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  cancel: { padding: 16, alignItems: "center", marginTop: 8 },
  cancelText: { color: "#666", fontWeight: "600" },
});

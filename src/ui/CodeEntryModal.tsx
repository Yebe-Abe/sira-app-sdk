import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from "react-native";

export interface CodeEntryModalProps {
  visible: boolean;
  busy?: boolean;
  error?: string;
  onSubmit(code: string): void;
  onCancel(): void;
}

export const CodeEntryModal: React.FC<CodeEntryModalProps> = ({
  visible,
  busy,
  error,
  onSubmit,
  onCancel,
}) => {
  const [code, setCode] = useState("");
  const valid = /^\d{6}$/.test(code);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.title}>Enter support code</Text>
          <Text style={styles.body}>
            Read the 6-digit code your support agent gave you.
          </Text>
          <TextInput
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
            keyboardType="number-pad"
            placeholder="000000"
            autoFocus
            maxLength={6}
            style={styles.input}
            editable={!busy}
            testID="sira-code-input"
            accessibilityLabel="sira-code-input"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <Pressable style={styles.cancel} onPress={onCancel} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.connect, !valid && styles.disabled]}
              onPress={() => valid && onSubmit(code)}
              disabled={!valid || busy}
            >
              {busy ? (
                <ActivityIndicator color="#fafaf9" />
              ) : (
                <Text style={styles.connectText}>Connect</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// Color values are Sira's brand tokens, lifted from sira-mobile's
// tailwind.config.js + global.css (light mode). The orange (#f97316) and
// stone-* greyscale match the agent dashboard and the host-app surfaces a
// Sira-published integration ships with. There's no theme prop today —
// see README "Branding".
const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  card: { backgroundColor: "#ffffff", borderRadius: 12, padding: 24 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 8, color: "#0c0a09" },
  body: { fontSize: 14, color: "#78716c", marginBottom: 16 },
  input: {
    fontSize: 28,
    letterSpacing: 8,
    textAlign: "center",
    color: "#0c0a09",
    borderWidth: 1,
    borderColor: "#e7e5e4",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  error: { color: "#ef4444", marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  cancel: { paddingVertical: 12, paddingHorizontal: 16 },
  cancelText: { color: "#78716c", fontWeight: "600" },
  connect: {
    backgroundColor: "#f97316",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 100,
    alignItems: "center",
  },
  disabled: { opacity: 0.5 },
  connectText: { color: "#fafaf9", fontWeight: "700" },
});

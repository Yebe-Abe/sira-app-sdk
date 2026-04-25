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
                <ActivityIndicator color="#fff" />
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

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 24 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  body: { fontSize: 14, color: "#444", marginBottom: 16 },
  input: {
    fontSize: 28,
    letterSpacing: 8,
    textAlign: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  error: { color: "#c00", marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  cancel: { paddingVertical: 12, paddingHorizontal: 16 },
  cancelText: { color: "#444", fontWeight: "600" },
  connect: {
    backgroundColor: "#1a73e8",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 100,
    alignItems: "center",
  },
  disabled: { opacity: 0.5 },
  connectText: { color: "#fff", fontWeight: "700" },
});

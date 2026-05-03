// Always-on banner pinned to the top of the captured surface during a live
// session. Loud copy by default; rarely overridden.

import React from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

export interface BannerTheme {
  background?: string;
  foreground?: string;
  endButtonBackground?: string;
  endButtonForeground?: string;
  copy?: string;
  endLabel?: string;
}

export interface ConsentBannerProps {
  theme?: BannerTheme;
  onEnd(): void;
}

const DEFAULT_COPY = "Sira support is viewing your screen";

export const ConsentBanner: React.FC<ConsentBannerProps> = ({ theme = {}, onEnd }) => {
  const bg = theme.background ?? "#b00020";
  const fg = theme.foreground ?? "#fff";
  const btnBg = theme.endButtonBackground ?? "#fff";
  const btnFg = theme.endButtonForeground ?? "#b00020";
  const copy = theme.copy ?? DEFAULT_COPY;
  const endLabel = theme.endLabel ?? "End";

  return (
    <SafeAreaView style={[styles.wrap, { backgroundColor: bg }]} pointerEvents="box-none">
      <View style={styles.row}>
        <Text style={[styles.copy, { color: fg }]} numberOfLines={2}>
          {copy}
        </Text>
        <Pressable
          onPress={onEnd}
          style={[styles.endBtn, { backgroundColor: btnBg }]}
          accessibilityRole="button"
          accessibilityLabel="sira-end-button"
          testID="sira-end-button"
        >
          <Text style={[styles.endText, { color: btnFg }]}>{endLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 99999 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  copy: { flex: 1, fontSize: 13, fontWeight: "600" },
  endBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  endText: { fontWeight: "800", fontSize: 14 },
});

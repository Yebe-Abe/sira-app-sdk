// Wraps a subtree that must not appear in captured frames. During an
// active session the subtree is overlaid with an opaque black rectangle
// — the native capture pipeline records whatever's on screen, so the
// output frames literally contain a black box where the PII was.
//
// This is more reliable than the previous "register rect, paint
// natively" approach: no DP/pixel coordinate math, no race between
// onLayout firing and the frame being captured, and the customer can
// SEE that the values won't be shared (which is good UX).
//
// When no session is active the children render normally — the wrapper
// is invisible.
//
// Defense-in-depth: native code on both platforms also auto-redacts
//   (a) <TextInput secureTextEntry={true}> via the platform's native
//       password-field flag (UITextField.isSecureTextEntry on iOS,
//       EditText InputType.TYPE_TEXT_VARIATION_PASSWORD on Android), and
//   (b) any view whose testID matches a pattern in
//       SiraSupport's `redaction.testIDPatterns` prop.
// Those run independent of <SiraRedact> and cover the case where an
// integrator forgets to wrap a sensitive field. <SiraRedact> remains
// the explicit primary mechanism — visible + obvious.

import React from "react";
import { View, type ViewProps } from "react-native";

import { useIsLiveSession } from "../SiraSupport";

export interface SiraRedactProps extends ViewProps {
  children?: React.ReactNode;
}

export const SiraRedact: React.FC<SiraRedactProps> = ({ children, style, ...rest }) => {
  const isLive = useIsLiveSession();
  return (
    <View style={style} {...rest}>
      {children}
      {isLive ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "black",
          }}
        />
      ) : null}
    </View>
  );
};

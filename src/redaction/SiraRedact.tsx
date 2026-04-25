// Wraps a subtree that must not appear in captured frames. We measure the
// view's window-relative bounds on every layout and register/unregister with
// the native side so the capture pipeline can paint over the rectangle
// before encoding. Redacted bytes never leave the device.

import React, { useEffect, useId, useRef } from "react";
import { View, type LayoutChangeEvent, type ViewProps } from "react-native";

import { SiraSupportNative } from "../native/SiraSupportModule";

export interface SiraRedactProps extends ViewProps {
  children?: React.ReactNode;
}

export const SiraRedact: React.FC<SiraRedactProps> = ({ children, onLayout, ...rest }) => {
  const id = useId();
  const ref = useRef<View>(null);

  const handleLayout = (e: LayoutChangeEvent) => {
    onLayout?.(e);
    // Measure window-relative coordinates; LayoutChangeEvent gives parent-
    // relative ones, which the native side cannot use without context.
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) {
        try {
          SiraSupportNative.registerRedactionRect(id, x, y, w, h);
        } catch {
          // Native module not linked (e.g. Storybook). Redaction wrapping
          // should never crash the host app.
        }
      }
    });
  };

  useEffect(() => {
    return () => {
      try {
        SiraSupportNative.unregisterRedactionRect(id);
      } catch {}
    };
  }, [id]);

  return (
    <View ref={ref} onLayout={handleLayout} {...rest}>
      {children}
    </View>
  );
};

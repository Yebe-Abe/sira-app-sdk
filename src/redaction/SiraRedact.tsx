// Wraps a subtree that must not appear in captured frames. We measure the
// view's window-relative bounds on every layout and register/unregister with
// the native side so the capture pipeline can paint over the rectangle
// before encoding. Redacted bytes never leave the device.

import React, { useEffect, useId, useRef } from "react";
import { PixelRatio, View, type LayoutChangeEvent, type ViewProps } from "react-native";

import { SiraSupportNative } from "../native/SiraSupportModule";

export interface SiraRedactProps extends ViewProps {
  children?: React.ReactNode;
}

export const SiraRedact: React.FC<SiraRedactProps> = ({ children, onLayout, ...rest }) => {
  const id = useId();
  const ref = useRef<View>(null);

  const handleLayout = (e: LayoutChangeEvent) => {
    onLayout?.(e);
    // measureInWindow returns DP (density-independent pixels). The native
    // capture pipeline draws onto the bitmap in physical pixels. Convert
    // here so iOS / Android can paint without knowing the JS coord system.
    // Without this, on a Pixel 8 (density ~2.6) the redaction rects land
    // ~3× smaller and ~3× closer to the top-left than the actual text.
    const r = PixelRatio.get();
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) {
        try {
          SiraSupportNative.registerRedactionRect(id, x * r, y * r, w * r, h * r);
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

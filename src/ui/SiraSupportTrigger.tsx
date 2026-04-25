// Unstyled wrapper around openCodeEntry(). Inherits host-app styles via
// the standard Pressable surface; integrators provide their own children
// (icon + label, custom button, etc.).

import React from "react";
import { Pressable, type PressableProps } from "react-native";

import { useSiraSupport } from "../SiraSupport";

export interface SiraSupportTriggerProps extends Omit<PressableProps, "onPress"> {
  children?: React.ReactNode;
}

export const SiraSupportTrigger: React.FC<SiraSupportTriggerProps> = ({ children, ...rest }) => {
  const { openCodeEntry } = useSiraSupport();
  return (
    <Pressable onPress={openCodeEntry} {...rest}>
      {children}
    </Pressable>
  );
};

// The annotation overlay itself is native (section 4 of the spec): a
// dedicated UIWindow on iOS, a top-of-root View on Android. JS does not
// render the overlay — it only forwards agent messages to the native side,
// which paints them onto the appropriate surface.

import { SiraSupportNative } from "../native/SiraSupportModule";
import type { AnnotationMsg } from "../protocol/messages";

export const AnnotationBridge = {
  apply(msg: AnnotationMsg): void {
    if (msg.t === "clear") {
      try {
        SiraSupportNative.clearAnnotations();
      } catch {}
      return;
    }
    try {
      SiraSupportNative.showAnnotation(JSON.stringify(msg));
    } catch {}
  },
};

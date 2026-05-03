#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_REMAP_MODULE(SiraSupport, SiraSupport, RCTEventEmitter)

RCT_EXTERN_METHOD(startCapture:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopCapture:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(showAnnotation:(NSString *)payload)
RCT_EXTERN_METHOD(clearAnnotations)
RCT_EXTERN_METHOD(setAnnotationViewport:(nonnull NSNumber *)w h:(nonnull NSNumber *)h)

RCT_EXTERN_METHOD(registerRedactionRect:(NSString *)id
                  x:(nonnull NSNumber *)x
                  y:(nonnull NSNumber *)y
                  w:(nonnull NSNumber *)w
                  h:(nonnull NSNumber *)h)

RCT_EXTERN_METHOD(unregisterRedactionRect:(NSString *)id)

RCT_EXTERN_METHOD(requestProjectionConsent:(NSString *)captureMode
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

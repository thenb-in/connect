#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <CallKit/CallKit.h>
#import <UIKit/UIKit.h>

@interface CallObserverModule : RCTEventEmitter <RCTBridgeModule, CXCallObserverDelegate>
@property (nonatomic, strong) CXCallObserver *callObserver;
@property (nonatomic, assign) BOOL hasListeners;
// UUID string -> background task identifier. Kept per-call so simultaneous
// calls don't share or stomp on each other's task handle.
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *backgroundTasks;
@end

@implementation CallObserverModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init {
  if (self = [super init]) {
    _backgroundTasks = [NSMutableDictionary new];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"CallStateChanged"];
}

- (void)startObserving {
  self.hasListeners = YES;
  if (!self.callObserver) {
    self.callObserver = [[CXCallObserver alloc] init];
    [self.callObserver setDelegate:self queue:nil];
  }
}

- (void)stopObserving {
  self.hasListeners = NO;
}

- (void)invalidate {
  if (self.callObserver) {
    [self.callObserver setDelegate:nil queue:nil];
    self.callObserver = nil;
  }
  [self endAllBackgroundTasks];
  self.hasListeners = NO;
  [super invalidate];
}

- (void)dealloc {
  if (_callObserver) {
    [_callObserver setDelegate:nil queue:nil];
    _callObserver = nil;
  }
  [self endAllBackgroundTasks];
}

// Without an active background task iOS suspends our process within seconds
// of `tel:` handing the call off, and we miss the CXCallObserver `hasConnected`
// / `hasEnded` callbacks needed to compute duration. Begin a task on first
// sight of a call so the process stays alive for ~30s — enough for typical
// outgoing calls — and end it when the call ends (or expires).
- (void)beginBackgroundTaskForCall:(NSString *)uuid {
  if (uuid.length == 0) return;
  if (self.backgroundTasks[uuid]) return;
  UIBackgroundTaskIdentifier taskId = [[UIApplication sharedApplication]
      beginBackgroundTaskWithName:[NSString stringWithFormat:@"CallObserver-%@", uuid]
                expirationHandler:^{
                  [self endBackgroundTaskForCall:uuid];
                }];
  if (taskId != UIBackgroundTaskInvalid) {
    self.backgroundTasks[uuid] = @(taskId);
    NSLog(@"[CallObserverModule] began background task for %@", uuid);
  }
}

- (void)endBackgroundTaskForCall:(NSString *)uuid {
  NSNumber *taskNum = self.backgroundTasks[uuid];
  if (!taskNum) return;
  [self.backgroundTasks removeObjectForKey:uuid];
  UIBackgroundTaskIdentifier taskId = [taskNum unsignedIntegerValue];
  if (taskId != UIBackgroundTaskInvalid) {
    [[UIApplication sharedApplication] endBackgroundTask:taskId];
    NSLog(@"[CallObserverModule] ended background task for %@", uuid);
  }
}

- (void)endAllBackgroundTasks {
  NSArray<NSString *> *uuids = [self.backgroundTasks.allKeys copy];
  for (NSString *uuid in uuids) {
    [self endBackgroundTaskForCall:uuid];
  }
}

- (void)callObserver:(CXCallObserver *)callObserver callChanged:(CXCall *)call {
  NSString *uuid = [call.UUID UUIDString] ?: @"";

  // Hold the process awake for outgoing calls from the first sighting. Do this
  // even when there are no JS listeners — we still want the OS to keep us
  // running so subsequent state-change events get delivered.
  if (call.isOutgoing && !call.hasEnded) {
    [self beginBackgroundTaskForCall:uuid];
  }

  if (self.hasListeners) {
    NSDictionary *payload = @{
      @"uuid": uuid,
      @"isOutgoing": @(call.isOutgoing),
      @"hasConnected": @(call.hasConnected),
      @"hasEnded": @(call.hasEnded),
      @"isOnHold": @(call.onHold),
      @"timestamp": @((long long)([[NSDate date] timeIntervalSince1970] * 1000.0))
    };
    [self sendEventWithName:@"CallStateChanged" body:payload];
  }

  if (call.hasEnded) {
    // Defer release so the JS bridge has time to drain the final event before
    // iOS suspends us again.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
      [self endBackgroundTaskForCall:uuid];
    });
  }
}

@end

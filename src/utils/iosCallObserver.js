import { NativeEventEmitter, NativeModules, Platform, DeviceEventEmitter } from 'react-native';
import { storage } from '../mmkv';
import {
  getCallLogs,
  updateCallByCallId,
  removeCallByCallId,
  addCallLog,
} from '../storage';
import { normalizeLast10 } from './phone';

// Emitted after the observer mutates the call-log store so the UI can re-derive
// analysis from cache (no device IO) — see useConnectAnalysis.
export const CALL_LOGS_UPDATED_EVENT = 'CallLogsUpdated';

// In-memory state per CXCall UUID, created when a call is first observed and
// cleared on hasEnded. Holds the dialer match (phone + callId) and the
// connect-time so we can compute a real duration when the call ends.
const activeCalls = new Map();

// Dialer entries already claimed by a still-running observer, so two
// near-simultaneous calls can't collide on the same source row.
const consumedDialerTs = new Set();

let subscribed = false;

// Window for matching a CXCall to its originating dialer entry. The dialer write
// happens immediately before Linking.openURL(tel:); the OS surfaces the new call
// to CXCallObserver within ~0.5–3 s. 30 s is generous without being long enough
// that a *different* dial in between could be matched.
const SNAPSHOT_WINDOW_MS = 30 * 1000;

// Pop the oldest unconsumed dialer entry within the window (FIFO). CXCallObserver
// exposes no phone number for cellular calls, so we lean on ordering: iOS
// surfaces outgoing calls to the observer in the order they were placed, so the
// oldest unconsumed dial is the one this event belongs to. The matched entry is
// removed from MMKV immediately so nothing else can claim it.
const matchDialerEntry = (eventTs) => {
  const dialerStr = storage.getString('callDialer');
  if (!dialerStr) { return null; }
  try {
    const dialer = JSON.parse(dialerStr);
    if (!Array.isArray(dialer)) { return null; }
    let best = null;
    let bestIdx = -1;
    for (let i = 0; i < dialer.length; i++) {
      const entry = dialer[i];
      const ts = parseInt(entry?.timestamp, 10);
      if (!ts || !entry?.phoneNumber) { continue; }
      if (consumedDialerTs.has(ts)) { continue; }
      if (ts > eventTs) { continue; }
      if (eventTs - ts > SNAPSHOT_WINDOW_MS) { continue; }
      if (!best || ts < best.ts) {
        best = { ts, phoneNumber: entry.phoneNumber, callId: entry.callId || null };
        bestIdx = i;
      }
    }
    if (best) {
      consumedDialerTs.add(best.ts);
      dialer.splice(bestIdx, 1);
      storage.set('callDialer', JSON.stringify(dialer));
      return best;
    }
  } catch (e) {
    // ignore malformed dialer queue
  }
  return null;
};

// Fallback when the matched dialer entry carried no callId (older queue rows, or
// a row written before this change shipped): find the oldest provisional
// OUTGOING row for this number whose timestamp is within the window.
const findProvisionalCallId = (phoneNumber, eventTs) => {
  const key = normalizeLast10(phoneNumber);
  if (!key) { return null; }
  const logs = getCallLogs();
  let best = null;
  for (const log of logs) {
    if (!log?.provisional || !log?.callId) { continue; }
    if (normalizeLast10(log.phoneNumber) !== key) { continue; }
    const ts = Number(log.timestamp);
    if (!ts || ts > eventTs || eventTs - ts > SNAPSHOT_WINDOW_MS) { continue; }
    if (!best || ts < best.ts) { best = { ts, callId: log.callId }; }
  }
  return best?.callId || null;
};

// Apply the monitored outcome to the call-log store: fill in the real duration
// when the call connected, or remove the provisional row when it never did.
const applyOutcome = (state, durationSec, connected) => {
  const callId =
    state.callId || findProvisionalCallId(state.phoneNumber, state.firstSeenMs);

  if (!connected) {
    // The call never connected (no answer / declined). Drop the optimistic row.
    if (callId) { removeCallByCallId(callId); }
    return;
  }

  const patch = {
    duration: durationSec,
    connected: true,
    provisional: false,
    source: 'callkit',
    type: 'OUTGOING',
  };
  if (callId && updateCallByCallId(callId, patch)) { return; }

  // No row to patch (e.g. provisional write was skipped) — materialize one so
  // the connected call is still recorded.
  addCallLog({
    phoneNumber: state.phoneNumber || '',
    type: 'OUTGOING',
    timestamp: state.firstSeenMs,
    duration: durationSec,
    connected: true,
    madeBy: 'system',
    callId,
    provisional: false,
    source: 'callkit',
  });
};

export const startIosCallObserver = () => {
  if (Platform.OS !== 'ios') { return; }
  if (subscribed) { return; }
  const m = NativeModules.CallObserverModule;
  if (!m) {
    console.warn('[iosCallObserver] native module not linked');
    return;
  }
  console.log('[iosCallObserver] subscribing');
  const emitter = new NativeEventEmitter(m);
  emitter.addListener('CallStateChanged', (event) => {
    const uuid = event?.uuid;
    if (!uuid) { return; }
    const eventTs = Number(event.timestamp) || Date.now();

    let state = activeCalls.get(uuid);
    if (!state) {
      const match = event.isOutgoing ? matchDialerEntry(eventTs) : null;
      state = {
        firstSeenMs: eventTs,
        connectedAtMs: 0,
        isOutgoing: !!event.isOutgoing,
        phoneNumber: match?.phoneNumber || null,
        callId: match?.callId || null,
      };
      activeCalls.set(uuid, state);
      console.log('[iosCallObserver] new call', { uuid, callId: state.callId });
    }

    if (event.hasConnected && !state.connectedAtMs) {
      // Only treat this as the connect moment if hasConnected arrived in its own
      // event (after firstSeen). When the first event already has
      // hasConnected=true — iOS coalescing state after a background gap —
      // eventTs equals firstSeenMs; fall back to firstSeenMs so the duration
      // isn't a spurious 0 (slight ring-time overcount beats losing duration).
      state.connectedAtMs = eventTs > state.firstSeenMs ? eventTs : state.firstSeenMs;
    }

    if (event.hasEnded) {
      if (state.isOutgoing) {
        // "Connected" means we actually saw a connect event. If hasEnded arrives
        // without one (events dropped mid-call) but we did see hasConnected,
        // connectedAtMs is set; otherwise the call never connected.
        const connected = state.connectedAtMs > 0;
        const durationSec = connected && eventTs > state.connectedAtMs
          ? Math.max(0, Math.floor((eventTs - state.connectedAtMs) / 1000))
          : 0;
        try {
          applyOutcome(state, durationSec, connected);
          DeviceEventEmitter.emit(CALL_LOGS_UPDATED_EVENT);
          console.log('[iosCallObserver] outcome', {
            callId: state.callId, connected, durationSec,
          });
        } catch (err) {
          console.warn('[iosCallObserver] apply outcome failed:', err?.message);
        }
      }
      activeCalls.delete(uuid);
    }
  });
  subscribed = true;
};

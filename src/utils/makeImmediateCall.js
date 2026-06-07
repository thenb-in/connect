import { Platform, PermissionsAndroid, Alert, Linking } from 'react-native';
import RNImmediatePhoneCall from 'react-native-immediate-phone-call';
import { storage } from '../mmkv';
import { recordProvisionalCall } from '../storage';

// Queue an app-initiated dial in MMKV `callDialer` so the iOS CXCallObserver
// (src/utils/iosCallObserver.js) can match its upcoming CallStateChanged
// events against it. CXCallObserver gives no phone number for cellular
// calls, so the dialer queue is the only way to link a CallKit event to a
// specific number / call log row. The optional `callId` lets the observer
// link the matched event back to the exact provisional call-log row.
//
// Historically only CallDialerScreen wrote to this queue; calls placed from
// ContactDetailScreen bypassed it entirely, leaving the observer with
// nothing to match (and the duration stuck at 0). Centralize the write
// here so every path that calls makeImmediateCall benefits.
const enqueueDialerEntry = (phoneNumber, callId = null) => {
  try {
    const raw = storage.getString('callDialer');
    const existing = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(existing) ? existing : [];
    const updated = [
      { phoneNumber, callId, timestamp: Date.now().toString() },
      ...list,
    ].slice(0, 100);
    storage.set('callDialer', JSON.stringify(updated));
  } catch (err) {
    console.warn('[makeImmediateCall] failed to enqueue dialer entry:', err?.message);
  }
};

// Generates a reasonably-unique id for linking a tapped call across the dialer
// queue, the provisional call-log row, and the monitored result. Date.now()
// plus a short random suffix is plenty — these only need to be unique among the
// handful of calls in flight at once.
const newCallId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Requests a single Android runtime permission with a system dialog.
 * Returns true on non-Android (no permission model to request against).
 */
export const requestPermission = async (permission, title, message) => {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    const granted = await PermissionsAndroid.request(permission, {
      title,
      message,
      buttonNeutral: 'Ask Me Later',
      buttonNegative: 'Cancel',
      buttonPositive: 'OK',
    });
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (err) {
    Alert.alert('Error', `Failed to request ${title.toLowerCase()}: ${err.message}`);
    return false;
  }
};

/**
 * Validates a phone number, queues a dialer entry for iOS call observation,
 * then initiates the call (tel: on iOS, RNImmediatePhoneCall on Android).
 * `callId` (optional) links the dialer entry to a provisional call-log row so
 * the iOS observer can fill in / remove it once the call ends.
 * Returns true if the call was initiated successfully.
 */
export const makeImmediateCall = async (phoneNumber, { callId = null } = {}) => {
  if (!phoneNumber || phoneNumber === 'N/A' || phoneNumber.length < 7) {
    Alert.alert('Error', 'Invalid phone number');
    return false;
  }

  if (Platform.OS === 'ios') {
    const telUrl = `tel:${phoneNumber.replace(/[^0-9+*#]/g, '')}`;
    try {
      const canOpen = await Linking.canOpenURL(telUrl);
      if (!canOpen) {
        Alert.alert('Calls Not Available', 'This device cannot place phone calls.');
        return false;
      }
      // Enqueue BEFORE opening tel: — Linking.openURL resolves immediately
      // and the app may background before the next microtask, so any
      // post-openURL bookkeeping risks racing with the CXCallObserver
      // event that's about to fire.
      enqueueDialerEntry(phoneNumber, callId);
      await Linking.openURL(telUrl);
      return true;
    } catch (error) {
      console.error('iOS call initiation failed. Error:', error?.message);
      Alert.alert('Error', `Failed to initiate call: ${error?.message || 'unknown error'}`);
      return false;
    }
  }

  const hasPermission = await requestPermission(
    PermissionsAndroid.PERMISSIONS.CALL_PHONE,
    'Phone Call Permission',
    'This app needs permission to make phone calls.'
  );
  if (!hasPermission) {
    Alert.alert('Error', 'Call permission denied');
    return false;
  }
  try {
    RNImmediatePhoneCall.immediatePhoneCall(phoneNumber);
    return true;
  } catch (error) {
    console.error('Call initiation failed. Error:', error.message);
    Alert.alert('Error', `Failed to initiate call: ${error.message}`);
    return false;
  }
};

/**
 * Places a call AND records a provisional reconnect row tagged with a shared
 * callId, so the call monitor can reconcile it with what actually happened:
 *   - iOS: CXCallObserver fills in the real duration, or removes the row if the
 *          call never connected.
 *   - Android: the device call-log import supersedes it (reconcileProvisionalCalls).
 * This is the single entry point screens should use for the "Call" action.
 * Returns the makeImmediateCall promise (resolves true when the call started).
 */
export const initiateTrackedCall = (phoneNumber) => {
  const callId = newCallId();
  // Optimistic: write the provisional row before dialing so the UI updates
  // immediately. A failed/invalid call leaves a stray provisional row that the
  // monitor (or next reconcile) cleans up; acceptable for the snappier UX.
  recordProvisionalCall(phoneNumber, callId);
  return makeImmediateCall(phoneNumber, { callId });
};

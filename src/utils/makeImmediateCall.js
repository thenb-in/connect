import { Platform, PermissionsAndroid, Alert, Linking } from 'react-native';
import RNImmediatePhoneCall from 'react-native-immediate-phone-call';
import { storage } from '../mmkv';

// Queue an app-initiated dial in MMKV `callDialer` so the iOS CXCallObserver
// (src/utils/iosCallObserver.js) can match its upcoming CallStateChanged
// events against it. CXCallObserver gives no phone number for cellular
// calls, so the dialer queue is the only way to link a CallKit event to a
// specific number / call log row.
//
// Historically only CallDialerScreen wrote to this queue; calls placed from
// ContactDetailScreen bypassed it entirely, leaving the observer with
// nothing to match (and the duration stuck at 0). Centralize the write
// here so every path that calls makeImmediateCall benefits.
const enqueueDialerEntry = (phoneNumber) => {
  try {
    const raw = storage.getString('callDialer');
    const existing = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(existing) ? existing : [];
    const updated = [
      { phoneNumber, timestamp: Date.now().toString() },
      ...list,
    ].slice(0, 100);
    storage.set('callDialer', JSON.stringify(updated));
  } catch (err) {
    console.warn('[makeImmediateCall] failed to enqueue dialer entry:', err?.message);
  }
};

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
 * Returns true if the call was initiated successfully.
 */
export const makeImmediateCall = async (phoneNumber) => {
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
      enqueueDialerEntry(phoneNumber);
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

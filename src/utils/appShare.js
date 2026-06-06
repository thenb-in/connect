import { Linking, Platform, Alert, Share } from 'react-native';

const ANDROID_PACKAGE = 'tech.navlakha.connect';

export const APP_NAME = 'Connect';
export const COMPANY_NAME = 'Navlakha Technologies';
export const APP_WEBSITE_URL = 'https://navlakha.tech/connect';
export const PRIVACY_POLICY_URL = 'https://navlakha.tech/privacy';
export const CONTACT_EMAIL = 'support@navlakha.tech';
export const FOUNDER_CREDITS = 'Built with ❤️ by Navlakha Technologies';
export const WHATSAPP_SUPPORT_NUMBER = '+918275269688';

const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

// iOS build isn't published yet — surfaces show "coming soon" when this is null.
const IOS_STORE_URL = null;

export const getStoreUrl = () =>
  Platform.OS === 'ios' ? IOS_STORE_URL : PLAY_STORE_URL;

export const shareApp = async () => {
  const storeUrl = getStoreUrl();
  const lines = [
    `Try ${APP_NAME} — a calmer way to stay in touch with the people who matter to you.`,
    '',
    storeUrl
      ? storeUrl
      : `Coming soon to iOS. Available now on Android: ${PLAY_STORE_URL}`,
  ];
  try {
    await Share.share({ message: lines.join('\n') });
  } catch (err) {
    console.warn('[appShare] share failed:', err?.message || err);
  }
};

/**
 * Sends a WhatsApp text message to the given phone number. Phone should be
 * digits (with or without country code). Falls back to an alert if WhatsApp
 * isn't installed.
 */
export const sendWhatsAppMessage = async (phone, message = '') => {
  const digits = (phone || '').toString().replace(/\D/g, '');
  if (!digits) {
    Alert.alert('Invalid number', 'No WhatsApp-able phone number on this contact.');
    return;
  }
  const text = message ? `&text=${encodeURIComponent(message)}` : '';

  const candidates = [
    `whatsapp://send?phone=${digits}${text}`,
    // wa.me works without the leading "+".
    message
      ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
      : `https://wa.me/${digits}`,
  ];
  for (const url of candidates) {
    try {
      await Linking.openURL(url);
      return;
    } catch (err) {
      console.warn('[appShare] whatsapp open failed:', url, err?.message || err);
    }
  }
  Alert.alert('WhatsApp not available', 'WhatsApp doesn\'t seem to be installed on this device.');
};

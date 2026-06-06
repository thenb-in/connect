import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Linking,
  Platform,
} from 'react-native';
import DeviceInfo from 'react-native-device-info';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import {
  APP_NAME,
  APP_WEBSITE_URL,
  PRIVACY_POLICY_URL,
  getStoreUrl,
} from '../utils/appShare';

/**
 * About Connect, presented as a centered modal so it can be surfaced from
 * anywhere (the Home overflow menu, Settings, etc.) instead of living as an
 * inline section on the Settings screen.
 */
const AboutModal = ({ visible, onClose }) => (
  <Modal
    visible={visible}
    transparent
    animationType="fade"
    onRequestClose={onClose}
  >
    <TouchableOpacity
      activeOpacity={1}
      style={styles.backdrop}
      onPress={onClose}
    >
      {/* Swallow taps on the card so they don't bubble up to the backdrop. */}
      <TouchableOpacity activeOpacity={1} style={styles.card}>
        <View style={styles.iconRow}>
          <View style={styles.iconWrap}>
            <Icon
              name="account-heart-outline"
              size={28}
              color={theme.colors.primary}
            />
          </View>
        </View>

        <Text style={styles.title}>{APP_NAME}</Text>
        <Text style={styles.body}>
          A calmer way to stay in touch with the people who matter.
        </Text>
        <Text style={styles.version}>Version {DeviceInfo.getVersion()}</Text>

        <View style={styles.separator} />

        <View style={styles.privacyRow}>
          <Icon
            name="shield-lock-outline"
            size={20}
            color={theme.colors.primary}
            style={styles.privacyIcon}
          />
          <View style={styles.privacyBody}>
            <Text style={styles.privacyTitle}>Local-only storage</Text>
            <Text style={styles.privacyText}>
              Everything in Connect lives on this device. Nothing is sent to a
              server.
            </Text>
          </View>
        </View>

        <View style={styles.separator} />

        <View style={styles.privacyRow}>
          <Icon
            name="eye-outline"
            size={20}
            color={theme.colors.primary}
            style={styles.privacyIcon}
          />
          <View style={styles.privacyBody}>
            <Text style={styles.privacyTitle}>Read-only access</Text>
            <Text style={styles.privacyText}>
              Connect only reads your contacts, call log to surface gentle
              reminders — it never edits, deletes, or shares them.
            </Text>
          </View>
        </View>

        <View style={styles.separator} />

        <TouchableOpacity onPress={() => Linking.openURL(APP_WEBSITE_URL)}>
          <Text style={styles.linkText}>{APP_WEBSITE_URL}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
          <Text style={styles.linkText}>Privacy policy</Text>
        </TouchableOpacity>
        {getStoreUrl() ? (
          <TouchableOpacity onPress={() => Linking.openURL(getStoreUrl())}>
            <Text style={styles.linkText}>
              {Platform.OS === 'ios'
                ? 'Rate us on the App Store'
                : 'Rate us on the Play Store'}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.comingSoon}>iOS app coming soon</Text>
        )}

        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </TouchableOpacity>
  </Modal>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xl,
    alignItems: 'center',
  },
  iconRow: {
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.chipBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  version: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
  },
  separator: {
    height: 1,
    alignSelf: 'stretch',
    backgroundColor: theme.colors.divider,
    marginVertical: theme.spacing.md,
  },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
  },
  privacyIcon: {
    marginRight: theme.spacing.md,
    marginTop: 1,
  },
  privacyBody: { flex: 1 },
  privacyTitle: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: 2,
  },
  privacyText: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.font.small,
    textDecorationLine: 'underline',
    marginTop: theme.spacing.xs,
  },
  comingSoon: {
    marginTop: theme.spacing.xs,
    fontStyle: 'italic',
    color: theme.colors.textSubtle,
    fontSize: theme.font.small,
  },
  closeBtn: {
    marginTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  closeBtnText: {
    color: theme.colors.surface,
    fontWeight: '700',
  },
});

export default AboutModal;

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import ConnectSetupButton from './ConnectSetupButton';
import { isOnboardingComplete } from '../storage';

/**
 * Gates Connect screen bodies behind the onboarding flag. When Connect setup
 * is not done, renders a "Setup is pending" prompt with a Set up Connect
 * button instead of the wrapped children — so screens never show misleading
 * empty-state copy (e.g. "Nothing pressing right now") when the real reason
 * for empty data is that setup never happened.
 *
 * Re-checks onboarding completeness on every focus so a flip elsewhere in the
 * app — including an OS permission revoke, which the derived gate detects — is
 * picked up without needing a remount.
 */
const ConnectSetupGate = ({ children }) => {
  const [ready, setReady] = useState(isOnboardingComplete());

  useFocusEffect(
    useCallback(() => {
      setReady(isOnboardingComplete());
    }, []),
  );

  if (ready) { return children; }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Icon
          name="account-heart-outline"
          size={56}
          color={theme.colors.primary}
        />
        <Text style={styles.title}>Setup is pending</Text>
        <Text style={styles.body}>
          Finish Connect setup to see your reconnect lanes, groups, and contact insights.
        </Text>
        <Text style={styles.privacy}>
          Your privacy is our priority.
        </Text>
        <ConnectSetupButton label="Set up Connect" resetOnboarding={false} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.xl,
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
    marginTop: theme.spacing.md,
    textAlign: 'center',
  },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  privacy: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
    fontStyle: 'italic',
  },
});

export default ConnectSetupGate;

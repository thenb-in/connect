import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import theme from '../theme';
import { clearOnboardingAcks } from '../storage';

/**
 * Pill-style entry-point into Connect Mode setup. Clears the onboarding step
 * table so the setup screen is shown again, then routes the user to it —
 * finding the right navigator whether the button is rendered inside the Connect
 * stack or from a sibling stack (e.g. the auth screens).
 *
 * Props:
 *   - scale: number — multiplier for icon/text size on responsive screens.
 *   - style: ViewStyle — override container styles.
 *   - label: string — button text (defaults to "Connect setup").
 *   - resetOnboarding: bool — if false, do not clear the step table (use when
 *     the caller already manages that state).
 */
const ConnectSetupButton = ({
  scale = 1,
  style,
  label = 'Set up Connect',
  resetOnboarding = true,
}) => {
  const navigation = useNavigation();

  const handlePress = () => {
    if (resetOnboarding) {
      // Clear the step table (the gate) so onboarding genuinely restarts from
      // the welcome splash.
      clearOnboardingAcks();
    }
    let nav = navigation;
    while (nav) {
      const state = nav.getState?.();
      if (state?.routeNames?.includes('ConnectOnboarding')) {
        nav.navigate('ConnectOnboarding');
        return;
      }
      nav = nav.getParent?.();
    }
    navigation.navigate('Connect');
  };

  return (
    <TouchableOpacity
      style={[styles.button, style]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        name="account-heart-outline"
        size={Math.round(18 * scale)}
        color={theme.colors.primary}
        style={styles.icon}
      />
      <Text style={[styles.text, { fontSize: Math.round(13 * scale) }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  icon: { marginRight: 6 },
  text: { color: theme.colors.primary, fontWeight: '600' },
});

export default ConnectSetupButton;

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import theme from '../theme';

/**
 * Unified top header used across every mode (Connect, CRM Call, Location,
 * SalaryMitra). Left side carries the title (+ optional subtitle) and an
 * optional back chevron. The right side can either be a simple button
 * (rightLabel/rightIcon/onRightPress) or an arbitrary rightElement (e.g. a
 * ModeSwitch dropdown + profile menu).
 *
 * Drop the React Navigation built-in header for any screen that uses this:
 *   screenOptions={{ header: ({ options }) => <AppHeader title={options.title} rightElement={...} /> }}
 */
const AppHeader = ({
  title,
  subtitle,
  rightLabel,
  rightIcon,
  onRightPress,
  rightElement,
  onBack,
  backgroundColor = theme.colors.background,
}) => {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrapper, { backgroundColor, paddingTop: insets.top + theme.spacing.md }]}>
      <StatusBar barStyle="dark-content" backgroundColor={backgroundColor} />
      <View style={styles.row}>
        <View style={styles.leftSide}>
          {onBack ? (
            <TouchableOpacity
              onPress={onBack}
              style={styles.backBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="chevron-left" size={26} color={theme.colors.text} />
            </TouchableOpacity>
          ) : null}
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>

        {rightElement ? (
          rightElement
        ) : rightLabel || rightIcon ? (
          <TouchableOpacity
            onPress={onRightPress}
            style={styles.rightBtn}
            activeOpacity={0.8}
          >
            {rightIcon ? (
              <Icon
                name={rightIcon}
                size={16}
                color={theme.colors.primary}
                style={{ marginRight: rightLabel ? 6 : 0 }}
              />
            ) : null}
            {rightLabel ? (
              <Text style={styles.rightLabel}>{rightLabel}</Text>
            ) : null}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftSide: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    paddingRight: theme.spacing.md,
  },
  backBtn: {
    marginRight: theme.spacing.sm,
  },
  title: {
    fontSize: theme.font.h2,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  rightBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  rightLabel: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
});

export default AppHeader;

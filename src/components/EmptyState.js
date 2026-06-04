import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';

/**
 * Calm empty-state card used across Connect Mode screens. Tone: encouraging,
 * not corporate. Always at least 80px tall so a list view doesn't look
 * collapsed on a fresh install.
 */
const EmptyState = ({
  icon = 'leaf',
  title,
  body,
  actionLabel,
  onActionPress,
  compact = false,
}) => (
  <View style={[styles.wrapper, compact && styles.compact]}>
    <Icon name={icon} size={compact ? 28 : 38} color={theme.colors.primary} />
    {title ? <Text style={styles.title}>{title}</Text> : null}
    {body ? <Text style={styles.body}>{body}</Text> : null}
    {actionLabel ? (
      <TouchableOpacity onPress={onActionPress} style={styles.btn}>
        <Text style={styles.btnText}>{actionLabel}</Text>
      </TouchableOpacity>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  compact: {
    paddingVertical: theme.spacing.md,
  },
  title: {
    marginTop: theme.spacing.sm,
    fontSize: theme.font.body,
    color: theme.colors.text,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    marginTop: theme.spacing.xs,
    fontSize: theme.font.small,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  btn: {
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  btnText: {
    color: theme.colors.surface,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
});

export default EmptyState;

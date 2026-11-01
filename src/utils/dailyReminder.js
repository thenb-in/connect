import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  RepeatFrequency,
  TriggerType,
} from '@notifee/react-native';
import { getDailyReminderEnabled, setDailyReminderEnabled } from '../storage';

const NOTIFICATION_ID = 'connect-daily-reminder';
const CHANNEL_ID = 'connect-reminders';
// Early evening: late enough that most people are free to call.
const REMINDER_HOUR = 18;
const REMINDER_MINUTE = 30;

const nextReminderAt = (now = new Date()) => {
  const at = new Date(now);
  at.setHours(REMINDER_HOUR, REMINDER_MINUTE, 0, 0);
  if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
};

// The copy repeats daily until the app next opens, so it names no day count
// that would go stale. Scheduled locally: nothing leaves the device.
const reminderBody = (analysis) => {
  const name = analysis?.reconnectToday?.[0]?.contact?.name;
  return name
    ? `You haven't spoken to ${name} in a while. Say hi?`
    : 'Open Connect and spin for someone to call.';
};

/**
 * Brings the one scheduled reminder in line with the saved preference and the
 * latest analysis. Safe to call on every refresh: the fixed id replaces the
 * previous schedule, so reminders never stack. Never throws.
 */
export const syncDailyReminder = async (analysis) => {
  try {
    if (!getDailyReminderEnabled()) {
      await notifee.cancelNotification(NOTIFICATION_ID);
      return;
    }
    const channelId = await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Reconnect reminders',
      importance: AndroidImportance.DEFAULT,
    });
    await notifee.createTriggerNotification(
      {
        id: NOTIFICATION_ID,
        title: 'Who should you call today?',
        body: reminderBody(analysis),
        android: { channelId, pressAction: { id: 'default' } },
      },
      {
        type: TriggerType.TIMESTAMP,
        timestamp: nextReminderAt(),
        repeatFrequency: RepeatFrequency.DAILY,
      },
    );
  } catch (err) {
    console.warn('[dailyReminder] sync failed:', err?.message || err);
  }
};

/**
 * Asks for notification permission and saves the outcome.
 * @returns {Promise<boolean>} true when the reminder is now on.
 */
export const enableDailyReminder = async () => {
  try {
    const { authorizationStatus } = await notifee.requestPermission();
    const granted =
      authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      authorizationStatus === AuthorizationStatus.PROVISIONAL;
    setDailyReminderEnabled(granted);
    return granted;
  } catch (err) {
    console.warn('[dailyReminder] permission failed:', err?.message || err);
    return false;
  }
};

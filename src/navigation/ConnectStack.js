import React, { useCallback, useMemo, useState } from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import HomeScreen from '../screens/HomeScreen';
import ReconnectListScreen from '../screens/ReconnectListScreen';
import GroupsScreen from '../screens/GroupsScreen';
import GroupDetailScreen from '../screens/GroupDetailScreen';
import ContactDetailScreen from '../screens/ContactDetailScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import SettingsScreen from '../screens/SettingsScreen';
import BulkCategoriseScreen from '../screens/BulkCategoriseScreen';
import CallLogsScreen from '../screens/CallLogsScreen';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { isOnboardingComplete, getShowHiddenCards } from '../storage';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

/**
 * Bottom-tab shell for Connect Mode. We use four lanes that mirror the
 * product spec: Home, Reconnect (extended view of "Reconnect Today"),
 * Groups, and All (a generic browse-all-contacts list).
 *
 * The Reconnect tab is hidden from the bar when there's nothing to reconnect to
 * yet — same rule as the Home "Reconnect today" card: with no reconnect data,
 * show it only once there's enough call history to be meaningful (≥3 connected
 * people) or "show hidden cards" is on. The screen stays registered so any
 * programmatic navigation to it still works; only its tab button is dropped.
 */
const ConnectTabs = () => {
  const { analysis } = useConnectAnalysis();
  const [showHidden, setShowHidden] = useState(() => getShowHiddenCards());
  // Re-read the toggle when the tabs regain focus (e.g. back from a stack
  // screen) so flipping it in Settings reflects here.
  useFocusEffect(
    useCallback(() => {
      setShowHidden(getShowHiddenCards());
    }, []),
  );
  const reconnectCount = analysis?.reconnectToday?.length || 0;
  const enoughData = (analysis?.counts?.connectedPeople || 0) >= 3;
  const showReconnect = reconnectCount > 0 || showHidden || enoughData;

  return (
  <Tab.Navigator
    screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: theme.colors.primary,
      tabBarInactiveTintColor: theme.colors.textSubtle,
      tabBarStyle: {
        backgroundColor: theme.colors.surface,
        borderTopColor: theme.colors.divider,
      },
    }}
  >
    <Tab.Screen
      name="ConnectHome"
      component={HomeScreen}
      options={{
        title: 'Home',
        tabBarIcon: ({ color, size }) => (
          <Icon name="home-heart" color={color} size={size} />
        ),
      }}
    />
    <Tab.Screen
      name="ConnectReconnect"
      component={ReconnectListScreen}
      initialParams={{ lane: 'reconnect' }}
      options={{
        title: 'Reconnect',
        tabBarIcon: ({ color, size }) => (
          <Icon name="account-arrow-right-outline" color={color} size={size} />
        ),
        // Hide the tab button (keep the screen registered) when there's no
        // reconnect data and not enough history yet.
        tabBarButton: showReconnect ? undefined : () => null,
        tabBarItemStyle: showReconnect ? undefined : { display: 'none' },
      }}
    />
    <Tab.Screen
      name="ConnectGroups"
      component={GroupsScreen}
      options={{
        title: 'Groups',
        tabBarIcon: ({ color, size }) => (
          <Icon name="account-group-outline" color={color} size={size} />
        ),
      }}
    />
    <Tab.Screen
      name="ConnectBrowse"
      component={ReconnectListScreen}
      initialParams={{ lane: 'never' }}
      options={{
        title: 'New',
        tabBarIcon: ({ color, size }) => (
          <Icon name="account-multiple-plus-outline" color={color} size={size} />
        ),
      }}
    />
    <Tab.Screen
      name="ConnectSettings"
      component={SettingsScreen}
      options={{
        title: 'Settings',
        tabBarIcon: ({ color, size }) => (
          <Icon name="cog-outline" color={color} size={size} />
        ),
      }}
    />
  </Tab.Navigator>
  );
};

/**
 * Top-level Connect Mode stack: onboarding first if not done, otherwise the
 * tab navigator and a few stack-only screens.
 */
const ConnectStack = () => {
  const initialRoute = useMemo(
    () => (isOnboardingComplete() ? 'ConnectTabs' : 'ConnectOnboarding'),
    [],
  );

  return (
    <Stack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="ConnectOnboarding">
        {(props) => (
          <OnboardingScreen
            {...props}
            onFinished={() => {
              // The `analysed` ack is already written by OnboardingScreen before
              // this fires, so the gate will route to Home — just swap stacks.
              props.navigation.reset({
                index: 0,
                routes: [{ name: 'ConnectTabs' }],
              });
            }}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="ConnectTabs" component={ConnectTabs} />

      <Stack.Screen name="ConnectLost">
        {(props) => (
          <ReconnectListScreen {...props} route={{ params: { lane: 'lost' } }} />
        )}
      </Stack.Screen>
      <Stack.Screen name="ConnectMissed">
        {(props) => (
          <ReconnectListScreen {...props} route={{ params: { lane: 'missed' } }} />
        )}
      </Stack.Screen>

      <Stack.Screen name="ConnectGroupDetail" component={GroupDetailScreen} />
      <Stack.Screen name="ConnectContactDetail" component={ContactDetailScreen} />
      <Stack.Screen name="ConnectCallLogs" component={CallLogsScreen} />
      <Stack.Screen name="ConnectBulkCategorise" component={BulkCategoriseScreen} />
    </Stack.Navigator>
  );
};

export default ConnectStack;

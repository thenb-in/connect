import React, { useMemo } from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
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
import { isOnboarded, setOnboarded } from '../storage';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

/**
 * Bottom-tab shell for Connect Mode. We use four lanes that mirror the
 * product spec: Home, Reconnect (extended view of "Reconnect Today"),
 * Groups, and All (a generic browse-all-contacts list).
 */
const ConnectTabs = ({ mode, onLogin, onSelectMode, user, onLogout }) => (
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
      options={{
        title: 'Home',
        tabBarIcon: ({ color, size }) => (
          <Icon name="home-heart" color={color} size={size} />
        ),
      }}
    >
      {(props) => (
        <HomeScreen
          {...props}
          mode={mode}
          onLogin={onLogin}
          onSelectMode={onSelectMode}
          user={user}
          onLogout={onLogout}
        />
      )}
    </Tab.Screen>
    <Tab.Screen
      name="ConnectReconnect"
      component={ReconnectListScreen}
      initialParams={{ lane: 'reconnect' }}
      options={{
        title: 'Reconnect',
        tabBarIcon: ({ color, size }) => (
          <Icon name="account-arrow-right-outline" color={color} size={size} />
        ),
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
      options={{
        title: 'Settings',
        tabBarIcon: ({ color, size }) => (
          <Icon name="cog-outline" color={color} size={size} />
        ),
      }}
    >
      {(props) => (
        <SettingsScreen
          {...props}
          mode={mode}
          user={user}
          onLogin={onLogin}
          onLogout={onLogout}
        />
      )}
    </Tab.Screen>
  </Tab.Navigator>
);

/**
 * Top-level Connect Mode stack: onboarding first if not done, otherwise the
 * tab navigator and a few stack-only screens.
 */
const ConnectStack = ({ mode, onLogin, onSelectMode, onExitConnect, user, onLogout }) => {
  const initialRoute = useMemo(
    () => (isOnboarded() ? 'ConnectTabs' : 'ConnectOnboarding'),
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
            onLogin={onLogin}
            onExitConnect={onExitConnect}
            onFinished={() => {
              setOnboarded(true);
              props.navigation.reset({
                index: 0,
                routes: [{ name: 'ConnectTabs' }],
              });
            }}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="ConnectTabs">
        {(props) => (
          <ConnectTabs
            {...props}
            mode={mode}
            onLogin={onLogin}
            onSelectMode={onSelectMode}
            user={user}
            onLogout={onLogout}
          />
        )}
      </Stack.Screen>

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

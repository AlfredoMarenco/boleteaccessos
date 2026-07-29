import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import * as NavigationBar from 'expo-navigation-bar';
import { ActivityIndicator, View, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useKeepAwake } from 'expo-keep-awake';

import LoginScreen from './src/screens/LoginScreen';
import EventsScreen from './src/screens/EventsScreen';
import SyncScreen from './src/screens/SyncScreen';
import ScannerScreen from './src/screens/ScannerScreen';
import UpdateChecker from './src/components/UpdateChecker';
import ErrorBoundary from './src/components/ErrorBoundary';

import { initDatabase } from './src/services/database';
import { colors } from './src/theme/colors';

const Stack = createNativeStackNavigator();

export default function App() {
  useKeepAwake();
  const [initialRoute, setInitialRoute] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      // Initialize offline database
      await initDatabase();

      // Check if user is already logged in
      const token = await AsyncStorage.getItem('scanner_token');
      if (token) {
        setInitialRoute('Events');
      } else {
        setInitialRoute('Login');
      }
    }
    init();

    // Hide navigation bar on Android for immersive mode
    if (Platform.OS === 'android') {
      const hideNavBar = async () => {
        try {
          await NavigationBar.setVisibilityAsync('hidden');
          await NavigationBar.setBehaviorAsync('inset-swipe');
        } catch (e) {
          console.log('Error hiding navigation bar:', e);
        }
      };
      hideNavBar();
    }
  }, []);

  if (!initialRoute) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <NavigationContainer>
        <StatusBar style="auto" />
        <Stack.Navigator 
          initialRouteName={initialRoute}
          screenOptions={{
            headerStyle: {
              backgroundColor: colors.primary,
            },
            headerTintColor: colors.background,
            headerTitleStyle: {
              fontWeight: 'bold',
            },
          }}
        >
          <Stack.Screen 
            name="Login" 
            component={LoginScreen} 
            options={{ headerShown: false }} 
          />
          <Stack.Screen 
            name="Events" 
            component={EventsScreen} 
            options={{ title: 'Boletea Eventos', headerShown: false }} 
          />
          <Stack.Screen 
            name="Sync" 
            component={SyncScreen} 
            options={{ title: 'Base de Datos' }} 
          />
          <Stack.Screen 
            name="Scanner" 
            component={ScannerScreen} 
            options={{ headerShown: false }} 
          />
        </Stack.Navigator>
      </NavigationContainer>
      <UpdateChecker />
    </ErrorBoundary>
  );
}

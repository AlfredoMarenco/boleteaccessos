import { NativeModules, Platform, PermissionsAndroid } from 'react-native';

const { ForegroundService } = NativeModules;

export const startForegroundService = async (message: string = 'Escáner activo y listo para usar.') => {
  if (Platform.OS !== 'android') return;

  try {
    // Para Android 13+ (API 33+), solicitar permiso de notificaciones
    if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
      const hasPermission = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      if (!hasPermission) {
        const status = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          {
            title: 'Permiso de Notificación',
            message: 'Boletea Accesos necesita permisos de notificación para mantener la app activa en segundo plano.',
            buttonNeutral: 'Preguntar después',
            buttonNegative: 'Cancelar',
            buttonPositive: 'Aceptar',
          }
        );
        if (status !== PermissionsAndroid.RESULTS.GRANTED) {
          console.log('Permiso de notificación denegado');
        }
      }
    }

    if (ForegroundService && typeof ForegroundService.startService === 'function') {
      ForegroundService.startService(message);
    } else {
      console.warn('ForegroundService native module is not available.');
    }
  } catch (error) {
    console.error('Error starting foreground service:', error);
  }
};

export const stopForegroundService = () => {
  if (Platform.OS !== 'android') return;

  try {
    if (ForegroundService && typeof ForegroundService.stopService === 'function') {
      ForegroundService.stopService();
    }
  } catch (error) {
    console.error('Error stopping foreground service:', error);
  }
};

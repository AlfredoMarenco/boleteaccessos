import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Image, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { loginDevice } from '../services/accessService';
import { colors } from '../theme/colors';
import { QrCode, X } from 'lucide-react-native';
import packageJson from '../../package.json';

const logo = require('../assets/logoBoletea.png');

export default function LoginScreen({ navigation }: any) {
  const [deviceIdentifier, setDeviceIdentifier] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const handleLogin = async (id?: string, token?: string) => {
    const finalId = id || deviceIdentifier;
    const finalToken = token || apiToken;

    if (!finalId || !finalToken) {
      Alert.alert('Error', 'Por favor ingresa todos los campos o escanea el QR');
      return;
    }

    setLoading(true);
    try {
      const data = await loginDevice(finalId, finalToken);
      if (data.token) {
        await AsyncStorage.setItem('scanner_token', data.token);
        await AsyncStorage.setItem('device_info', JSON.stringify(data.device));
        navigation.replace('Events');
      }
    } catch (error: any) {
      console.error(error);
      Alert.alert('Error de acceso', error.response?.data?.message || 'Error al conectar con el servidor');
    } finally {
      setLoading(false);
    }
  };

  const handleQrScan = async () => {
    if (!permission?.granted) {
      const { granted } = await requestPermission();
      if (!granted) {
        Alert.alert('Permiso denegado', 'Necesitamos acceso a la cámara para escanear el código QR');
        return;
      }
    }
    setIsScanning(true);
  };

  const onBarCodeScanned = ({ data }: { data: string }) => {
    setIsScanning(false);
    try {
      // Intentamos parsear como JSON (formato del sistema Laravel)
      if (data.startsWith('{')) {
        const config = JSON.parse(data);
        if (config.device_identifier && config.api_token) {
          setDeviceIdentifier(config.device_identifier);
          setApiToken(config.api_token);
          
          // Opcional: Podríamos actualizar la URL del servidor aquí si quisiéramos
          // await AsyncStorage.setItem('server_url', config.server_url);
          
          handleLogin(config.device_identifier, config.api_token);
          return;
        }
      }
      
      // Formato alternativo simple: IDENTIFIER|TOKEN
      if (data.includes('|')) {
        const [id, token] = data.split('|');
        setDeviceIdentifier(id);
        setApiToken(token);
        handleLogin(id, token);
      } else {
        Alert.alert('Código inválido', 'El código QR no tiene el formato correcto');
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo leer el código QR o formato inválido');
    }
  };

  if (isScanning) {
    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          onBarcodeScanned={isScanning ? onBarCodeScanned : undefined}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <View style={styles.scannerOverlay}>
          <TouchableOpacity style={styles.closeScanner} onPress={() => setIsScanning(false)}>
            <X color="#fff" size={40} />
          </TouchableOpacity>
          <View style={styles.scanTarget} />
          <Text style={styles.scanText}>Apunta al código QR de vinculación</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: colors.background }}>
      <View style={styles.logoWrapper}>
        <Image source={logo} style={styles.logo} resizeMode="contain" />
      </View>

      <View style={styles.card}>
        <Text style={styles.subtitle}>Acceso a Dispositivo</Text>

        <TextInput
          style={styles.input}
          placeholder="Identificador del Dispositivo"
          placeholderTextColor={colors.textMuted}
          value={deviceIdentifier}
          onChangeText={setDeviceIdentifier}
          autoCapitalize="none"
        />

        <TextInput
          style={styles.input}
          placeholder="Token API"
          placeholderTextColor={colors.textMuted}
          value={apiToken}
          onChangeText={setApiToken}
          secureTextEntry
          autoCapitalize="none"
        />

        <TouchableOpacity style={styles.button} onPress={() => handleLogin()} disabled={loading}>
          {loading ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <Text style={styles.buttonText}>Vincular Manualmente</Text>
          )}
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.dividerText}>O</Text>
          <View style={styles.line} />
        </View>

        <TouchableOpacity style={styles.qrButton} onPress={handleQrScan} disabled={loading}>
          <QrCode color={colors.primary} size={24} />
          <Text style={styles.qrButtonText}>Escanear Código QR</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.versionText}>v{packageJson.version}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    padding: 24,
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 36,
  },
  logo: {
    width: 260,
    height: 110,
  },
  card: {
    backgroundColor: colors.card,
    padding: 24,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 24,
    fontWeight: '600',
  },
  input: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    fontSize: 16,
    color: colors.text,
  },
  button: {
    backgroundColor: colors.primary,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: colors.background,
    fontSize: 16,
    fontWeight: 'bold',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    marginHorizontal: 10,
    color: colors.textMuted,
    fontWeight: 'bold',
  },
  qrButton: {
    flexDirection: 'row',
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.primary,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 10,
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeScanner: {
    position: 'absolute',
    top: 50,
    right: 20,
  },
  scanTarget: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
  scanText: {
    color: '#fff',
    marginTop: 20,
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  versionText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 10,
    fontWeight: '500',
  },
});

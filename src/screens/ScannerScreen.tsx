import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Vibration, Image, StatusBar, ScrollView, Platform, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as NavigationBar from 'expo-navigation-bar';
import NetInfo from '@react-native-community/netinfo';
import { Audio } from 'expo-av';

import { validateCodeLocally, getUnsyncedLogs, markLogsAsSynced, updateCodesStatus, getDb } from '../services/database';
import { syncLogs, getDeltas, validateCodeOnline } from '../services/accessService';
import { colors } from '../theme/colors';
import { CheckCircle, XCircle, AlertTriangle, CloudOff, CloudUpload, Camera, ArrowLeft, RefreshCcw } from 'lucide-react-native';
import packageJson from '../../package.json';

const logo = require('../assets/logoBoletea.png');

export default function ScannerScreen({ navigation }: any) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [result, setResult] = useState<any>(null); 
  const [laserInput, setLaserInput] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  
  // Sync States
  const [eventId, setEventId] = useState<number | null>(null);
  const [allowedSections, setAllowedSections] = useState<string[] | null>(null);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnected, setIsConnected] = useState<boolean | null>(true);
  const [deviceIdentifier, setDeviceIdentifier] = useState('');
  
  const [isForcedOffline, setIsForcedOffline] = useState(false);
  const consecutiveNetworkFailures = useRef(0);
  const forcedOfflineTimer = useRef<NodeJS.Timeout | null>(null);
  const syncRetryAttempts = useRef(0);

  const inputRef = useRef<TextInput>(null);
  const isValidatingRef = useRef(false);

  useEffect(() => {
    const loadEvent = async () => {
      const eventStr = await AsyncStorage.getItem('selected_event');
      if (eventStr) {
        setEventId(JSON.parse(eventStr).id);
      }
      const sectionsStr = await AsyncStorage.getItem('allowed_sections');
      if (sectionsStr) {
        const parsed = JSON.parse(sectionsStr);
        setAllowedSections(Array.isArray(parsed) ? parsed : null);
      }
      const info = await AsyncStorage.getItem('device_info');
      if (info) {
        const parsed = JSON.parse(info);
        setDeviceIdentifier(parsed.device_identifier || parsed.name || 'Dispositivo');
      }
      refreshUnsyncedCount();
    };
    loadEvent();

    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected && state.isInternetReachable !== false);
      if (state.isConnected) {
        attemptAutoSync();
        attemptDeltaSync();
      }
    });

    const deltaInterval = setInterval(() => {
      attemptDeltaSync();
    }, 20000);

    return () => {
      unsubscribe();
      clearInterval(deltaInterval);
    };
  }, [eventId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (inputRef.current && !scanned) {
        inputRef.current.focus();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [scanned]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      const hideNavBar = async () => {
        try {
          await NavigationBar.setBehaviorAsync('overlay-swipe');
          await NavigationBar.setVisibilityAsync('hidden');
        } catch (e) {
          console.log('Error hiding navigation bar:', e);
        }
      };
      hideNavBar();
      
      const subscription = NavigationBar.addVisibilityListener(({ visibility }) => {
        if (visibility === 'visible') {
          setTimeout(() => {
            NavigationBar.setVisibilityAsync('hidden').catch(() => {});
          }, 1000);
        }
      });
      return () => subscription.remove();
    }
  }, []);

  const refreshUnsyncedCount = async () => {
    const logs = await getUnsyncedLogs();
    setUnsyncedCount(logs.length);
  };

  const attemptAutoSync = async () => {
    if (isSyncing || !eventId) return;

    const state = await NetInfo.fetch();
    if (!state.isConnected || state.isInternetReachable === false) return;

    const logs = await getUnsyncedLogs();
    if (logs.length === 0) {
      syncRetryAttempts.current = 0;
      return;
    }

    // Exponential backoff
    const baseDelay = 5000;
    const maxDelay = 60000;
    const currentAttempt = syncRetryAttempts.current;
    
    if (currentAttempt > 0) {
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, currentAttempt - 1));
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    setIsSyncing(true);
    try {
      const formattedLogs = logs.map((l) => ({
        code: l.code,
        scanned_at: l.scanned_at,
      }));

      await syncLogs(eventId, formattedLogs);
      
      const ids = logs.map(l => l.id);
      await markLogsAsSynced(ids);
      
      await refreshUnsyncedCount();
      syncRetryAttempts.current = 0;
    } catch (error) {
      console.log('Error auto-sync', error);
      syncRetryAttempts.current += 1;
    } finally {
      setIsSyncing(false);
    }
  };

  const attemptDeltaSync = async () => {
    if (!eventId) return;

    const state = await NetInfo.fetch();
    if (!state.isConnected || state.isInternetReachable === false) return;

    try {
      const lastSync = await AsyncStorage.getItem(`last_delta_sync_${eventId}`);
      const data = await getDeltas(eventId, lastSync);
      
      if (data.deltas && data.deltas.length > 0) {
        await updateCodesStatus(data.deltas);
      }
      
      if (data.server_time) {
        await AsyncStorage.setItem(`last_delta_sync_${eventId}`, data.server_time);
      }
    } catch (error) {
      console.log('Error delta sync', error);
    }
  };

  const playSound = async (soundType: 'success' | 'error' | 'warning') => {
    try {
      let soundAsset;
      if (soundType === 'success') {
        soundAsset = require('../assets/sounds/success.mp3');
      } else if (soundType === 'error') {
        soundAsset = require('../assets/sounds/error.mp3');
      } else {
        soundAsset = require('../assets/sounds/warning.mp3');
      }

      const { sound } = await Audio.Sound.createAsync(
        soundAsset,
        { shouldPlay: true }
      );
      
      setTimeout(() => {
        sound.unloadAsync().catch(() => {});
      }, 3000);
    } catch (error) {
      console.log('Error playing sound:', error);
    }
  };

  const handleProcessCode = async (rawCode: string) => {
    const code = rawCode.trim().replace(/[\r\n]/g, '');
    if (!code) return;
    if (scanned || isValidatingRef.current) return;
    isValidatingRef.current = true;
    setScanned(true);

    let validationResult;

    // 1. Pre-check local de sección (candado) y estado del boleto tanto online como offline
    const localDb = getDb();
    if (localDb) {
      try {
        const codeRow = await localDb.getFirstAsync<{ status: string, type: string, metadata: string }>(
          'SELECT status, type, metadata FROM codes WHERE code = ?',
          [code]
        );
        if (codeRow) {
          const metadata = JSON.parse(codeRow.metadata || '{}');
          const codeSection = metadata?.details ?? '';

          // A. Verificar candado de sección
          if (allowedSections && allowedSections.length > 0 && !allowedSections.includes(codeSection)) {
            await localDb.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [code, 'invalid_zone', new Date().toISOString()]);
            validationResult = {
              status: 'invalid_zone',
              message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('warning');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            return;
          }

          // B. Verificar si ya fue utilizado localmente (evita duplicar si está pendiente de subir)
          if (codeRow.status === 'used') {
            await localDb.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [code, 'duplicate', new Date().toISOString()]);
            validationResult = {
              status: 'duplicate',
              message: 'Código ya utilizado localmente.',
              type: codeRow.type,
              metadata: metadata
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('error');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            return;
          }

          // C. Verificar si está cancelado localmente
          if (codeRow.status === 'cancelled') {
            validationResult = {
              status: 'cancelled',
              message: 'Código cancelado en el sistema.',
              type: codeRow.type,
              metadata: metadata
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('error');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            return;
          }
        }
      } catch (dbError) {
        console.log('Error local pre-check:', dbError);
      }
    }

    if (isConnected && eventId && !isForcedOffline) {
        try {
            const response = await validateCodeOnline(eventId, code, new Date().toISOString());
            consecutiveNetworkFailures.current = 0; // Success resets counter
            
            // 2. Post-check online de sección (candado) con metadatos del servidor (por si no está en la DB local)
            if (response.status === 'success' && allowedSections && allowedSections.length > 0) {
              const metadata = response.metadata || {};
              const codeSection = metadata.details ?? '';
              if (!allowedSections.includes(codeSection)) {
                validationResult = {
                  status: 'invalid_zone',
                  message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
                };
                const localDb = getDb();
                if (localDb) {
                  await localDb.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [code, 'invalid_zone', new Date().toISOString()]);
                }
              } else {
                validationResult = response;
                await updateCodesStatus([{ code, status: 'used' }]);
              }
            } else {
              validationResult = response;
              if (validationResult.status === 'success') {
                await updateCodesStatus([{ code, status: 'used' }]);
              }
            }
        } catch (error: any) {
            console.log('Online validation error:', error.message);
            if (error.response && error.response.data && error.response.data.status) {
                consecutiveNetworkFailures.current = 0; // It was a valid server response, not a network failure
                validationResult = error.response.data;
                // Si el servidor responde duplicado o cancelado, también validamos sección si viene en la respuesta
                const metadata = validationResult.metadata || {};
                const codeSection = metadata.details ?? '';
                if (allowedSections && allowedSections.length > 0 && codeSection && !allowedSections.includes(codeSection)) {
                  validationResult = {
                    status: 'invalid_zone',
                    message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
                  };
                  const localDb = getDb();
                  if (localDb) {
                    await localDb.runAsync('INSERT INTO logs (code, result, scanned_at) VALUES (?, ?, ?)', [code, 'invalid_zone', new Date().toISOString()]);
                  }
                } else {
                  if (validationResult.status === 'duplicate') {
                      await updateCodesStatus([{ code, status: 'used' }]);
                  } else if (validationResult.status === 'cancelled') {
                      await updateCodesStatus([{ code, status: 'cancelled' }]);
                  }
                }
            } else {
                console.log('Connection error during online validation, falling back to local');
                consecutiveNetworkFailures.current += 1;
                
                if (consecutiveNetworkFailures.current >= 3 && !isForcedOffline) {
                    setIsForcedOffline(true);
                    if (forcedOfflineTimer.current) {
                        clearTimeout(forcedOfflineTimer.current);
                    }
                    forcedOfflineTimer.current = setTimeout(() => {
                        setIsForcedOffline(false);
                        consecutiveNetworkFailures.current = 0;
                    }, 5 * 60 * 1000); // 5 minutos
                }
                validationResult = await validateCodeLocally(code, allowedSections);
            }
        }
    } else {
        validationResult = await validateCodeLocally(code, allowedSections);
    }

    setResult(validationResult);
    
    if (validationResult.status === 'success') {
      Vibration.vibrate(100);
      playSound('success');
      setTimeout(() => {
        resetScanner();
      }, 1500);
    } else if (validationResult.status === 'invalid_zone') {
      Vibration.vibrate([0, 200, 100, 200]);
      playSound('warning');
    } else {
      Vibration.vibrate([0, 200, 100, 200]); 
      playSound('error');
    }

    setLaserInput('');
    if (inputRef.current) {
      inputRef.current.clear();
    }
    refreshUnsyncedCount();
    attemptAutoSync();
  };

  const handleInputChange = (text: string) => {
    if (scanned || isValidatingRef.current) {
      setLaserInput('');
      if (inputRef.current) {
        inputRef.current.clear();
      }
    } else {
      setLaserInput(text);
    }
  };

  const handleBarCodeScanned = ({ type, data }: any) => {
    handleProcessCode(data);
    setIsCameraActive(false); 
  };
  
  const handleLaserSubmit = () => {
    const raw = laserInput.trim();
    if (raw) {
      if (scanned || isValidatingRef.current) {
        resetScanner();
        handleProcessCode(raw);
      } else {
        handleProcessCode(raw);
      }
    }
  };

  const resetScanner = () => {
    isValidatingRef.current = false;
    setScanned(false);
    setResult(null);
    setLaserInput('');
    setIsCameraActive(false); 
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 100);
  };

  const renderResult = () => {
    if (scanned && !result) {
      return (
        <View style={[StyleSheet.absoluteFillObject, styles.resultOverlay, { backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: '#fff', marginTop: 15, fontSize: 18, fontWeight: 'bold' }}>Validando boleto...</Text>
        </View>
      );
    }

    if (!result) return null;

    let bgColor = colors.danger;
    let Icon = XCircle;
    let title = 'CÓDIGO INVÁLIDO';
    let instructions = 'Boleto falso o no registrado.';
    let highlightTitle = '';
    let highlightText = '';
    let highlightColor = '#fff';

    if (result.status === 'success') {
      bgColor = colors.success;
      Icon = CheckCircle;
      title = 'ACCESO PERMITIDO';
      instructions = 'Validación correcta en sistema.';
      highlightTitle = 'ACCIÓN REQUERIDA:';
      highlightText = 'PERMITIR INGRESO';
      highlightColor = '#a7f3d0'; // Light green
    } else if (result.status === 'duplicate') {
      bgColor = colors.warning;
      Icon = AlertTriangle;
      title = 'BOLETO YA USADO';
      instructions = 'Este código ya tiene un registro de entrada.';
      highlightTitle = 'ACCIÓN REQUERIDA:';
      highlightText = 'DENEGAR ACCESO';
      highlightColor = '#fecaca'; // Light red
    } else if (result.status === 'invalid_zone') {
      bgColor = '#7c3aed'; // Purple
      Icon = AlertTriangle;
      title = 'PUERTA EQUIVOCADA';
      
      let zonaTarget = 'OTRA PUERTA';
      if (result.message) {
        const match = result.message.match(/zona '([^']+)'/);
        if (match && match[1]) {
            zonaTarget = match[1].toUpperCase();
        }
      }
      
      instructions = 'Este boleto es válido, pero no en esta puerta.';
      highlightTitle = 'REDIRIGIR CLIENTE A ZONA:';
      highlightText = zonaTarget;
      highlightColor = '#fef08a'; // Bright yellow
    } else if (result.status === 'cancelled') {
      bgColor = '#6b7280'; // Gray
      Icon = XCircle;
      title = 'BOLETO CANCELADO';
      instructions = 'Este boleto fue reembolsado o anulado.';
      highlightTitle = 'ACCIÓN REQUERIDA:';
      highlightText = 'RETENER BOLETO';
      highlightColor = '#fecaca';
    }

    return (
      <View style={[StyleSheet.absoluteFillObject, styles.resultOverlay, { backgroundColor: bgColor }]}>
        <ScrollView 
          style={{ flex: 1, width: '100%' }}
          contentContainerStyle={[styles.resultScrollContent, { justifyContent: 'center' }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 12, padding: 20, margin: 15, alignItems: 'center', borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1 }}>
            <View style={{ alignItems: 'center', marginBottom: 10 }}>
                <Icon color="#fff" size={60} />
                <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', textAlign: 'center', marginTop: 10 }}>{title}</Text>
            </View>

            <View style={{ alignItems: 'center', width: '100%' }}>
                <Text style={{ color: '#fff', fontSize: 18, textAlign: 'center', marginBottom: 15 }}>{result.message || instructions}</Text>
                
                {highlightTitle ? (
                  <View style={{ backgroundColor: 'rgba(0,0,0,0.6)', padding: 15, borderRadius: 8, width: '100%', alignItems: 'center', marginBottom: 15 }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 5 }}>{highlightTitle}</Text>
                    <Text style={{ color: highlightColor, fontSize: 20, fontWeight: '900', textAlign: 'center' }}>{highlightText}</Text>
                  </View>
                ) : null}
                
                {result.duplicate_info ? (
                  <View style={{ backgroundColor: 'rgba(0,0,0,0.6)', padding: 15, borderRadius: 8, width: '100%', marginBottom: 15 }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' }}>ESTE BOLETO SE USÓ EN:</Text>
                    <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
                      Hora: {new Date(result.duplicate_info.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
                      Puerta: {result.duplicate_info.device_name}
                    </Text>
                  </View>
                ) : null}

                {result.metadata && result.metadata.owner ? (
                  <View style={{ backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8, width: '100%', marginBottom: 10 }}>
                    <Text style={{ color: '#aaa', fontSize: 12, textAlign: 'center', marginBottom: 2 }}>TITULAR DEL BOLETO</Text>
                    <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold', textAlign: 'center' }}>{result.metadata.owner}</Text>
                  </View>
                ) : null}

                {result.type ? (
                  <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingVertical: 5, paddingHorizontal: 15, borderRadius: 20, marginTop: 5 }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{result.type}</Text>
                  </View>
                ) : null}
            </View>
          </View>
        </ScrollView>
        
        {result.status !== 'success' ? (
          <View style={styles.resultFooter}>
            <TouchableOpacity style={styles.btnNext} onPress={resetScanner}>
                <RefreshCcw color="#fff" size={24} />
                <Text style={styles.btnNextText}>CONTINUAR ESCANEANDO</Text>
            </TouchableOpacity>
            <Text style={styles.triggerHint}>O presiona el gatillo del scanner</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      {isCameraActive ? (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8', 'upc_e'] }}
        />
      ) : (
        <TouchableOpacity 
            style={styles.idleContainer} 
            activeOpacity={1} 
            onPress={() => setIsCameraActive(true)}
        >
            <View style={styles.idleWrapper}>
                <Image source={logo} style={styles.idleLogo} resizeMode="contain" />
                <Text style={styles.tapPrompt}>Toca la pantalla para activar cámara</Text>
                <Text style={styles.idleVersion}>v{packageJson.version} {deviceIdentifier ? `| ID: ${deviceIdentifier}` : ''}</Text>
            </View>
        </TouchableOpacity>
      )}
      <TouchableOpacity 
        onPress={() => navigation.goBack()} 
        style={styles.backArrow}
      >
        <ArrowLeft color={isCameraActive ? "#fff" : colors.text} size={32} />
      </TouchableOpacity>
      
      {!result && (
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topBar}>
            <View style={{ width: 40 }} />
            {!isConnected || isForcedOffline ? (
              <View style={styles.offlineBadge}>
                <CloudOff color="#fff" size={16} />
                <Text style={styles.offlineBadgeText}>SIN INTERNET (MODO LOCAL)</Text>
              </View>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <View style={{ width: 40, alignItems: 'flex-end' }}>
              {isConnected && !isForcedOffline ? (
                <View style={styles.onlineDot} />
              ) : null}
            </View>
          </View>
          {isCameraActive ? (
            <View style={styles.scannerFrame} pointerEvents="none">
              <View style={styles.targetBox} />
            </View>
          ) : null}
          <View style={styles.bottomBar}>
            {unsyncedCount > 0 || isSyncing ? (
              <View style={styles.syncBadge}>
                <CloudUpload color={colors.warning} size={20} />
                <Text style={styles.syncBadgeText}>
                  {isSyncing ? 'Sincronizando...' : `${unsyncedCount} pendientes`}
                </Text>
              </View>
            ) : <View />}
          </View>
        </View>
      )}
      
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={laserInput}
        onChangeText={handleInputChange}
        onSubmitEditing={handleLaserSubmit}
        autoFocus
        showSoftInputOnFocus={false}
        blurOnSubmit={false}
      />
      {renderResult()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  idleContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  idleWrapper: { width: '100%', alignItems: 'center', justifyContent: 'center', gap: 15 },
  tapPrompt: { color: colors.textMuted, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  idleLogo: { width: '70%', height: 110 },
  idleVersion: { color: colors.textMuted, fontSize: 12, marginTop: 5, fontWeight: '500' },
  backArrow: { position: 'absolute', top: 50, left: 20, zIndex: 10, padding: 10 },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 20, alignItems: 'center' },
  scannerFrame: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  targetBox: { width: 250, height: 250, borderWidth: 2, borderColor: colors.primary, backgroundColor: 'transparent' },
  bottomBar: { padding: 30, alignItems: 'center', backgroundColor: 'transparent' },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  syncBadgeText: { color: colors.warning, fontWeight: 'bold', marginLeft: 8 },
  hiddenInput: { position: 'absolute', top: -100, left: -100, width: 1, height: 1, opacity: 0 },
  offlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e11d48',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    alignSelf: 'center',
  },
  offlineBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.success,
  },
  resultOverlay: { flex: 1, padding: 10, zIndex: 1000 },
  resultScrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 10 },
  resultHeader: { alignItems: 'center', marginBottom: 10 },
  resultTitle: { color: '#fff', fontSize: 20, fontWeight: '900', marginTop: 8, textAlign: 'center' },
  resultBody: { alignItems: 'center', marginBottom: 10, width: '100%' },
  resultMessage: { color: 'rgba(255,255,255,0.9)', fontSize: 14, textAlign: 'center', marginBottom: 8, fontWeight: '500' },
  actionBox: { backgroundColor: 'rgba(0,0,0,0.4)', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, width: '100%', alignItems: 'center', marginBottom: 8, borderWidth: 2, borderColor: 'rgba(255,255,255,0.1)' },
  actionLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 4 },
  actionText: { fontSize: 16, fontWeight: '900', textAlign: 'center', textTransform: 'uppercase' },
  duplicateBox: { backgroundColor: 'rgba(0,0,0,0.5)', padding: 8, borderRadius: 8, width: '100%', alignItems: 'center', marginBottom: 8 },
  duplicateLabel: { color: colors.warning, fontSize: 10, fontWeight: 'bold', marginBottom: 3, letterSpacing: 1 },
  duplicateText: { color: '#fff', fontSize: 12, fontWeight: '600', marginBottom: 1 },
  metaBox: { backgroundColor: 'rgba(255,255,255,0.2)', padding: 8, borderRadius: 8, width: '100%', alignItems: 'center', marginBottom: 8 },
  metaLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 'bold', marginBottom: 3 },
  resultMeta: { color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  typeBox: { backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  resultType: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  resultFooter: { alignItems: 'center', width: '100%', marginTop: 5 },
  btnNext: { 
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.25)', 
    paddingVertical: 14, 
    paddingHorizontal: 25,
    borderRadius: 50, 
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  btnNextText: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginLeft: 10 },
  triggerHint: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 10, fontStyle: 'italic' },
});

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Vibration,
  Image,
  StatusBar,
  ScrollView,
  Platform,
  ActivityIndicator,
  AppState,
  Keyboard,
  Modal,
  Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as NavigationBar from 'expo-navigation-bar';
import NetInfo from '@react-native-community/netinfo';
import { Audio } from 'expo-av';

import {
  validateCodeLocally,
  getUnsyncedLogs,
  markLogsAsSynced,
  updateCodesStatus,
  registerCodeLocally,
  getDb,
} from '../services/database';
import {
  syncLogs,
  getDeltas,
  validateCodeOnline,
  registerExternalCode,
} from '../services/accessService';
import { startForegroundService, stopForegroundService } from '../services/foregroundService';
import {
  startNfcReader,
  stopNfcReader,
  openNfcSettings,
  subscribeNfcTagScanned,
  subscribeNfcStatusChanged,
  NfcStatus,
} from '../services/nfcService';
import { colors } from '../theme/colors';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  CloudOff,
  CloudUpload,
  ArrowLeft,
  RefreshCcw,
  LogOut,
  LogIn,
  UserPlus,
  Accessibility,
  Nfc,
  X,
} from 'lucide-react-native';
import packageJson from '../../package.json';
import DataWedgeIntents from 'react-native-datawedge-intents';
import { DeviceEventEmitter } from 'react-native';

const logo = require('../assets/logoBoletea.png');

interface EventFeatures {
  allow_exit_reentry?: boolean;
  allow_external_code_registration?: boolean;
  allow_assisted_zone_override?: boolean;
  allow_nfc_access?: boolean;
}

export default function ScannerScreen({ navigation }: any) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [laserInput, setLaserInput] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);

  // Modo de operación: ENTRADA ('in') o SALIDA ('out')
  const [scanMode, setScanMode] = useState<'in' | 'out'>('in');
  const [lastScannedCode, setLastScannedCode] = useState<string>('');

  // Sync & Event States
  const [eventId, setEventId] = useState<number | null>(null);
  const [allowedSections, setAllowedSections] = useState<string[] | null>(null);
  const [eventFeatures, setEventFeatures] = useState<EventFeatures>({
    allow_exit_reentry: false,
    allow_external_code_registration: false,
    allow_assisted_zone_override: false,
    allow_nfc_access: false,
  });
  const [nfcStatus, setNfcStatus] = useState<NfcStatus>('unsupported');
  const lastNfcScanRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnected, setIsConnected] = useState<boolean | null>(true);
  const [deviceIdentifier, setDeviceIdentifier] = useState('');

  const [isForcedOffline, setIsForcedOffline] = useState(false);
  const consecutiveNetworkFailures = useRef(0);
  const forcedOfflineTimer = useRef<NodeJS.Timeout | null>(null);
  const syncRetryAttempts = useRef(0);

  // Modal para registro de código externo
  const [isExternalModalVisible, setIsExternalModalVisible] = useState(false);
  const [extCodeInput, setExtCodeInput] = useState('');
  const [extType, setExtType] = useState('Cortesía Externa');
  const [extZone, setExtZone] = useState('General');
  const [isSavingExternal, setIsSavingExternal] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const isValidatingRef = useRef(false);
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const loadEvent = async () => {
      const eventStr = await AsyncStorage.getItem('selected_event');
      if (eventStr) {
        const parsedEvent = JSON.parse(eventStr);
        setEventId(parsedEvent.id);
        if (parsedEvent.features) {
          setEventFeatures(parsedEvent.features);
        }
      }

      const featuresStr = await AsyncStorage.getItem('event_features');
      if (featuresStr) {
        try {
          const parsed = JSON.parse(featuresStr);
          setEventFeatures((prev) => ({ ...prev, ...parsed }));
        } catch (e) {
          console.log('Error parsing event_features:', e);
        }
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

    const unsubscribe = NetInfo.addEventListener((state) => {
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
    startForegroundService('Lector de boletos activo en segundo plano.');
    return () => {
      stopForegroundService();
    };
  }, []);

  useEffect(() => {
    // Foco constante en el TextInput para el hardware Zebra / DataWedge
    if (inputRef.current) {
      inputRef.current.focus();
    }

    const t1 = setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 100);

    const t2 = setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 300);

    const t3 = setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 600);

    const interval = setInterval(() => {
      if (inputRef.current && !isExternalModalVisible) {
        inputRef.current.focus();
      }
    }, 1000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearInterval(interval);
    };
  }, [isExternalModalVisible]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
      const t1 = setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 100);
      const t2 = setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 300);
      const t3 = setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 600);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    });

    return unsubscribe;
  }, [navigation]);

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

  // Bloqueo del teclado de pantalla para escáneres industriales Zebra
  useEffect(() => {
    if (!isExternalModalVisible) {
      Keyboard.dismiss();
    }

    const keyboardShowSubscription = Keyboard.addListener('keyboardDidShow', () => {
      if (!isExternalModalVisible) {
        Keyboard.dismiss();
      }
    });

    const handleAppStateChange = (nextAppState: string) => {
      if (nextAppState === 'active') {
        if (!isExternalModalVisible) {
          Keyboard.dismiss();
          setTimeout(() => {
            Keyboard.dismiss();
            if (inputRef.current) {
              inputRef.current.focus();
            }
          }, 100);
        }
      }
    };

    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      keyboardShowSubscription.remove();
      appStateSubscription.remove();
    };
  }, [isExternalModalVisible]);

  // Inicializar DataWedge
  useEffect(() => {
    DataWedgeIntents.registerReceiver('com.boletea.accessos.ACTION', '');
  }, []);

  // Escuchar Intents de DataWedge
  useEffect(() => {
    const scanSubscription = DeviceEventEmitter.addListener('datawedge_broadcast_intent', (intent) => {
      if (intent.hasOwnProperty('com.symbol.datawedge.data_string')) {
        const barcode = intent['com.symbol.datawedge.data_string'];
        if (barcode && !isValidatingRef.current) {
          if (isExternalModalVisible) {
            setExtCodeInput(barcode.trim());
          } else {
            handleProcessCode(barcode, scanMode);
          }
        }
      }
    });

    return () => {
      scanSubscription.remove();
    };
  }, [eventId, isConnected, isForcedOffline, allowedSections, scanMode, isExternalModalVisible]);

  // Inicializar y escuchar antena NFC (Zebra / Android) cuando el evento lo habilita
  useEffect(() => {
    if (!eventFeatures?.allow_nfc_access) {
      stopNfcReader();
      setNfcStatus('unsupported');
      return;
    }

    let isMounted = true;
    startNfcReader().then((status) => {
      if (isMounted) {
        setNfcStatus(status);
      }
    });

    const statusSub = subscribeNfcStatusChanged((status) => {
      if (isMounted) {
        setNfcStatus(status);
      }
    });

    const tagSub = subscribeNfcTagScanned((nfcEvent) => {
      const now = Date.now();
      const dedupKey = nfcEvent.uid || nfcEvent.code;
      if (
        lastNfcScanRef.current.key === dedupKey &&
        now - lastNfcScanRef.current.time < 2500
      ) {
        return;
      }
      lastNfcScanRef.current = { key: dedupKey, time: now };

      if (isExternalModalVisible) {
        setExtCodeInput(nfcEvent.code);
        Vibration.vibrate(60);
        return;
      }

      if (!isValidatingRef.current) {
        if (scanned || result) {
          resetScanner();
        }
        handleProcessCode(
          nfcEvent.code,
          scanMode,
          false,
          null,
          'nfc',
          nfcEvent.candidates
        );
      }
    });

    return () => {
      isMounted = false;
      statusSub.remove();
      tagSub.remove();
      stopNfcReader();
    };
  }, [
    eventFeatures?.allow_nfc_access,
    eventId,
    isConnected,
    isForcedOffline,
    allowedSections,
    scanMode,
    isExternalModalVisible,
    scanned,
    result,
  ]);

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

    const baseDelay = 5000;
    const maxDelay = 60000;
    const currentAttempt = syncRetryAttempts.current;

    if (currentAttempt > 0) {
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, currentAttempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    setIsSyncing(true);
    try {
      const formattedLogs = logs.map((l) => ({
        code: l.code,
        scanned_at: l.scanned_at,
        direction: l.direction || 'in',
        override_reason: l.override_reason || null,
      }));

      await syncLogs(eventId, formattedLogs);

      const ids = logs.map((l) => l.id);
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

      const { sound } = await Audio.Sound.createAsync(soundAsset, { shouldPlay: true });

      setTimeout(() => {
        sound.unloadAsync().catch(() => {});
      }, 3000);
    } catch (error) {
      console.log('Error playing sound:', error);
    }
  };

  const handleProcessCode = async (
    rawCode: string,
    currentDirection: 'in' | 'out' = scanMode,
    allowOverride: boolean = false,
    overrideReason: string | null = null,
    scanMethod: 'barcode' | 'nfc' | 'camera' = 'barcode',
    nfcCandidates: string[] = []
  ) => {
    let code = rawCode.trim().split(/[\r\n]+/)[0];
    if (!code) return;
    if (isValidatingRef.current) return;

    setLastScannedCode(code);

    if (scanned || result) {
      setResult(null);
    }

    setLaserInput('');
    if (inputRef.current) {
      inputRef.current.clear();
    }

    isValidatingRef.current = true;
    setScanned(true);

    try {
      DataWedgeIntents.sendBroadcastWithExtras({
        action: 'com.symbol.datawedge.api.ACTION',
        extras: {
          'com.symbol.datawedge.api.SCANNER_INPUT_PLUGIN': 'DISABLE_PLUGIN',
        },
      });
    } catch (err) {
      console.log('Error deshabilitando DataWedge', err);
    }

    let validationResult: any;

    // 1. Pre-check local offline
    const localDb = getDb();
    if (localDb && !allowOverride) {
      try {
        let codeRow = await localDb.getFirstAsync<{
          code: string;
          status: string;
          type: string;
          metadata: string;
          max_uses: number;
          scans_count: number;
          inside_count: number;
        }>(
          'SELECT code, status, type, metadata, max_uses, scans_count, inside_count FROM codes WHERE code = ?',
          [code]
        );

        if (!codeRow && scanMethod === 'nfc' && nfcCandidates.length > 0) {
          const placeholders = nfcCandidates.map(() => '?').join(',');
          codeRow = await localDb.getFirstAsync<{
            code: string;
            status: string;
            type: string;
            metadata: string;
            max_uses: number;
            scans_count: number;
            inside_count: number;
          }>(
            `SELECT code, status, type, metadata, max_uses, scans_count, inside_count FROM codes WHERE code IN (${placeholders}) LIMIT 1`,
            nfcCandidates
          );
          if (codeRow?.code) {
            code = codeRow.code;
            setLastScannedCode(code);
          }
        }

        if (codeRow) {
          const metadata = JSON.parse(codeRow.metadata || '{}');
          const codeSection = metadata?.details ?? '';
          const maxUses = codeRow.max_uses ?? 1;
          const currentScans = codeRow.scans_count ?? 0;
          const currentInside = codeRow.inside_count ?? (currentScans > 0 ? 1 : 0);

          // Si es salida y no está adentro
          if (currentDirection === 'out' && currentInside <= 0) {
            await localDb.runAsync(
              'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
              [code, 'cannot_exit_not_inside', new Date().toISOString(), 'out', null]
            );
            validationResult = {
              status: 'cannot_exit_not_inside',
              direction: 'out',
              message: 'No se puede dar salida: este boleto no ha registrado entrada previa.',
              type: codeRow.type,
              metadata,
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('error');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            isValidatingRef.current = false;
            return;
          }

          // Verificar candado de sección (si no hay override)
          if (
            allowedSections &&
            allowedSections.length > 0 &&
            codeSection &&
            !allowedSections.includes(codeSection)
          ) {
            await localDb.runAsync(
              'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
              [code, 'invalid_zone', new Date().toISOString(), currentDirection, null]
            );
            validationResult = {
              status: 'invalid_zone',
              direction: currentDirection,
              message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
              metadata,
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('warning');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            isValidatingRef.current = false;
            return;
          }

          // Si es entrada y ya agotó accesos
          if (currentDirection === 'in' && (currentScans >= maxUses || codeRow.status === 'used')) {
            await localDb.runAsync(
              'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
              [code, 'duplicate', new Date().toISOString(), 'in', null]
            );
            const duplicateMsg =
              maxUses > 1
                ? `Límite de accesos alcanzado localmente (${currentScans} de ${maxUses}).`
                : 'Código ya utilizado localmente.';
            validationResult = {
              status: 'duplicate',
              direction: 'in',
              message: duplicateMsg,
              scans_count: currentScans,
              max_uses: maxUses,
              type: codeRow.type,
              metadata,
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('error');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            isValidatingRef.current = false;
            return;
          }

          // Si está cancelado localmente
          if (codeRow.status === 'cancelled') {
            validationResult = {
              status: 'cancelled',
              message: 'Código cancelado en el sistema.',
              type: codeRow.type,
              metadata,
            };
            setResult(validationResult);
            Vibration.vibrate([0, 200, 100, 200]);
            playSound('error');
            setLaserInput('');
            refreshUnsyncedCount();
            attemptAutoSync();
            isValidatingRef.current = false;
            return;
          }
        }
      } catch (dbError) {
        console.log('Error local pre-check:', dbError);
      }
    }

    // 2. Validación Online u Offline
    if (isConnected && eventId && !isForcedOffline) {
      try {
        const response = await validateCodeOnline(
          eventId,
          code,
          new Date().toISOString(),
          currentDirection,
          allowOverride,
          overrideReason,
          scanMethod,
          nfcCandidates
        );
        consecutiveNetworkFailures.current = 0;
        const targetCode = response.matched_code || code;
        if (response.matched_code) {
          setLastScannedCode(response.matched_code);
        }

        // Post-check online de sección si no hubo override
        if (
          !allowOverride &&
          response.status === 'success' &&
          allowedSections &&
          allowedSections.length > 0
        ) {
          const metadata = response.metadata || {};
          const codeSection = metadata.details ?? '';
          if (codeSection && !allowedSections.includes(codeSection)) {
            validationResult = {
              status: 'invalid_zone',
              direction: currentDirection,
              message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
              metadata,
            };
            const ldb = getDb();
            if (ldb) {
              await ldb.runAsync(
                'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
                [targetCode, 'invalid_zone', new Date().toISOString(), currentDirection, overrideReason]
              );
            }
          } else {
            validationResult = response;
            const isFinal = response.remaining_scans === 0;
            await updateCodesStatus([
              {
                code: targetCode,
                status: isFinal ? 'used' : 'pending',
                scans_count: response.scans_count,
                inside_count: response.inside_count,
                max_uses: response.max_uses,
              },
            ]);
          }
        } else {
          validationResult = response;
          if (validationResult.status === 'success') {
            const isFinal = response.remaining_scans === 0;
            await updateCodesStatus([
              {
                code: targetCode,
                status: isFinal ? 'used' : 'pending',
                scans_count: response.scans_count,
                inside_count: response.inside_count,
                max_uses: response.max_uses,
              },
            ]);
          }
        }
      } catch (error: any) {
        console.log('Online validation error:', error.message);
        if (error.response && error.response.data && error.response.data.status) {
          consecutiveNetworkFailures.current = 0;
          validationResult = error.response.data;
          const errTargetCode = validationResult.matched_code || code;

          const metadata = validationResult.metadata || {};
          const codeSection = metadata.details ?? '';
          if (
            !allowOverride &&
            allowedSections &&
            allowedSections.length > 0 &&
            codeSection &&
            !allowedSections.includes(codeSection)
          ) {
            validationResult = {
              status: 'invalid_zone',
              direction: currentDirection,
              message: `Acceso denegado. Este código pertenece a la zona '${codeSection}', la cual no está habilitada para esta puerta.`,
              metadata,
            };
            const ldb = getDb();
            if (ldb) {
              await ldb.runAsync(
                'INSERT INTO logs (code, result, scanned_at, direction, override_reason) VALUES (?, ?, ?, ?, ?)',
                [errTargetCode, 'invalid_zone', new Date().toISOString(), currentDirection, overrideReason]
              );
            }
          } else {
            if (validationResult.status === 'duplicate') {
              await updateCodesStatus([
                {
                  code: errTargetCode,
                  status: 'used',
                  scans_count: validationResult.scans_count,
                  inside_count: validationResult.inside_count,
                  max_uses: validationResult.max_uses,
                },
              ]);
            } else if (validationResult.status === 'cancelled') {
              await updateCodesStatus([{ code: errTargetCode, status: 'cancelled' }]);
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
            }, 5 * 60 * 1000);
          }
          validationResult = await validateCodeLocally(
            code,
            allowOverride ? null : allowedSections,
            currentDirection,
            overrideReason,
            scanMethod === 'nfc' ? nfcCandidates : []
          );
          if (validationResult?.matched_code) {
            setLastScannedCode(validationResult.matched_code);
          }
        }
      }
    } else {
      validationResult = await validateCodeLocally(
        code,
        allowOverride ? null : allowedSections,
        currentDirection,
        overrideReason,
        scanMethod === 'nfc' ? nfcCandidates : []
      );
      if (validationResult?.matched_code) {
        setLastScannedCode(validationResult.matched_code);
      }
    }

    if (validationResult) {
      validationResult.scan_method = scanMethod;
    }

    setResult(validationResult);
    isValidatingRef.current = false;

    if (validationResult.status === 'success') {
      Vibration.vibrate(100);
      playSound('success');

      // Auto-reinicio de seguridad al modo ENTRADA después de un escaneo de salida exitoso
      if (currentDirection === 'out') {
        setScanMode('in');
      }

      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = setTimeout(() => {
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
    if (isValidatingRef.current) {
      setLaserInput('');
      if (inputRef.current) {
        inputRef.current.clear();
      }
      return;
    }

    if (result) {
      resetScanner(true);
    }
    setLaserInput(text);
  };

  const handleBarCodeScanned = ({ type, data }: any) => {
    handleProcessCode(data, scanMode, false, null, 'camera');
    setIsCameraActive(false);
  };

  const handleLaserSubmit = (e: any) => {
    const raw = e.nativeEvent.text.trim();
    if (raw) {
      if (isValidatingRef.current) {
        setLaserInput('');
        if (inputRef.current) {
          inputRef.current.clear();
        }
        return;
      }

      setLaserInput('');
      if (inputRef.current) {
        inputRef.current.clear();
      }

      if (scanned || result) {
        resetScanner();
        handleProcessCode(raw, scanMode);
      } else {
        handleProcessCode(raw, scanMode);
      }
    }
  };

  const resetScanner = (keepInput = false) => {
    isValidatingRef.current = false;
    setScanned(false);
    setResult(null);
    if (!keepInput) {
      setLaserInput('');
      if (inputRef.current) {
        inputRef.current.clear();
      }
    }
    setIsCameraActive(false);

    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }

    try {
      DataWedgeIntents.sendBroadcastWithExtras({
        action: 'com.symbol.datawedge.api.ACTION',
        extras: {
          'com.symbol.datawedge.api.SCANNER_INPUT_PLUGIN': 'ENABLE_PLUGIN',
        },
      });
    } catch (err) {
      console.log('Error habilitando DataWedge', err);
    }

    setTimeout(() => {
      if (inputRef.current && !isExternalModalVisible) inputRef.current.focus();
    }, 100);
  };

  // Reubicación asistida para silla de ruedas
  const handleWheelchairOverride = () => {
    if (!lastScannedCode) return;
    resetScanner();
    handleProcessCode(lastScannedCode, 'in', true, 'wheelchair_assisted_access');
  };

  // Guardar código externo al vuelo
  const handleSaveExternalCode = async (autoCheckin: boolean) => {
    const codeToRegister = extCodeInput.trim();
    if (!codeToRegister) {
      Alert.alert('Código Requerido', 'Por favor ingresa o escanea el código del boleto.');
      return;
    }

    setIsSavingExternal(true);
    try {
      if (isConnected && eventId && !isForcedOffline) {
        try {
          const resp = await registerExternalCode({
            event_id: eventId,
            code: codeToRegister,
            type: extType,
            details: extZone,
            max_uses: 1,
            auto_checkin: autoCheckin,
          });

          // Registrar también en DB SQLite local
          await registerCodeLocally({
            code: codeToRegister,
            type: extType,
            details: extZone,
            max_uses: 1,
            is_external: true,
            auto_checkin: false,
          });

          if (autoCheckin) {
            await updateCodesStatus([
              {
                code: codeToRegister,
                status: 'used',
                scans_count: 1,
                inside_count: 1,
                max_uses: 1,
              },
            ]);
          }

          setIsExternalModalVisible(false);
          setExtCodeInput('');
          resetScanner();

          if (autoCheckin) {
            setResult({
              status: 'success',
              direction: 'in',
              message: `Boleto externo registrado y acceso concedido: ${codeToRegister}`,
              type: extType,
              metadata: { details: extZone },
              scans_count: 1,
              max_uses: 1,
              remaining_scans: 0,
            });
            playSound('success');
            Vibration.vibrate(100);
          } else {
            Alert.alert('Éxito', `Código ${codeToRegister} registrado correctamente en el servidor.`);
          }
          return;
        } catch (netErr: any) {
          console.log('Fallo registro online de código externo, registrando en SQLite local:', netErr);
        }
      }

      // Registro Offline en SQLite
      const localResult = await registerCodeLocally({
        code: codeToRegister,
        type: extType,
        details: extZone,
        max_uses: 1,
        is_external: true,
        auto_checkin: autoCheckin,
        allowedSections,
      });

      setIsExternalModalVisible(false);
      setExtCodeInput('');
      resetScanner();

      if (autoCheckin) {
        setResult(localResult);
        if (localResult.status === 'success') {
          playSound('success');
          Vibration.vibrate(100);
        } else {
          playSound('error');
          Vibration.vibrate([0, 200, 100, 200]);
        }
      } else {
        Alert.alert(
          'Registro Local (Offline)',
          `Código ${codeToRegister} guardado en la base de datos local del escáner.`
        );
      }
      refreshUnsyncedCount();
      attemptAutoSync();
    } catch (e: any) {
      console.log('Error registering external code:', e);
      Alert.alert('Error', `No se pudo registrar el código: ${e.message}`);
    } finally {
      setIsSavingExternal(false);
    }
  };

  const renderResult = () => {
    if (scanned && !result) {
      return (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            styles.resultOverlay,
            { backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
          ]}
        >
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: '#fff', marginTop: 15, fontSize: 18, fontWeight: 'bold' }}>
            Validando boleto...
          </Text>
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
      if (result.direction === 'out') {
        bgColor = '#ea580c'; // Naranja brillante para salida
        Icon = LogOut;
        title = 'SALIDA AUTORIZADA';
        instructions = 'Salida temporal registrada con éxito. Puede reingresar.';
        highlightTitle = 'ACCIÓN REQUERIDA:';
        highlightText = 'PERMITIR SALIDA';
        highlightColor = '#fed7aa';
      } else {
        bgColor = colors.success;
        Icon = CheckCircle;
        const maxUses = result.max_uses || 1;
        const scansCount = result.scans_count || 1;

        if (result.override_reason === 'wheelchair_assisted_access') {
          title = 'REUBICACIÓN ASISTIDA';
          instructions = 'Bypass autorizado para persona con silla de ruedas / asistencia.';
          highlightTitle = 'AUTORIZADO POR:';
          highlightText = 'OPERADOR DE PUERTA';
          highlightColor = '#bfdbfe';
        } else if (maxUses > 1) {
          title = `ACCESO ${scansCount} DE ${maxUses}`;
          const remaining =
            result.remaining_scans !== undefined
              ? result.remaining_scans
              : Math.max(0, maxUses - scansCount);
          instructions =
            remaining === 0
              ? '¡ÚLTIMO ACCESO DISPONIBLE CONSUMIDO!'
              : `Boleto multi-acceso: Quedan ${remaining} acceso(s) disponible(s).`;
        } else {
          title = 'ACCESO PERMITIDO';
          instructions = 'Validación correcta en sistema.';
        }
        highlightTitle = 'ACCIÓN REQUERIDA:';
        highlightText = 'PERMITIR INGRESO';
        highlightColor = '#a7f3d0';
      }
    } else if (result.status === 'cannot_exit_not_inside') {
      bgColor = '#dc2626';
      Icon = AlertTriangle;
      title = 'NO PUEDE SALIR';
      instructions = 'Este boleto no tiene ningún registro de entrada activa adentro del recinto.';
      highlightTitle = 'ACCIÓN REQUERIDA:';
      highlightText = 'DENEGAR SALIDA';
      highlightColor = '#fecaca';
    } else if (result.status === 'duplicate') {
      bgColor = colors.warning;
      Icon = AlertTriangle;
      const maxUses = result.max_uses || 1;
      if (maxUses > 1) {
        title = 'LÍMITE ALCANZADO';
        instructions = `Este código ya consumió sus ${maxUses} accesos permitidos.`;
      } else {
        title = 'BOLETO YA USADO';
        instructions = 'Este código ya tiene un registro de entrada.';
      }
      highlightTitle = 'ACCIÓN REQUERIDA:';
      highlightText = 'DENEGAR ACCESO';
      highlightColor = '#fecaca';
    } else if (result.status === 'invalid_zone') {
      bgColor = '#7c3aed';
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
      highlightColor = '#fef08a';
    } else if (result.status === 'cancelled') {
      bgColor = '#6b7280';
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
          <View
            style={{
              backgroundColor: 'rgba(0,0,0,0.4)',
              borderRadius: 12,
              padding: 20,
              margin: 15,
              alignItems: 'center',
              borderColor: 'rgba(255,255,255,0.2)',
              borderWidth: 1,
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 10 }}>
              <Icon color="#fff" size={60} />
              <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', textAlign: 'center', marginTop: 10 }}>
                {title}
              </Text>
            </View>

            <View style={{ alignItems: 'center', width: '100%' }}>
              <Text style={{ color: '#fff', fontSize: 18, textAlign: 'center', marginBottom: 15 }}>
                {result.message || instructions}
              </Text>

              {result.max_uses && result.max_uses > 1 ? (
                <View
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.25)',
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    borderRadius: 12,
                    marginBottom: 15,
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.4)',
                    width: '100%',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900', textAlign: 'center' }}>
                    PASE MULTI-ACCESO ({result.scans_count || 1} / {result.max_uses})
                  </Text>
                </View>
              ) : null}

              {highlightTitle ? (
                <View
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    padding: 15,
                    borderRadius: 8,
                    width: '100%',
                    alignItems: 'center',
                    marginBottom: 15,
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 5 }}>
                    {highlightTitle}
                  </Text>
                  <Text style={{ color: highlightColor, fontSize: 20, fontWeight: '900', textAlign: 'center' }}>
                    {highlightText}
                  </Text>
                </View>
              ) : null}

              {/* Botón de Reubicación Asistida para Silla de Ruedas cuando es invalid_zone */}
              {result.status === 'invalid_zone' && eventFeatures?.allow_assisted_zone_override ? (
                <TouchableOpacity
                  style={styles.wheelchairButton}
                  onPress={handleWheelchairOverride}
                  activeOpacity={0.8}
                >
                  <Accessibility color="#fff" size={24} />
                  <Text style={styles.wheelchairButtonText}>♿ Autorizar Silla de Ruedas / Asistencia</Text>
                </TouchableOpacity>
              ) : null}

              {result.duplicate_info ? (
                <View
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    padding: 15,
                    borderRadius: 8,
                    width: '100%',
                    marginBottom: 15,
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' }}>
                    ESTE BOLETO SE USÓ EN:
                  </Text>
                  <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
                    Hora:{' '}
                    {new Date(result.duplicate_info.scanned_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                  <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
                    Puerta: {result.duplicate_info.device_name}
                  </Text>
                </View>
              ) : null}

              {result.metadata && result.metadata.owner ? (
                <View
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    padding: 10,
                    borderRadius: 8,
                    width: '100%',
                    marginBottom: 10,
                  }}
                >
                  <Text style={{ color: '#aaa', fontSize: 12, textAlign: 'center', marginBottom: 2 }}>
                    TITULAR DEL BOLETO
                  </Text>
                  <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold', textAlign: 'center' }}>
                    {result.metadata.owner}
                  </Text>
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 5 }}>
                {result.type ? (
                  <View
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.2)',
                      paddingVertical: 5,
                      paddingHorizontal: 15,
                      borderRadius: 20,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{result.type}</Text>
                  </View>
                ) : null}
                {result.scan_method === 'nfc' ? (
                  <View
                    style={{
                      backgroundColor: 'rgba(16,185,129,0.35)',
                      paddingVertical: 5,
                      paddingHorizontal: 12,
                      borderRadius: 20,
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.45)',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Nfc color="#fff" size={14} />
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>NFC</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        </ScrollView>

        {result.status !== 'success' ? (
          <View style={styles.resultFooter}>
            <TouchableOpacity style={styles.btnNext} onPress={() => resetScanner()}>
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
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8', 'upc_e'],
          }}
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
            {eventFeatures?.allow_nfc_access && nfcStatus === 'enabled' ? (
              <View style={styles.idleNfcHint}>
                <Nfc color="#10b981" size={16} />
                <Text style={styles.idleNfcHintText}>
                  Acerca pulsera/tarjeta NFC o dispara el láser
                </Text>
              </View>
            ) : null}
            <Text style={styles.idleVersion}>
              v{packageJson.version} {deviceIdentifier ? `| ID: ${deviceIdentifier}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Flecha para regresar */}
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backArrow}>
        <ArrowLeft color={isCameraActive ? '#fff' : colors.text} size={32} />
      </TouchableOpacity>

      {/* Barra de Modo ENTRADA / SALIDA (Visible solo si allow_exit_reentry es true) */}
      {eventFeatures?.allow_exit_reentry ? (
        <View style={styles.modeSwitchContainer}>
          <TouchableOpacity
            style={[
              styles.modeTab,
              scanMode === 'in' ? styles.modeTabActiveIn : styles.modeTabInactive,
            ]}
            onPress={() => setScanMode('in')}
            activeOpacity={0.8}
          >
            <LogIn color={scanMode === 'in' ? '#fff' : colors.textMuted} size={18} />
            <Text
              style={[
                styles.modeTabText,
                scanMode === 'in' ? styles.modeTabTextActive : styles.modeTabTextInactive,
              ]}
            >
              ENTRADA
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.modeTab,
              scanMode === 'out' ? styles.modeTabActiveOut : styles.modeTabInactive,
            ]}
            onPress={() => setScanMode('out')}
            activeOpacity={0.8}
          >
            <LogOut color={scanMode === 'out' ? '#fff' : colors.textMuted} size={18} />
            <Text
              style={[
                styles.modeTabText,
                scanMode === 'out' ? styles.modeTabTextActive : styles.modeTabTextInactive,
              ]}
            >
              SALIDA
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Botón flotante para Registro de Código Externo al vuelo */}
      {eventFeatures?.allow_external_code_registration && !result ? (
        <TouchableOpacity
          style={styles.btnExternalFloating}
          onPress={() => setIsExternalModalVisible(true)}
          activeOpacity={0.85}
        >
          <UserPlus color="#fff" size={20} />
          <Text style={styles.btnExternalFloatingText}>+ Cód. Externo</Text>
        </TouchableOpacity>
      ) : null}

      {!result && (
        <View style={styles.overlay} pointerEvents="box-none">
          <View pointerEvents="box-none">
            <View style={styles.topBar} pointerEvents="box-none">
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
                {isConnected && !isForcedOffline ? <View style={styles.onlineDot} /> : null}
              </View>
            </View>

            {eventFeatures?.allow_nfc_access && nfcStatus !== 'unsupported' ? (
              <View
                style={[
                  styles.nfcStatusRow,
                  eventFeatures?.allow_exit_reentry ? { marginTop: 36 } : { marginTop: 8 },
                ]}
                pointerEvents="box-none"
              >
                {nfcStatus === 'enabled' ? (
                  <View style={styles.nfcBadgeEnabled}>
                    <Nfc color="#10b981" size={15} />
                    <Text style={styles.nfcBadgeEnabledText}>NFC ACTIVO</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.nfcBadgeDisabled}
                    onPress={openNfcSettings}
                    activeOpacity={0.85}
                  >
                    <Nfc color="#fff" size={15} />
                    <Text style={styles.nfcBadgeDisabledText}>NFC APAGADO · Toca para activar</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : null}
          </View>
          {isCameraActive ? (
            <View style={styles.scannerFrame} pointerEvents="none">
              <View
                style={[
                  styles.targetBox,
                  scanMode === 'out' ? { borderColor: '#ea580c' } : { borderColor: colors.primary },
                ]}
              />
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
            ) : (
              <View />
            )}
          </View>
        </View>
      )}

      {/* Input invisible para hardware Zebra */}
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={laserInput}
        onChangeText={handleInputChange}
        onSubmitEditing={handleLaserSubmit}
        editable={!isExternalModalVisible}
        autoFocus
        showSoftInputOnFocus={false}
        blurOnSubmit={false}
        selectTextOnFocus={true}
      />

      {renderResult()}

      {/* Modal de Registro de Código Externo */}
      <Modal
        visible={isExternalModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setIsExternalModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <UserPlus color={colors.primary} size={24} />
                <Text style={styles.modalTitle}>Registrar Código Externo</Text>
              </View>
              <TouchableOpacity onPress={() => setIsExternalModalVisible(false)}>
                <X color={colors.text} size={24} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              {eventFeatures?.allow_nfc_access
                ? 'Escanea con láser, acerca la pulsera/tarjeta NFC o ingresa el código para autorizar su ingreso.'
                : 'Escanea o ingresa el boleto de otro sistema para autorizar su ingreso al recinto.'}
            </Text>

            <Text style={styles.label}>Código de Boleto / Barra:</Text>
            <TextInput
              style={styles.textInput}
              value={extCodeInput}
              onChangeText={setExtCodeInput}
              placeholder="Ej. EXT-123456 o escanear"
              placeholderTextColor="#94a3b8"
              autoCapitalize="characters"
              autoFocus
            />

            <Text style={styles.label}>Tipo de Cortesía / Pase:</Text>
            <View style={styles.typeSelector}>
              {['Cortesía Externa', 'Silla de Ruedas', 'Otro Sistema'].map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeButton, extType === t && styles.typeButtonSelected]}
                  onPress={() => setExtType(t)}
                >
                  <Text style={[styles.typeButtonText, extType === t && styles.typeButtonTextSelected]}>
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Zona / Sección Asignada:</Text>
            <View style={styles.typeSelector}>
              {['General', 'VIP', 'Gradas', 'Ruedo'].map((z) => (
                <TouchableOpacity
                  key={z}
                  style={[styles.typeButton, extZone === z && styles.typeButtonSelected]}
                  onPress={() => setExtZone(z)}
                >
                  <Text style={[styles.typeButtonText, extZone === z && styles.typeButtonTextSelected]}>
                    {z}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnActionSecondary, isSavingExternal && { opacity: 0.6 }]}
                onPress={() => handleSaveExternalCode(false)}
                disabled={isSavingExternal}
              >
                <Text style={styles.btnActionSecondaryText}>Solo Guardar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btnActionPrimary, isSavingExternal && { opacity: 0.6 }]}
                onPress={() => handleSaveExternalCode(true)}
                disabled={isSavingExternal}
              >
                {isSavingExternal ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.btnActionPrimaryText}>Guardar y Dar Entrada</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  idleContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  idleWrapper: { width: '100%', alignItems: 'center', justifyContent: 'center', gap: 15 },
  tapPrompt: { color: colors.textMuted, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  idleNfcHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  idleNfcHintText: {
    color: '#059669',
    fontSize: 13,
    fontWeight: '700',
  },
  nfcStatusRow: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 25,
  },
  nfcBadgeEnabled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  nfcBadgeEnabledText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  nfcBadgeDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#d97706',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    elevation: 4,
  },
  nfcBadgeDisabledText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  idleLogo: { width: '70%', height: 110 },
  idleVersion: { color: colors.textMuted, fontSize: 12, marginTop: 5, fontWeight: '500' },
  backArrow: { position: 'absolute', top: 50, left: 20, zIndex: 10, padding: 10 },

  // Barra de Switch ENTRADA / SALIDA
  modeSwitchContainer: {
    position: 'absolute',
    top: 50,
    alignSelf: 'center',
    zIndex: 20,
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 24,
    padding: 4,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  modeTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    gap: 6,
  },
  modeTabInactive: {
    backgroundColor: 'transparent',
  },
  modeTabActiveIn: {
    backgroundColor: colors.primary, // Rojo Boletea #c90000
  },
  modeTabActiveOut: {
    backgroundColor: '#ea580c', // Ámbar / Naranja de alerta para salida
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  modeTabTextActive: {
    color: '#fff',
  },
  modeTabTextInactive: {
    color: '#94a3b8',
  },

  // Botón flotante Código Externo
  btnExternalFloating: {
    position: 'absolute',
    bottom: 30,
    right: 20,
    zIndex: 30,
    backgroundColor: '#0f172a',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 30,
    borderWidth: 1.5,
    borderColor: colors.primary,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  btnExternalFloatingText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },

  // Reubicación asistida para Silla de Ruedas
  wheelchairButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0284c7', // Azul brillante de accesibilidad
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginTop: 10,
    marginBottom: 15,
    width: '100%',
    elevation: 3,
  },
  wheelchairButtonText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 15,
    textAlign: 'center',
  },

  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  scannerFrame: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  targetBox: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
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
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -9999,
  },
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
  resultScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingVertical: 10,
  },
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
  triggerHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 10,
    fontStyle: 'italic',
  },

  // Estilos del Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.text,
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
    marginTop: 8,
  },
  textInput: {
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  typeSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  typeButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f1f5f9',
  },
  typeButtonSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  typeButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  typeButtonTextSelected: {
    color: '#fff',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
  },
  btnActionSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  btnActionSecondaryText: {
    color: '#475569',
    fontWeight: 'bold',
    fontSize: 14,
  },
  btnActionPrimary: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 140,
  },
  btnActionPrimaryText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
});

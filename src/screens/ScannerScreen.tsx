import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Vibration, Image, StatusBar } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

import { validateCodeLocally, getUnsyncedLogs, markLogsAsSynced, updateCodesStatus } from '../services/database';
import { syncLogs, getDeltas, validateCodeOnline } from '../services/accessService';
import { colors } from '../theme/colors';
import { CheckCircle, XCircle, AlertTriangle, CloudOff, CloudUpload, Camera, ArrowLeft, RefreshCcw } from 'lucide-react-native';

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

  const inputRef = useRef<TextInput>(null);

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

  const refreshUnsyncedCount = async () => {
    const logs = await getUnsyncedLogs();
    setUnsyncedCount(logs.length);
  };

  const attemptAutoSync = async () => {
    if (isSyncing || !eventId) return;

    const state = await NetInfo.fetch();
    if (!state.isConnected || state.isInternetReachable === false) return;

    const logs = await getUnsyncedLogs();
    if (logs.length === 0) return;

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
    } catch (error) {
      console.log('Error auto-sync', error);
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

  const handleProcessCode = async (code: string) => {
    if (scanned) return;
    setScanned(true);

    let validationResult;

    if (isConnected && eventId) {
        try {
            const response = await validateCodeOnline(eventId, code, new Date().toISOString());
            
            validationResult = response;
            if (validationResult.status === 'success') {
                await updateCodesStatus([{ code, status: 'used' }]);
            }
        } catch (error: any) {
            console.log('Online validation error:', error.message);
            if (error.response && error.response.data && error.response.data.status) {
                validationResult = error.response.data;
                if (validationResult.status === 'duplicate') {
                    await updateCodesStatus([{ code, status: 'used' }]);
                } else if (validationResult.status === 'cancelled') {
                    await updateCodesStatus([{ code, status: 'cancelled' }]);
                }
            } else {
                console.log('Connection error during online validation, falling back to local');
                validationResult = await validateCodeLocally(code, allowedSections);
            }
        }
    } else {
        validationResult = await validateCodeLocally(code, allowedSections);
    }

    setResult(validationResult);
    
    if (validationResult.status === 'success') {
      Vibration.vibrate(100);
      setTimeout(() => {
        resetScanner();
      }, 800);
    } else {
      Vibration.vibrate([0, 200, 100, 200]); 
    }

    setLaserInput('');
    refreshUnsyncedCount();
    attemptAutoSync();
  };

  const handleBarCodeScanned = ({ type, data }: any) => {
    handleProcessCode(data);
    setIsCameraActive(false); 
  };
  
  const handleLaserSubmit = () => { if (laserInput.trim()) handleProcessCode(laserInput.trim()); };

  const resetScanner = () => {
    setScanned(false);
    setResult(null);
    setLaserInput('');
    setIsCameraActive(false); 
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 100);
  };

  const renderResult = () => {
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
        <View style={styles.resultHeader}>
            <Icon color="#fff" size={120} />
            <Text style={styles.resultTitle}>{title}</Text>
        </View>

        <View style={styles.resultBody}>
            <Text style={styles.resultMessage}>{instructions}</Text>
            
            {highlightTitle ? (
              <View style={styles.actionBox}>
                <Text style={styles.actionLabel}>{highlightTitle}</Text>
                <Text style={[styles.actionText, { color: highlightColor }]}>{highlightText}</Text>
              </View>
            ) : null}
            
            {result.duplicate_info ? (
              <View style={styles.duplicateBox}>
                <Text style={styles.duplicateLabel}>ESTE BOLETO SE USÓ EN:</Text>
                <Text style={styles.duplicateText}>
                  Hora: {new Date(result.duplicate_info.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <Text style={styles.duplicateText}>
                  Puerta: {result.duplicate_info.device_name}
                </Text>
              </View>
            ) : null}

            {result.metadata && result.metadata.owner ? (
              <View style={styles.metaBox}>
                <Text style={styles.metaLabel}>TITULAR DEL BOLETO</Text>
                <Text style={styles.resultMeta}>{result.metadata.owner}</Text>
              </View>
            ) : null}

            {result.type ? (
              <View style={styles.typeBox}>
                <Text style={styles.resultType}>{result.type}</Text>
              </View>
            ) : null}
        </View>
        
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
            <View style={styles.instructionContainer}>
                <Text style={styles.tapPrompt}>Toca la pantalla para activar cámara</Text>
            </View>
            <View style={styles.logoCenter}>
                <Image source={logo} style={styles.idleLogo} resizeMode="contain" />
            </View>
        </TouchableOpacity>
      )}
      <TouchableOpacity 
        onPress={() => navigation.goBack()} 
        style={styles.backArrow}
      >
        <ArrowLeft color={isCameraActive ? "#fff" : colors.text} size={32} />
      </TouchableOpacity>
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <View style={{ width: 40 }} />
          <View style={{ flex: 1 }} />
          <View style={{ width: 40, alignItems: 'flex-end' }}>
            {!isConnected ? <CloudOff color={colors.danger} size={24} /> : null}
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
          ) : null}
        </View>
      </View>
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={laserInput}
        onChangeText={setLaserInput}
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
  idleContainer: { flex: 1, backgroundColor: colors.background },
  instructionContainer: { position: 'absolute', top: 120, left: 0, right: 0, alignItems: 'center' },
  tapPrompt: { color: colors.textMuted, fontSize: 18, fontWeight: '600' },
  logoCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  idleLogo: { width: '80%', height: 200 },
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
  resultOverlay: { flex: 1, padding: 30, zIndex: 1000, justifyContent: 'center' },
  resultHeader: { alignItems: 'center', marginBottom: 30 },
  resultTitle: { color: '#fff', fontSize: 36, fontWeight: '900', marginTop: 15, textAlign: 'center' },
  resultBody: { alignItems: 'center', marginBottom: 40 },
  resultMessage: { color: 'rgba(255,255,255,0.9)', fontSize: 18, textAlign: 'center', marginBottom: 15, fontWeight: '500' },
  actionBox: { backgroundColor: 'rgba(0,0,0,0.4)', paddingVertical: 20, paddingHorizontal: 15, borderRadius: 16, width: '100%', alignItems: 'center', marginBottom: 20, borderWidth: 2, borderColor: 'rgba(255,255,255,0.1)' },
  actionLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8 },
  actionText: { fontSize: 28, fontWeight: '900', textAlign: 'center', textTransform: 'uppercase' },
  duplicateBox: { backgroundColor: 'rgba(0,0,0,0.5)', padding: 15, borderRadius: 12, width: '100%', alignItems: 'center', marginBottom: 15 },
  duplicateLabel: { color: colors.warning, fontSize: 12, fontWeight: 'bold', marginBottom: 5, letterSpacing: 1 },
  duplicateText: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 2 },
  metaBox: { backgroundColor: 'rgba(255,255,255,0.2)', padding: 15, borderRadius: 12, width: '100%', alignItems: 'center', marginBottom: 15 },
  metaLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 'bold', marginBottom: 5 },
  resultMeta: { color: '#fff', fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  typeBox: { backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 30 },
  resultType: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  resultFooter: { alignItems: 'center', width: '100%' },
  btnNext: { 
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.25)', 
    paddingVertical: 18, 
    paddingHorizontal: 30,
    borderRadius: 50, 
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  btnNextText: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginLeft: 10 },
  triggerHint: { color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 15, fontStyle: 'italic' },
});

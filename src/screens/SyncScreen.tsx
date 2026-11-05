import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncCodes, syncLogs } from '../services/accessService';
import { insertCodesBatch, getUnsyncedLogs, markLogsAsSynced } from '../services/database';
import { colors } from '../theme/colors';
import { DownloadCloud, UploadCloud, QrCode } from 'lucide-react-native';
import packageJson from '../../package.json';

export default function SyncScreen({ navigation }: any) {
  const [event, setEvent] = useState<any>(null);
  const [loadingDown, setLoadingDown] = useState(false);
  const [loadingUp, setLoadingUp] = useState(false);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [deviceIdentifier, setDeviceIdentifier] = useState('');
  
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadedKB, setDownloadedKB] = useState('');
  const [savingStatus, setSavingStatus] = useState('');

  useEffect(() => {
    loadEventData();
    loadDeviceInfo();
  }, []);

  const loadDeviceInfo = async () => {
    try {
      const info = await AsyncStorage.getItem('device_info');
      if (info) {
        const parsed = JSON.parse(info);
        setDeviceIdentifier(parsed.device_identifier || parsed.name || 'Dispositivo');
      }
    } catch (e) {
      console.log('Error loading device info:', e);
    }
  };

  const loadEventData = async () => {
    const eventStr = await AsyncStorage.getItem('selected_event');
    if (eventStr) {
      setEvent(JSON.parse(eventStr));
    }
    checkUnsyncedLogs();
  };

  const checkUnsyncedLogs = async () => {
    const logs = await getUnsyncedLogs();
    setUnsyncedCount(logs.length);
  };

  const handleDownloadCodes = async () => {
    if (!event) return;
    setLoadingDown(true);
    setDownloadProgress(0);
    setDownloadSpeed('');
    setDownloadedKB('');
    setSavingStatus('');
    
    const startTime = Date.now();
    try {
      const data = await syncCodes(event.id, (progressEvent: any) => {
        if (progressEvent.loaded) {
          const kb = (progressEvent.loaded / 1024).toFixed(2);
          setDownloadedKB(`${kb} KB`);
          
          const timeElapsed = (Date.now() - startTime) / 1000;
          if (timeElapsed > 0) {
            const speed = (progressEvent.loaded / 1024 / timeElapsed).toFixed(2);
            setDownloadSpeed(`${speed} KB/s`);
          }
          
          if (progressEvent.total) {
            setDownloadProgress((progressEvent.loaded / progressEvent.total) * 100);
          }
        }
      });
      
      await AsyncStorage.setItem('allowed_sections', JSON.stringify(data.allowed_sections ?? null));
      if (data.features) {
        await AsyncStorage.setItem('event_features', JSON.stringify(data.features));
      }

      if (data.codes && data.codes.length > 0) {
        setSavingStatus(`Guardando ${data.codes.length} boletos localmente...`);
        await insertCodesBatch(data.codes, (processed, total) => {
          setSavingStatus(`Guardando boletos: ${processed} de ${total}...`);
        });
        setSavingStatus('');
        Alert.alert('Éxito', `Se descargaron y guardaron ${data.codes.length} boletos para escanear offline.`);
        checkUnsyncedLogs();
      } else {
        Alert.alert('Aviso', 'El evento no tiene boletos registrados.');
      }
    } catch (error: any) {
      console.error(error);
      const errorMsg = error.response?.data?.message || error.response?.data || error.message || 'Error desconocido';
      Alert.alert('Error', `No se pudieron descargar los boletos. Detalle: ${errorMsg}`);
    } finally {
      setLoadingDown(false);
    }
  };

  const handleUploadLogs = async () => {
    if (!event) return;
    const logs = await getUnsyncedLogs();
    if (logs.length === 0) {
      Alert.alert('Aviso', 'No hay escaneos pendientes por subir.');
      return;
    }

    setLoadingUp(true);
    try {
      // Formatear logs para la API
      const formattedLogs = logs.map((l) => ({
        code: l.code,
        scanned_at: l.scanned_at,
        direction: l.direction || 'in',
        override_reason: l.override_reason || null,
      }));

      const data = await syncLogs(event.id, formattedLogs);
      
      // Marcar como sincronizados en SQLite
      const ids = logs.map(l => l.id);
      await markLogsAsSynced(ids);
      
      setUnsyncedCount(0);
      Alert.alert('Éxito', `${data.synced_count} escaneos sincronizados al servidor.`);
    } catch (error: any) {
      console.error(error);
      const errorMsg = error.response?.data?.message || error.response?.data || error.message || 'Error desconocido';
      Alert.alert('Error', `No se pudieron sincronizar los escaneos. Detalle: ${errorMsg}`);
    } finally {
      setLoadingUp(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: colors.background }}>
      {event && (
        <View style={styles.header}>
          <Text style={styles.subtitle}>Evento Seleccionado:</Text>
          <Text style={styles.title}>{event.name}</Text>
          {deviceIdentifier ? <Text style={styles.deviceSubtitle}>ID Dispositivo: {deviceIdentifier}</Text> : null}
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.actionRow}>
          <View style={styles.actionInfo}>
            <DownloadCloud color={colors.primary} size={32} />
            <Text style={styles.actionTitle}>Descargar Base</Text>
            <Text style={styles.actionDesc}>Descarga todos los boletos al dispositivo para escanear sin internet.</Text>
          </View>
          <TouchableOpacity style={styles.button} onPress={handleDownloadCodes} disabled={loadingDown}>
            {loadingDown ? <ActivityIndicator color={colors.background} /> : <Text style={styles.buttonText}>Descargar</Text>}
          </TouchableOpacity>
        </View>
        {loadingDown && (
          <View style={{ marginTop: 15 }}>
            <View style={{ height: 6, backgroundColor: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
               <View style={{ width: `${downloadProgress || 100}%`, height: '100%', backgroundColor: colors.primary }} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 }}>
               <Text style={{ fontSize: 12, color: colors.textMuted }}>{downloadedKB}</Text>
               <Text style={{ fontSize: 12, color: colors.textMuted }}>{downloadSpeed}</Text>
            </View>
            {savingStatus ? (
              <Text style={{ fontSize: 12, color: colors.primary, marginTop: 4, fontWeight: '600', textAlign: 'center' }}>
                {savingStatus}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.actionRow}>
          <View style={styles.actionInfo}>
            <UploadCloud color={unsyncedCount > 0 ? colors.warning : colors.success} size={32} />
            <Text style={styles.actionTitle}>Subir Escaneos</Text>
            <Text style={styles.actionDesc}>Pendientes: {unsyncedCount}</Text>
          </View>
          <TouchableOpacity style={[styles.button, unsyncedCount === 0 && {backgroundColor: colors.textMuted}]} onPress={handleUploadLogs} disabled={loadingUp || unsyncedCount === 0}>
            {loadingUp ? <ActivityIndicator color={colors.background} /> : <Text style={styles.buttonText}>Sincronizar</Text>}
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity style={styles.scanButton} onPress={() => navigation.navigate('Scanner')}>
        <QrCode color={colors.background} size={24} />
        <Text style={styles.scanButtonText}>INICIAR ESCÁNER</Text>
      </TouchableOpacity>
      <Text style={styles.versionText}>v{packageJson.version}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    flexGrow: 1,
    justifyContent: 'center',
  },
  header: {
    marginBottom: 30,
    alignItems: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: colors.text,
    textAlign: 'center',
    marginTop: 5,
  },
  deviceSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 6,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.card,
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionInfo: {
    flex: 1,
    paddingRight: 10,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.text,
    marginTop: 8,
  },
  actionDesc: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 4,
  },
  button: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  scanButton: {
    backgroundColor: colors.text,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
    borderRadius: 12,
    marginTop: 10,
  },
  scanButtonText: {
    color: colors.background,
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 10,
  },
  versionText: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 20,
  },
});

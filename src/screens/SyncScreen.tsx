import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncCodes, syncLogs } from '../services/accessService';
import { insertCodesBatch, getUnsyncedLogs, markLogsAsSynced } from '../services/database';
import { colors } from '../theme/colors';
import { DownloadCloud, UploadCloud, QrCode } from 'lucide-react-native';

export default function SyncScreen({ navigation }: any) {
  const [event, setEvent] = useState<any>(null);
  const [loadingDown, setLoadingDown] = useState(false);
  const [loadingUp, setLoadingUp] = useState(false);
  const [unsyncedCount, setUnsyncedCount] = useState(0);

  useEffect(() => {
    loadEventData();
  }, []);

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
    try {
      const data = await syncCodes(event.id);
      if (data.codes && data.codes.length > 0) {
        await insertCodesBatch(data.codes);
        // Guardar secciones permitidas para validación offline de zonas
        await AsyncStorage.setItem('allowed_sections', JSON.stringify(data.allowed_sections ?? null));
        Alert.alert('Éxito', `Se descargaron ${data.codes.length} boletos para escanear offline.`);
        checkUnsyncedLogs();
      } else {
        Alert.alert('Aviso', 'El evento no tiene boletos registrados.');
      }
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'No se pudieron descargar los boletos.');
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
      }));

      const data = await syncLogs(event.id, formattedLogs);
      
      // Marcar como sincronizados en SQLite
      const ids = logs.map(l => l.id);
      await markLogsAsSynced(ids);
      
      setUnsyncedCount(0);
      Alert.alert('Éxito', `${data.synced_count} escaneos sincronizados al servidor.`);
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'No se pudieron sincronizar los escaneos.');
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.background,
    padding: 20,
  },
  header: {
    marginBottom: 30,
    marginTop: 20,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: colors.primary,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionRow: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  actionInfo: {
    alignItems: 'center',
  },
  actionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.text,
    marginTop: 8,
  },
  actionDesc: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },
  button: {
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
  },
  buttonText: {
    color: colors.background,
    fontWeight: 'bold',
    fontSize: 16,
  },
  scanButton: {
    backgroundColor: '#000',
    flexDirection: 'row',
    padding: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 'auto',
    marginBottom: 20,
  },
  scanButtonText: {
    color: colors.background,
    fontWeight: '900',
    fontSize: 18,
    marginLeft: 12,
    letterSpacing: 1,
  },
});

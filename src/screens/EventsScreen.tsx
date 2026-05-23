import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getEvents } from '../services/accessService';
import { colors } from '../theme/colors';
import { LogOut, Calendar } from 'lucide-react-native';

export default function EventsScreen({ navigation }: any) {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadEvents();
  }, []);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const data = await getEvents();
      setEvents(data);
    } catch (error: any) {
      console.error(error);
      const errorMsg = error.response?.data?.message || error.response?.data || error.message || 'Error desconocido';
      Alert.alert('Error al cargar eventos', `Detalle: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const selectEvent = async (event: any) => {
    await AsyncStorage.setItem('selected_event', JSON.stringify(event));
    navigation.navigate('Sync');
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem('scanner_token');
    await AsyncStorage.removeItem('device_info');
    await AsyncStorage.removeItem('selected_event');
    navigation.replace('Login');
  };

  const renderItem = ({ item }: { item: any }) => (
    <TouchableOpacity style={styles.eventCard} onPress={() => selectEvent(item)}>
      <View style={styles.eventHeader}>
        <Calendar color={colors.primary} size={24} />
        <View style={styles.eventInfo}>
          <Text style={styles.eventName}>{item.name}</Text>
          <Text style={styles.eventDate}>{item.date ? new Date(item.date).toLocaleDateString() : 'Sin fecha'}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Eventos Activos</Text>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
          <LogOut color={colors.danger} size={24} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 50 }} />
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No hay eventos activos disponibles en este momento.</Text>
          }
          refreshing={loading}
          onRefresh={loadEvents}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60, // Para SafeArea visual
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.text,
  },
  logoutBtn: {
    padding: 8,
  },
  list: {
    padding: 20,
  },
  eventCard: {
    backgroundColor: colors.card,
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  eventHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  eventInfo: {
    marginLeft: 16,
  },
  eventName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 4,
  },
  eventDate: {
    fontSize: 14,
    color: colors.textMuted,
  },
  emptyText: {
    textAlign: 'center',
    color: colors.textMuted,
    marginTop: 40,
    fontSize: 16,
  },
});

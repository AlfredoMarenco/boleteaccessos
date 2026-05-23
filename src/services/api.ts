import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// In development with physical devices, use your local IP address instead of localhost.
// e.g., 'http://192.168.1.79:8000/api/v1'
// You can update this variable as needed.
const API_URL = 'https://boletea.com/api/v1'; // Servidor de Producción

export const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

api.interceptors.request.use(async (config) => {
  try {
    const token = await AsyncStorage.getItem('scanner_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
      config.headers['X-Authorization'] = `Bearer ${token}`;
      config.params = {
        ...config.params,
        token: token,
      };
    }
  } catch (error) {
    console.error('Error getting token from storage', error);
  }
  return config;
});

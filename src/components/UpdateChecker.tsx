import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { UpdateAPK } from 'rn-update-apk';
import { DownloadCloud } from 'lucide-react-native';
import { API_ENDPOINTS } from '../config';
import { colors } from '../theme/colors';

export default function UpdateChecker() {
  const [modalVisible, setModalVisible] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [whatsNew, setWhatsNew] = useState('');
  const [isForceUpdate, setIsForceUpdate] = useState(false);
  const [doUpdate, setDoUpdate] = useState<((update: boolean) => void) | null>(
    null
  );

  useEffect(() => {
    const updater = new UpdateAPK({
      apkVersionUrl: API_ENDPOINTS.checkApk,
      fileProviderAuthority: 'com.boletea.accessos.fileprovider',
      needUpdateApp: (
        isUpdateCallback: (update: boolean) => void,
        whatsNewText: string
      ) => {
        setWhatsNew(whatsNewText);
        setDoUpdate(() => isUpdateCallback);
        setModalVisible(true);
      },
      forceUpdateApp: () => {
        setIsForceUpdate(true);
        // We set the state to show the modal but it doesn't wait for user approval
        setModalVisible(true);
      },
      notNeedUpdateApp: () => {
        console.log('App is up to date');
      },
      downloadApkStart: () => {
        setIsDownloading(true);
        setProgress(0);
        setModalVisible(true);
      },
      downloadApkProgress: (progressValue: number) => {
        setProgress(progressValue);
      },
      downloadApkEnd: () => {
        setIsDownloading(false);
        setModalVisible(false);
      },
      onError: (err: Error) => {
        console.error('Update failed', err);
        setIsDownloading(false);
        if (!isForceUpdate) {
          setModalVisible(false);
        }
      },
    });

    updater.checkUpdate();
  }, [isForceUpdate]);

  const handleUpdate = () => {
    if (doUpdate) {
      doUpdate(true);
    } else if (isForceUpdate) {
       // if forced update is clicked but we didn't get callback from needUpdateApp
       setIsDownloading(true);
    }
  };

  const handleCancel = () => {
    if (!isForceUpdate) {
      if (doUpdate) {
        doUpdate(false);
      }
      setModalVisible(false);
    }
  };

  return (
    <Modal
      visible={modalVisible}
      transparent={true}
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <View style={styles.overlay}>
        <View style={styles.modalContainer}>
          <View style={styles.iconContainer}>
            <DownloadCloud size={48} color={colors.primary} />
          </View>

          <Text style={styles.title}>Actualización Disponible</Text>

          {!isDownloading ? (
            <>
              <Text style={styles.message}>
                Hay una nueva versión de la aplicación disponible.{'\n'}
                {whatsNew
                  ? `\nNovedades:\n${whatsNew}`
                  : '\nPor favor, actualiza para disfrutar de las últimas mejoras.'}
              </Text>

              <View style={styles.buttonContainer}>
                {!isForceUpdate && (
                  <TouchableOpacity
                    style={[styles.button, styles.cancelButton]}
                    onPress={handleCancel}
                  >
                    <Text style={styles.cancelButtonText}>Más tarde</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.button, styles.updateButton]}
                  onPress={handleUpdate}
                >
                  <Text style={styles.updateButtonText}>Actualizar</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.downloadContainer}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.downloadText}>
                Descargando actualización... {progress}%
              </Text>
              <View style={styles.progressBarBackground}>
                <View
                  style={[styles.progressBarFill, { width: `${progress}%` }]}
                />
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    alignItems: 'stretch',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  iconContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  message: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  updateButton: {
    backgroundColor: colors.primary,
  },
  cancelButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  updateButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  downloadContainer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  downloadText: {
    marginTop: 16,
    fontSize: 16,
    color: colors.textMuted,
    fontWeight: '500',
  },
  progressBarBackground: {
    width: '100%',
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    marginTop: 16,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.success,
    borderRadius: 4,
  },
});

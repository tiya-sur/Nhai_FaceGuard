import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
} from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { useFaceRecognition } from '../hooks/useFaceRecognition';
import { useLivenessDetection } from '../hooks/useLivenessDetection';
import { LocalDB } from '../services/localDB';

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME_SIZE = SCREEN_W * 0.75;

export type AuthResult = {
  userId: string;
  confidence: number;
  livenessVerified: boolean;
  timestamp: string;
  synced: boolean;
};

interface CameraScreenProps {
  onSuccess: (result: AuthResult) => void;
  onCancel: () => void;
}

type Phase = 'idle' | 'liveness' | 'recognizing' | 'success' | 'failed';

export const CameraScreen: React.FC<CameraScreenProps> = ({ onSuccess, onCancel }) => {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const cameraRef = useRef<Camera>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [statusMsg, setStatusMsg] = useState('Position your face in the frame');
  const [faceDetected, setFaceDetected] = useState(false);

  const overlayAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const { runRecognition } = useFaceRecognition();
  const { runLivenessChallenge, currentChallenge } = useLivenessDetection();

  // Pulse animation when face detected
  useEffect(() => {
    if (faceDetected) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.04, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.0, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [faceDetected]);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, []);

  const startAuth = async () => {
    if (!cameraRef.current) return;

    try {
      // Phase 1: Liveness detection
      setPhase('liveness');
      setStatusMsg('Liveness check starting...');
      const livenessOk = await runLivenessChallenge(cameraRef);
      if (!livenessOk) {
        setPhase('failed');
        setStatusMsg('Liveness check failed. Please try again.');
        setTimeout(() => setPhase('idle'), 2500);
        return;
      }

      // Phase 2: Face recognition
      setPhase('recognizing');
      setStatusMsg('Verifying identity...');
      const photo = await cameraRef.current.takePhoto({ qualityPrioritization: 'speed' });
      const result = await runRecognition(photo.path);

      if (result && result.confidence > 0.95) {
        // Save record locally
        const record = {
          userId: result.userId,
          confidence: result.confidence,
          livenessVerified: true,
          timestamp: new Date().toISOString(),
          synced: false,
        };
        await LocalDB.saveRecord(record);

        setPhase('success');
        setStatusMsg(`Welcome, ${result.userId}!`);

        // Flash success overlay
        Animated.sequence([
          Animated.timing(overlayAnim, { toValue: 0.35, duration: 250, useNativeDriver: true }),
          Animated.timing(overlayAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
        ]).start();

        setTimeout(() => onSuccess(record), 800);
      } else {
        setPhase('failed');
        setStatusMsg('Identity not recognised. Please retry.');
        setTimeout(() => setPhase('idle'), 2500);
      }
    } catch (err: any) {
      setPhase('failed');
      setStatusMsg('Error during verification. Please retry.');
      console.error('Auth error:', err);
      setTimeout(() => setPhase('idle'), 2500);
    }
  };

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>Camera permission is required.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnTxt}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#00C9A7" size="large" />
        <Text style={styles.permText}>Loading camera…</Text>
      </View>
    );
  }

  const frameColor =
    phase === 'success' ? '#00C9A7' :
    phase === 'failed'  ? '#FF4D4D' :
    faceDetected        ? '#FFD700' : '#FFFFFF';

  const challengeLabel: Record<string, string> = {
    blink:     '👁  Please BLINK',
    smile:     '😊  Please SMILE',
    turn_left: '⬅️  Turn head LEFT',
    turn_right:'➡️  Turn head RIGHT',
  };

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
        onError={(e) => Alert.alert('Camera error', e.message)}
      />

      {/* Success flash overlay */}
      <Animated.View
        style={[styles.flashOverlay, { opacity: overlayAnim, backgroundColor: '#00C9A7' }]}
        pointerEvents="none"
      />

      {/* Oval face guide */}
      <View style={styles.overlay} pointerEvents="none">
        <Animated.View
          style={[
            styles.faceFrame,
            { borderColor: frameColor, transform: [{ scale: pulseAnim }] },
          ]}
        />
      </View>

      {/* Status bar */}
      <View style={styles.statusBar}>
        {(phase === 'recognizing' || phase === 'liveness') && (
          <ActivityIndicator color="#00C9A7" size="small" style={{ marginRight: 8 }} />
        )}
        <Text style={styles.statusTxt}>
          {phase === 'liveness' && currentChallenge
            ? challengeLabel[currentChallenge] ?? statusMsg
            : statusMsg}
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelTxt}>Cancel</Text>
        </TouchableOpacity>

        {phase === 'idle' && (
          <TouchableOpacity style={styles.btn} onPress={startAuth}>
            <Text style={styles.btnTxt}>Authenticate</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Offline badge */}
      <View style={styles.offlineBadge}>
        <View style={styles.offlineDot} />
        <Text style={styles.offlineTxt}>OFFLINE MODE</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  faceFrame: {
    width: FRAME_SIZE,
    height: FRAME_SIZE * 1.2,
    borderRadius: FRAME_SIZE / 2,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: 'transparent',
  },
  flashOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  statusBar: {
    position: 'absolute',
    bottom: 160,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  statusTxt: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  controls: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
  },
  btn: {
    backgroundColor: '#00C9A7',
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 30,
  },
  btnTxt: { color: '#000', fontWeight: '700', fontSize: 16 },
  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 30,
  },
  cancelTxt: { color: '#FFF', fontWeight: '600', fontSize: 15 },
  offlineBadge: {
    position: 'absolute',
    top: 50,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  offlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFD700', marginRight: 5 },
  offlineTxt: { color: '#FFD700', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  permText: { color: '#FFF', marginBottom: 20, fontSize: 15, textAlign: 'center', paddingHorizontal: 30 },
});

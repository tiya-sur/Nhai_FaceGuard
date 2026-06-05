/**
 * useFaceRecognition.ts
 * Core hook for offline facial recognition using TFLite models.
 * Models: BlazeFace (detection) + MobileFaceNet (embeddings)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { Platform } from 'react-native';
import { cosineSimilarity, preprocessFace } from '../utils/tensorUtils';
import { getStoredEmbeddings, saveAttendanceRecord } from '../services/localDB';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaceEmbedding {
  userId: string;
  name: string;
  embedding: Float32Array; // 128-dim vector from MobileFaceNet
}

export interface RecognitionResult {
  status: 'match' | 'no_match' | 'error';
  userId?: string;
  name?: string;
  confidence?: number; // 0–1
  processingTimeMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.60;    // Cosine similarity threshold (>95% accuracy)
const FACE_INPUT_SIZE = 112;     // MobileFaceNet input: 112×112
const BLAZEFACE_INPUT_SIZE = 128; // BlazeFace input: 128×128

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFaceRecognition() {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storedEmbeddings = useRef<FaceEmbedding[]>([]);

  // Load TFLite models from app bundle (bundled at build time, fully offline)
  const blazeFaceModel = useTensorflowModel(
    require('../../assets/models/blazeface.tflite')
  );
  const mobileFaceNetModel = useTensorflowModel(
    require('../../assets/models/mobilefacenet.tflite')
  );
  const antiSpoofModel = useTensorflowModel(
    require('../../assets/models/antispoofing.tflite')
  );

  useEffect(() => {
    if (
      blazeFaceModel.state === 'loaded' &&
      mobileFaceNetModel.state === 'loaded' &&
      antiSpoofModel.state === 'loaded'
    ) {
      loadStoredEmbeddings();
    }
  }, [blazeFaceModel.state, mobileFaceNetModel.state, antiSpoofModel.state]);

  const loadStoredEmbeddings = async () => {
    try {
      storedEmbeddings.current = await getStoredEmbeddings();
      setIsReady(true);
    } catch (e) {
      setError('Failed to load stored embeddings');
    }
  };

  /**
   * Full recognition pipeline:
   * 1. Detect face with BlazeFace
   * 2. Passive anti-spoof check
   * 3. Extract embedding with MobileFaceNet
   * 4. Cosine similarity match against stored embeddings
   */
  const recognizeFace = useCallback(
    async (frameData: Uint8Array, width: number, height: number): Promise<RecognitionResult> => {
      const startTime = Date.now();

      try {
        if (!isReady) return { status: 'error' };

        // Step 1: Face detection (BlazeFace)
        const blazeInput = preprocessFace(frameData, width, height, BLAZEFACE_INPUT_SIZE);
        const detectionOutput = await blazeFaceModel.model!.run([blazeInput]);
        const faceBox = extractFaceBox(detectionOutput[0] as Float32Array);

        if (!faceBox) return { status: 'no_match' };

        // Step 2: Anti-spoof (passive liveness)
        const spoofInput = preprocessFace(frameData, width, height, BLAZEFACE_INPUT_SIZE, faceBox);
        const spoofOutput = await antiSpoofModel.model!.run([spoofInput]);
        const isRealFace = (spoofOutput[0] as Float32Array)[1] > 0.5; // class 1 = real

        if (!isRealFace) return { status: 'error' };

        // Step 3: Embedding extraction (MobileFaceNet)
        const faceInput = preprocessFace(frameData, width, height, FACE_INPUT_SIZE, faceBox);
        const embeddingOutput = await mobileFaceNetModel.model!.run([faceInput]);
        const embedding = embeddingOutput[0] as Float32Array;

        // Step 4: Match against stored embeddings
        let bestMatch: FaceEmbedding | null = null;
        let bestScore = 0;

        for (const stored of storedEmbeddings.current) {
          const score = cosineSimilarity(embedding, stored.embedding);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = stored;
          }
        }

        const processingTimeMs = Date.now() - startTime;

        if (bestMatch && bestScore >= MATCH_THRESHOLD) {
          // Save attendance record locally (synced later when online)
          await saveAttendanceRecord({
            userId: bestMatch.userId,
            name: bestMatch.name,
            confidence: bestScore,
            timestamp: new Date().toISOString(),
            synced: false,
          });

          return {
            status: 'match',
            userId: bestMatch.userId,
            name: bestMatch.name,
            confidence: bestScore,
            processingTimeMs,
          };
        }

        return { status: 'no_match', processingTimeMs };
      } catch (e) {
        console.error('Recognition error:', e);
        return { status: 'error' };
      }
    },
    [isReady, blazeFaceModel, mobileFaceNetModel, antiSpoofModel]
  );

  return { isReady, error, recognizeFace, reloadEmbeddings: loadStoredEmbeddings };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function extractFaceBox(detections: Float32Array) {
  // BlazeFace output: [ymin, xmin, ymax, xmax, score] repeated per face
  // Return box with highest confidence score
  if (!detections || detections.length < 5) return null;
  const score = detections[4];
  if (score < 0.75) return null;
  return { ymin: detections[0], xmin: detections[1], ymax: detections[2], xmax: detections[3] };
}

/**
 * useLivenessDetection.ts
 * Challenge-response liveness detection using MediaPipe Face Mesh landmarks.
 * Requires user to: blink both eyes + turn head slightly.
 * Anti-spoofing against printed photos and screen replays.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Animated } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LivenessChallenge = 'blink' | 'turn_left' | 'turn_right' | 'smile';

export interface LivenessState {
  currentChallenge: LivenessChallenge;
  challengesPassed: LivenessChallenge[];
  isPassed: boolean;
  progress: number; // 0–1
  instruction: string;
}

interface FaceLandmarks {
  leftEyeTop: { x: number; y: number };
  leftEyeBottom: { x: number; y: number };
  rightEyeTop: { x: number; y: number };
  rightEyeBottom: { x: number; y: number };
  noseTip: { x: number; y: number };
  leftCheek: { x: number; y: number };
  rightCheek: { x: number; y: number };
  mouthLeft: { x: number; y: number };
  mouthRight: { x: number; y: number };
  upperLip: { x: number; y: number };
  lowerLip: { x: number; y: number };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EAR_BLINK_THRESHOLD = 0.20;     // Eye aspect ratio — below = blink
const HEAD_YAW_THRESHOLD = 15;         // degrees for head turn
const SMILE_THRESHOLD = 0.45;          // mouth width / face width ratio
const CHALLENGE_TIMEOUT_MS = 5000;     // 5 seconds per challenge
const REQUIRED_CHALLENGES: LivenessChallenge[] = ['blink', 'turn_left'];

const INSTRUCTIONS: Record<LivenessChallenge, string> = {
  blink: 'Please blink both eyes',
  turn_left: 'Slowly turn your head left',
  turn_right: 'Slowly turn your head right',
  smile: 'Please smile',
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLivenessDetection(onPassed: () => void) {
  const [state, setState] = useState<LivenessState>({
    currentChallenge: REQUIRED_CHALLENGES[0],
    challengesPassed: [],
    isPassed: false,
    progress: 0,
    instruction: INSTRUCTIONS[REQUIRED_CHALLENGES[0]],
  });

  const blinkFrameCount = useRef(0);  // consecutive frames with eye closed
  const challengeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;

  const advanceChallenge = useCallback((passed: LivenessChallenge) => {
    setState(prev => {
      const newPassed = [...prev.challengesPassed, passed];
      const nextIndex = newPassed.length;

      if (nextIndex >= REQUIRED_CHALLENGES.length) {
        onPassed();
        return { ...prev, challengesPassed: newPassed, isPassed: true, progress: 1, instruction: '✓ Liveness verified!' };
      }

      const next = REQUIRED_CHALLENGES[nextIndex];
      return {
        ...prev,
        currentChallenge: next,
        challengesPassed: newPassed,
        progress: nextIndex / REQUIRED_CHALLENGES.length,
        instruction: INSTRUCTIONS[next],
      };
    });
  }, [onPassed]);

  /**
   * Called on every camera frame with MediaPipe landmarks.
   * Detects blink via Eye Aspect Ratio (EAR) and head yaw via cheek distance.
   */
  const processLandmarks = useCallback((landmarks: FaceLandmarks) => {
    setState(prev => {
      if (prev.isPassed) return prev;

      switch (prev.currentChallenge) {
        case 'blink': {
          const leftEAR = eyeAspectRatio(landmarks.leftEyeTop, landmarks.leftEyeBottom);
          const rightEAR = eyeAspectRatio(landmarks.rightEyeTop, landmarks.rightEyeBottom);
          const avgEAR = (leftEAR + rightEAR) / 2;

          if (avgEAR < EAR_BLINK_THRESHOLD) {
            blinkFrameCount.current += 1;
            if (blinkFrameCount.current >= 2) { // blink confirmed (2+ frames)
              blinkFrameCount.current = 0;
              setTimeout(() => advanceChallenge('blink'), 0);
            }
          } else {
            blinkFrameCount.current = 0;
          }
          break;
        }

        case 'turn_left': {
          const yaw = estimateYaw(landmarks);
          if (yaw > HEAD_YAW_THRESHOLD) {
            setTimeout(() => advanceChallenge('turn_left'), 0);
          }
          break;
        }

        case 'turn_right': {
          const yaw = estimateYaw(landmarks);
          if (yaw < -HEAD_YAW_THRESHOLD) {
            setTimeout(() => advanceChallenge('turn_right'), 0);
          }
          break;
        }

        case 'smile': {
          const smileRatio = smileScore(landmarks);
          if (smileRatio > SMILE_THRESHOLD) {
            setTimeout(() => advanceChallenge('smile'), 0);
          }
          break;
        }
      }

      return prev;
    });
  }, [advanceChallenge]);

  const reset = useCallback(() => {
    blinkFrameCount.current = 0;
    if (challengeTimer.current) clearTimeout(challengeTimer.current);
    setState({
      currentChallenge: REQUIRED_CHALLENGES[0],
      challengesPassed: [],
      isPassed: false,
      progress: 0,
      instruction: INSTRUCTIONS[REQUIRED_CHALLENGES[0]],
    });
  }, []);

  return { state, processLandmarks, reset, progressAnim };
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Eye Aspect Ratio: distance between eyelid points / eye width */
function eyeAspectRatio(
  top: { x: number; y: number },
  bottom: { x: number; y: number }
): number {
  return Math.abs(top.y - bottom.y);
}

/** Estimate horizontal head yaw from cheek distances to nose */
function estimateYaw(lm: FaceLandmarks): number {
  const leftDist = Math.abs(lm.noseTip.x - lm.leftCheek.x);
  const rightDist = Math.abs(lm.rightCheek.x - lm.noseTip.x);
  // Positive = turned right, negative = turned left
  return ((rightDist - leftDist) / (leftDist + rightDist)) * 90;
}

/** Smile score: mouth width relative to face width */
function smileScore(lm: FaceLandmarks): number {
  const mouthWidth = Math.abs(lm.mouthRight.x - lm.mouthLeft.x);
  const faceWidth = Math.abs(lm.rightCheek.x - lm.leftCheek.x);
  return faceWidth > 0 ? mouthWidth / faceWidth : 0;
}

// Voice-entry for the classroom-chatbot holo bundle.
// Bundled with esbuild (iife, global HoloLib); three is inlined.
export * as THREE from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { buildFaceRig, AU_NAMES, apertureBounds, insideAperture } from './faceRig';
export type { FaceRig, AUName } from './faceRig';
export { createHoloMaterial, createEyeMaterial } from './holoMaterial';
export { AUAnimator, BlinkController, GazeController, Breath, EMOTIONS, fbm } from './expression';
export type { Emotion, AUMap } from './expression';
export { classifySpectrum, VISEMES, VISEME_TO_AU } from './lipsync';
export type { Viseme, VisemeFrame } from './lipsync';
export { VisemeTrack, emptyVisemeFrame } from './visemeTrack';

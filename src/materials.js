import {
  LineBasicMaterial, MeshBasicMaterial,
} from 'three';
import { raycastTargetMeshMaterialColor, outlineMaterialColor } from './constants.js';

export const outlineMaterial = new LineBasicMaterial({ color: outlineMaterialColor });
export const raycastTargetMeshMaterial = new MeshBasicMaterial({
  color: raycastTargetMeshMaterialColor,
});

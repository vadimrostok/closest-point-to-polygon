import {
  Shape,
  Mesh,
  ShapeGeometry,
  MeshBasicMaterial,
} from 'three';
import {
  polygonPointerMultiplier,
} from './constants.js';

export function createPolygonPointer(color, points) {
  const pointer = new Shape();

  pointer.moveTo(points[0].x * polygonPointerMultiplier, points[0].y * polygonPointerMultiplier);
  points.slice(1).forEach(({ x, y }) => {
    pointer.lineTo(x * polygonPointerMultiplier, y * polygonPointerMultiplier);
  });

  const polygonPointer = new Mesh(new ShapeGeometry(pointer), new MeshBasicMaterial({ color }));
  polygonPointer.position.set(0, 0, 0.5);

  return polygonPointer;
}

import { createPolygonPointer } from './helpers.js';
import { flagColor, triangleColor, sphereColor } from './constants.js';

export default [
  (() => {
    const points = [
      { x: -10.0, y: -10.0 },
      { x: 10.0, y: -10.0 },
      { x: 0.0,  y: 0.0 },
      { x: 10.0, y:  10.0 },
      { x: -10.0, y:  10.0 },
      { x: -10.0, y: -10.0 },
    ];

    return { // flag
      position: { x: -20, y: 20 },
      points,
      polygonPointer: createPolygonPointer(flagColor, points),
      mesh: null,
    };
  })(),
  (() => {
    const points = [
      { x: -10.0, y: -10.0 },
      { x: 10.0, y: -10.0 },
      { x: 0.0,  y: 10.0 },
      { x: -10.0, y: -10.0 },
    ];
    return { // triangle
      position: { x: 20, y: 20 },
      points,
      polygonPointer: createPolygonPointer(triangleColor, points),
      mesh: null,
    };
  })(),
  (() => {
    const sides = 64;
    const radius = 20;
    let points = (new Array(sides)).fill(0).map((_, index) => ({
      x: Math.sin(Math.PI*2/sides*index)*radius,
      y: Math.cos(Math.PI*2/sides*index)*radius,
    }));
    points.push(points[0]);

    const targetMeshPoints = [];
    let prev = null;
    for (let i = 0; i <= sides; i++) {
      if (i === 0) {
        targetMeshPoints.push({x: 0, y: 0});
      } else {
        targetMeshPoints.push({x: 0, y: 0});
        targetMeshPoints.push(points[i - 1]);
        targetMeshPoints.push(points[i]);
      }
    }

    points.reverse();
    targetMeshPoints.reverse();

    return { // circle(ish)
      position: { x: -0, y: -20 },
      points,
      polygonPointer: createPolygonPointer(sphereColor, points),
      targetMeshPoints,
      mesh: null,
    };
  })()
];

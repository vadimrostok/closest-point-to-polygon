import { Vector3 } from 'three';

// In order to reuse some object we'll initialize them here:
const segmentStartPoint = new Vector3();
const segmentEndPoint = new Vector3();
const targetPoint = new Vector3();
const directionVector = new Vector3();
const targetPointSubSegmentStartPoint = new Vector3();

/**
 * @param {{x: Number, y: Number}[]} points array of point objects
 * @returns {x: Number, y: Number} point object
 */
export default function closestPointInPolygon(points, { x: targetPointX, y: targetPointY }) {
  let minimalDistance = Infinity;
  let closestPoint = points[0];

  // I used reduce here to improve readability of the process of taking 2 points for each iteration.
  points.reduce((previousPoint, currentPoint) => {  
    segmentStartPoint.set(previousPoint.x, previousPoint.y,  0.0);
    segmentEndPoint.set(currentPoint.x, currentPoint.y,  0.0);
    targetPoint.set(targetPointX, targetPointY, 0);
    directionVector.subVectors(segmentEndPoint, segmentStartPoint);

    // dot(targetPoint - segmentStartPoint, directionVector) / dot(directionVector, directionVector)
    const closestSegmentIndex = 
          directionVector.dot(targetPointSubSegmentStartPoint.subVectors(targetPoint, segmentStartPoint)) /
          directionVector.clone().dot(directionVector);

    let distance = 0;
    let intersect = new Vector3();

    // We need to fix a closest point at the beginning of a segment.
    if (closestSegmentIndex < 0) {
      intersect = segmentStartPoint;
      distance = targetPoint.clone().sub(segmentStartPoint).length();
    } else if (closestSegmentIndex > 1) { // Fix a closest point at the ending of a segment.
      intersect.addVectors(segmentStartPoint, directionVector);
      distance = targetPoint.clone().sub(segmentEndPoint).length();
    } else {
      intersect.addVectors(segmentStartPoint, directionVector.multiplyScalar(closestSegmentIndex));
      distance = targetPoint.clone().sub(intersect).length();
    };

    if (distance < minimalDistance) {
      minimalDistance = distance;
      closestPoint = { x: intersect.x, y: intersect.y };
    }

    return currentPoint;
  });

  return closestPoint;
}

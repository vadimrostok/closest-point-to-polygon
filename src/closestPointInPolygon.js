import { Vector3 } from 'three';

// In order to reuse some object we'll initialize them here:
const segmentStartPoint = new Vector3();
const segmentEndPoint = new Vector3();
const targetPoint = new Vector3();
const directionVector = new Vector3();
const targetPointSubSegmentStartPoint = new Vector3();

// let f = false
/**
 * @param {{x: Number, y: Number}[]} points array of point objects
 * @returns {x: Number, y: Number} point object
 */
export default function closestPointInPolygon(points, { x: targetPointX, y: targetPointY }) {
  let minimalDistance = Infinity;
  let closestPoint = points[0];

  points.reduce((previousPoint, currentPoint) => {
    // if (!f) {
    //   console.log('currentPoint, previousPoint', currentPoint, previousPoint);
    // }
    
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

    if (closestSegmentIndex < 0) {
      intersect = segmentStartPoint;
      distance = targetPoint.clone().sub(segmentStartPoint).length();
    } else if (closestSegmentIndex > 1) {
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
  // f=true

  return closestPoint;
}

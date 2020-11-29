import {
  WebGLRenderer, OrthographicCamera, Scene, Color, Shape, Mesh, ShapeGeometry,
  AmbientLight, SphereGeometry, BufferAttribute, BufferGeometry, Line,
  Vector3, Vector2, Raycaster,
} from 'three';

import Stats from './lib/stats.js';

import { outlineMaterial, raycastTargetMeshMaterial } from './materials.js';
import { sceneBackgroundColor } from './constants.js';
import shapes from './shapes.js';

import closestPointInPolygon from './closestPointInPolygon';

const raycaster = new Raycaster();
const normalizedMouse = new Vector2();
const mouse = new Vector2();

export default () => {
  const container = document.getElementById('container');

  const renderer = new WebGLRenderer();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  container.appendChild(renderer.domElement);

  const stats = new Stats();
  stats.domElement.style.position = 'absolute';
  stats.domElement.style.top = '0px';
  document.body.appendChild( stats.domElement );

  const scene = new Scene();
  scene.background = new Color(sceneBackgroundColor);

  let [windowWidth, windowHeight] = [window.innerWidth, window.innerHeight];
  let aspectRatio = windowWidth/windowHeight;
  const camera = new OrthographicCamera(
    -50*aspectRatio,
    50*aspectRatio,
    50,
    -50,
    1,
    1000,
  );
  camera.position.x = 0;
  camera.position.y = 0;
  camera.position.z = 5;
  camera.lookAt( 0, 0, 0 );

  window.addEventListener('resize', () => {
    [windowWidth, windowHeight] = [window.innerWidth, window.innerHeight];
    aspectRatio = windowWidth/windowHeight;
    camera.left = -50*aspectRatio;
    camera.right = 50*aspectRatio;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.updateProjectionMatrix();
  }, false);

  shapes.forEach((shape) => {
    const { points, position, polygonPointer } = shape;

    scene.add(polygonPointer);

    const geometry = new BufferGeometry();
    const vertices = new Float32Array(points.reduce((a, { x, y }) => {
      a = a.concat([x, y, 0]);
      return a;
    }, []));

    geometry.addAttribute('position', new BufferAttribute(vertices, 3));

    const lineMesh = new Line(geometry, outlineMaterial);

    /**
     * I used line mesh to outline shapes, but raycaster detects intersections with it only
     * on borders, so we need a "filled" mesh for raycaster.
     */
    let raycastTargetMesh;
    /**
     * I wanted sphere to be big and smooth, but I don't want to compute distances to polygon edges
     * that are going to its center (required to have a filled sphere), so for sphere we have only 
     * outline set of vertices for line mesh, bug full set for triangle polygons for raycaster target mesh.
     */
    if (shape.targetMeshPoints) {
      const raycastTargetGeometry = new BufferGeometry();
      const raycastTargetVertices = new Float32Array(shape.targetMeshPoints.reduce((a, { x, y }) => {
        a = a.concat([x, y, 0]);
        return a;
      }, []));

      raycastTargetGeometry.addAttribute('position', new BufferAttribute(raycastTargetVertices, 3));
      raycastTargetMesh = new Mesh(raycastTargetGeometry, raycastTargetMeshMaterial);
    } else {
      raycastTargetMesh = new Mesh(geometry, raycastTargetMeshMaterial);
    }

    lineMesh.position.set(position.x, position.y, 0.1);
    raycastTargetMesh.position.set(position.x, position.y, 0);

    shape.mesh = raycastTargetMesh;

    scene.add(lineMesh);
    scene.add(raycastTargetMesh);
  });

  function loop() {
    requestAnimationFrame( loop );

    raycaster.setFromCamera( normalizedMouse, camera );

    renderer.render(scene, camera);

    stats.update();

    shapes.forEach(({ points, position, polygonPointer, mesh }) => {
      const intersects = raycaster.intersectObject(mesh);

      if (intersects.length) {
        const { x, y } = intersects[0].point;

        polygonPointer.position.set(x, y, 0.5);
      } else {
        const { x, y } = closestPointInPolygon(

          points.map(({ x, y }) => ({
            x: x + position.x,
            y: y + position.y,
          })),
          { x: mouse.x, y: mouse.y },
        );
        polygonPointer.position.set(x, y, 0.5);
      }
    });

  }

  document.addEventListener('mousemove', ({ clientX, clientY }) => {
    mouse.x = (clientX / windowWidth * 100 - 50) * aspectRatio;
    mouse.y = -clientY / windowHeight * 100 + 50;
    normalizedMouse.x = ( clientX / windowWidth ) * 2 - 1;
    normalizedMouse.y = - ( clientY / windowHeight ) * 2 + 1;
  });

  loop();
};

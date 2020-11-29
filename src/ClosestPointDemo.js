/**
TODO:
*/ 
import 'regenerator-runtime/runtime.js';

import Stats from './stats.js';

import {
  WebGLRenderer,
  OrthographicCamera,
  Scene,
  Color,
  Shape,
  Mesh,
  ShapeGeometry,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  AmbientLight,
  SphereGeometry,
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Vector3,
  Vector2,
  Raycaster,
} from 'three';

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
  scene.background = new Color( 0xbfd1e5 );

  // const camera = new OrthographicCamera(width/-2, width/2, height/2, height/-2, 1, 1000);
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

  const polygonPointerMultiplier = 0.1;
  function createPolygonPointer(color, points) {
    const pointer = new Shape();

    pointer.moveTo(points[0].x * polygonPointerMultiplier, points[0].y * polygonPointerMultiplier);
    points.slice(1).forEach(({ x, y }) => {
      pointer.lineTo(x * polygonPointerMultiplier, y * polygonPointerMultiplier);
    });

    const polygonPointer = new Mesh(new ShapeGeometry(pointer), new MeshBasicMaterial({ color }));
    polygonPointer.position.set(0, 0, 0.5);

    scene.add(polygonPointer);

    return polygonPointer;
  }

  const shapes = [
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
        polygonPointer: createPolygonPointer(0xffff00, points),
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
        polygonPointer: createPolygonPointer(0xff00ff, points),
        mesh: null,
      };
    })()
  ];

  shapes.forEach((shape) => {
    const { points, position } = shape;
    const geometry = new BufferGeometry();
    const vertices = new Float32Array(points.reduce((a, { x, y }) => {
      a = a.concat([x, y, 0]);
      return a;
    }, []));

    geometry.addAttribute('position', new BufferAttribute(vertices, 3));

    const lineMesh = new Line(geometry, new LineBasicMaterial({
      color: 0xff3377,
      linewidth: 5,
      linecap: 'round',
      linejoin:  'round'
    }));

    // TODO: add comment
    const raycastTargetMesh = new Mesh(geometry, new MeshBasicMaterial({
      color: 0xaabbcc,
    }));

    lineMesh.position.set(position.x, position.y, 0);
    raycastTargetMesh.position.set(position.x, position.y, 0);

    shape.mesh = raycastTargetMesh;

    scene.add(lineMesh);
    scene.add(raycastTargetMesh);
  });

  // const closestPoint = new Mesh(new SphereGeometry(2, 8, 8), new MeshBasicMaterial({color: 0xff0000}));
  // closestPoint.position.x = 0;
  // closestPoint.position.y = 0;
  // closestPoint.position.z = 0;

  // scene.add(closestPoint);

  const light = new AmbientLight( 0x404040 ); // soft white light
  scene.add( light );

  // let useIntersects = false;
  // setTimeout(() => { useIntersects = true; }, 3000);

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

import * as THREE from 'three';
import { Player, World } from '../core/config';

/** How far the sun sits from its target; only affects shadow-frustum framing. */
const SUN_DISTANCE = 160;

/** Owns the WebGL context, scene graph root, camera and sky/sun lighting. */
export class RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  /**
   * Second pass drawn on top of the world with a narrower FOV. A first-person
   * weapon sits ~70 cm from the lens, where the world's 75° FOV makes it fill
   * the screen; giving it its own camera is the standard fix and also keeps it
   * out of the world's fog and shadow passes.
   */
  readonly overlayScene = new THREE.Scene();
  readonly overlayCamera: THREE.PerspectiveCamera;
  readonly sky: THREE.HemisphereLight;
  /** Unit vector from the target towards the sun. Owned here so that moving
   *  the shadow frustum never feeds back into the light direction. */
  readonly sunDirection = new THREE.Vector3(0.42, 0.78, 0.46).normalize();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // three resets render stats at the start of every render() call, so the
    // overlay pass would otherwise wipe the world pass's numbers and the debug
    // panel would report only the viewmodel. Reset once per frame instead.
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(
      Player.camera.fovDegrees,
      1,
      0.05,
      // Far plane has to clear the map diagonal so distant POIs stay visible.
      World.sizeMeters * 1.2,
    );
    this.camera.position.set(0, 3, 8);

    this.scene.background = new THREE.Color(0x8fb6d1);
    this.scene.fog = new THREE.FogExp2(0x8fb6d1, World.fog.clearDensity);

    this.sky = new THREE.HemisphereLight(0xbdd9f2, 0x4a4336, 1.1);
    this.scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xfff2df, 2.2);
    this.sun.position.copy(this.sunDirection).multiplyScalar(SUN_DISTANCE);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 400;
    // Shadow frustum is kept tight around the player and re-centred each frame
    // by the world system; a map-wide frustum would have useless resolution.
    const cam = this.sun.shadow.camera;
    cam.left = -70;
    cam.right = 70;
    cam.top = 70;
    cam.bottom = -70;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.overlayCamera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
    const overlayKey = new THREE.DirectionalLight(0xfff2df, 2.0);
    overlayKey.position.set(0.4, 1, 0.6);
    this.overlayScene.add(overlayKey);
    this.overlayScene.add(new THREE.HemisphereLight(0xbdd9f2, 0x4a4336, 1.4));

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /** Keeps the shadow frustum centred on the viewer so it stays useful. */
  followShadowTarget(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
    this.sun.position
      .copy(this.sunDirection)
      .multiplyScalar(SUN_DISTANCE)
      .add(this.sun.target.position);
  }

  /** Points the sun from a compass azimuth and elevation, both in radians. */
  setSunAngles(azimuth: number, elevation: number): void {
    this.sunDirection
      .set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth))
      .normalize();
  }

  readonly resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.overlayCamera.aspect = w / h;
    this.overlayCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  render(): void {
    this.renderer.info.reset();
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    if (this.overlayScene.children.length > 2) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.overlayScene, this.overlayCamera);
      this.renderer.autoClear = true;
    }
  }

  /** Overlay FOV, separate from the world's (which ADS also animates). */
  setOverlayFov(fov: number): void {
    if (Math.abs(this.overlayCamera.fov - fov) < 0.01) return;
    this.overlayCamera.fov = fov;
    this.overlayCamera.updateProjectionMatrix();
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
  }
}

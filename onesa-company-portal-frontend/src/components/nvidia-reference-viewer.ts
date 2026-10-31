import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

export type ReferenceState = 'loading' | 'ready' | 'failed' | 'unavailable';
export type ReferenceViewer = {dispose: () => void; fit: () => void; rotate: (degrees: number) => void};

/** Local visual assets only. This renderer has no product API access. */
export function createReferenceViewer(options: {
  host: HTMLDivElement; path: string; sha256: string; byteLength: number;
  onState: (state: ReferenceState) => void;
}): ReferenceViewer {
  const {host, onState} = options;
  const abort = new AbortController();
  let disposed = false, frame = 0;
  let model: THREE.Group | undefined;
  let renderer: THREE.WebGLRenderer;
  const disposeObject = (object: THREE.Object3D) => object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
    }
  });
  try {renderer = new THREE.WebGLRenderer({alpha: true, antialias: true, powerPreference: 'low-power'});}
  catch {onState('unavailable'); return {dispose() {disposed = true; abort.abort();}, fit() {}, rotate() {}};}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 0.7;
  const ambient = new THREE.HemisphereLight(0xffffff, 0x43516c, 2.4);
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(3, 6, 4);
  scene.add(ambient, key);
  const draw = () => {
    if (disposed || frame || renderer.getContext().isContextLost()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed && !renderer.getContext().isContextLost()) {
        try {renderer.render(scene, camera);} catch {onState('failed');}
      }
    });
  };
  controls.addEventListener('change', draw);
  const fit = () => {
    if (disposed) return;
    const width = Math.max(host.clientWidth, 1), height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height;
    renderer.setSize(width, height, false);
    const distance = 2.1 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(camera.aspect, 1);
    camera.position.set(distance * 0.72, distance * 0.48, distance * 0.9);
    camera.far = distance * 12;
    controls.target.set(0, 0, 0);
    controls.maxDistance = distance * 3;
    camera.updateProjectionMatrix(); controls.update(); draw();
  };
  const resize = new ResizeObserver(() => {
    if (disposed) return;
    camera.aspect = Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1);
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    camera.updateProjectionMatrix(); draw();
  });
  resize.observe(host);
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => {ambient.groundColor.set(dark.matches ? 0x43516c : 0xa7b1c1); draw();};
  dark.addEventListener('change', theme);
  const contextLost = (event: Event) => {event.preventDefault(); abort.abort(); if (!disposed) onState('failed');};
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  fit(); onState('loading');
  const deadline = window.setTimeout(() => abort.abort(), 15000);
  void (async () => {
    try {
      const response = await fetch(`/models/nvidia/${options.path}`, {signal: abort.signal, cache: 'force-cache', credentials: 'omit', redirect: 'error'});
      if (!response.ok || !response.body) throw new Error('Reference asset unavailable');
      const reader = response.body.getReader();
      const bytes = new Uint8Array(options.byteLength);
      let offset = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          if (offset + value.byteLength > bytes.byteLength) throw new Error('Reference asset size mismatch');
          bytes.set(value, offset); offset += value.byteLength;
        }
      } finally {await reader.cancel();}
      if (offset !== bytes.byteLength) throw new Error('Reference asset size mismatch');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== options.sha256) throw new Error('Reference asset integrity mismatch');
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
      if (disposed || abort.signal.aborted || renderer.getContext().isContextLost()) {
        disposeObject(gltf.scene);
        if (!disposed) onState('failed');
        return;
      }
      model = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(longest) || longest <= 0) throw new Error('Reference asset bounds invalid');
      model.position.sub(bounds.getCenter(new THREE.Vector3()));
      const pivot = new THREE.Group();
      pivot.add(model); pivot.scale.setScalar(3.6 / longest); scene.add(pivot); model = pivot;
      fit(); draw(); onState('ready');
    } catch {if (!disposed) onState('failed');}
    finally {clearTimeout(deadline);}
  })();
  return {
    fit,
    rotate(degrees) {if (model && !disposed) {model.rotation.y = THREE.MathUtils.degToRad(degrees); draw();}},
    dispose() {
      if (disposed) return;
      disposed = true; abort.abort(); clearTimeout(deadline); cancelAnimationFrame(frame);
      resize.disconnect(); dark.removeEventListener('change', theme);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      controls.removeEventListener('change', draw); controls.dispose();
      if (model) disposeObject(model);
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}

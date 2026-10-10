import type {
  DirectorStageCapture,
  DirectorStageCamera,
  DirectorStageSlot,
} from "@kachang/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

export type StageEntityTransform = {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
};

export type StageEntitySnapshot = StageEntityTransform & {
  id: string;
  label: string;
  kind: "actor" | "prop";
};

type EntityDragState = {
  pointerId: number;
  entityId: string;
  plane: THREE.Plane;
  offset: THREE.Vector3;
};

const ACTOR_COLORS = [0x3b8078, 0xc96f5d, 0xc39c3b, 0x58769c, 0x846a95, 0x607d60];
const PROP_COLORS = [0x9f8969, 0x748985, 0x986a60, 0x70778b, 0x8a806d];

export class DirectorStageRuntime {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly transformControls: TransformControls;

  private readonly canvas: HTMLCanvasElement;
  private readonly stageRoot = new THREE.Group();
  private readonly entityObjects = new Map<string, THREE.Object3D>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private selectionHelper: THREE.BoxHelper | null = null;
  private selectedEntityId: string | null = null;
  private dragState: EntityDragState | null = null;
  private animationFrame = 0;
  private disposed = false;
  private baseFov = 38;

  constructor(canvas: HTMLCanvasElement, dark: boolean) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(dark ? 0x151817 : 0xdce0dd);
    this.scene.fog = new THREE.Fog(dark ? 0x151817 : 0xdce0dd, 13, 32);

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 100);
    this.camera.position.set(0, 1.7, 5.8);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 26;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.target.set(0, 1, 0);

    this.transformControls = new TransformControls(this.camera, canvas);
    this.transformControls.setMode("translate");
    this.transformControls.setSpace("world");
    this.transformControls.setSize(0.78);
    this.transformControls.addEventListener("dragging-changed", this.onTransformDraggingChanged);
    this.scene.add(this.transformControls.getHelper());

    this.buildEnvironment(dark);
    this.scene.add(this.stageRoot);
    this.resize();
    this.renderLoop();
  }

  resize = () => {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = responsiveFov(this.baseFov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
  };

  applySlot(slot: DirectorStageSlot) {
    this.clearSelection();
    clearObject(this.stageRoot);
    this.entityObjects.clear();

    slot.subjects.forEach((pose, index) => {
      const id = `actor:${pose.id}`;
      const actor = createActor(index, id, pose.label);
      actor.position.set(pose.x, pose.y, pose.z);
      actor.rotation.y = THREE.MathUtils.degToRad(pose.rotation_y);
      actor.scale.setScalar(pose.scale);
      this.stageRoot.add(actor);
      this.entityObjects.set(id, actor);
    });

    slot.props.forEach((pose, index) => {
      const id = `prop:${pose.id}`;
      const prop = createProp(pose.label, index, id);
      prop.position.set(pose.x, pose.y, pose.z);
      prop.rotation.y = THREE.MathUtils.degToRad(pose.rotation_y);
      prop.scale.setScalar(pose.scale);
      this.stageRoot.add(prop);
      this.entityObjects.set(id, prop);
    });

    const target = stageTarget(slot);
    this.camera.position.set(slot.camera.x, slot.camera.y, slot.camera.z);
    this.baseFov = slot.camera.fov;
    this.camera.fov = responsiveFov(this.baseFov, this.camera.aspect);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.renderNow();
  }

  beginEntityDrag(event: PointerEvent) {
    if (event.button !== 0 || !this.updateRay(event)) return null;
    if (this.transformControls.axis || this.transformControls.dragging) return this.getSelectedEntity();
    const hit = this.raycaster.intersectObjects(Array.from(this.entityObjects.values()), true)[0]?.object;
    const entityId = findEntityId(hit);
    if (!entityId) {
      this.clearSelection();
      return null;
    }

    const object = this.entityObjects.get(entityId);
    if (!object) return null;
    const selected = this.selectEntity(entityId);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -object.position.y);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, point)) return selected;

    this.dragState = {
      pointerId: event.pointerId,
      entityId,
      plane,
      offset: point.sub(object.position),
    };
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return selected;
  }

  moveEntityDrag(event: PointerEvent) {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId || !this.updateRay(event)) return null;
    const object = this.entityObjects.get(drag.entityId);
    if (!object) return null;
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(drag.plane, point)) return null;
    object.position.x = point.x - drag.offset.x;
    object.position.z = point.z - drag.offset.z;
    this.selectionHelper?.update();
    event.preventDefault();
    return this.getEntity(drag.entityId);
  }

  endEntityDrag(event: PointerEvent) {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return null;
    const snapshot = this.getEntity(drag.entityId);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.dragState = null;
    this.controls.enabled = true;
    return snapshot;
  }

  cancelEntityDrag() {
    this.dragState = null;
    this.controls.enabled = true;
  }

  isDraggingEntity() {
    return this.dragState !== null;
  }

  selectEntity(id: string) {
    const object = this.entityObjects.get(id);
    if (!object) return null;
    this.clearSelection();
    const helper = new THREE.BoxHelper(object, 0xd6a08f);
    helper.material.transparent = true;
    helper.material.opacity = 0.82;
    helper.material.depthTest = false;
    helper.renderOrder = 20;
    this.scene.add(helper);
    this.selectionHelper = helper;
    this.selectedEntityId = id;
    this.transformControls.attach(object);
    return this.getEntity(id);
  }

  clearSelection() {
    this.transformControls.detach();
    this.selectedEntityId = null;
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      this.selectionHelper.material.dispose();
      this.selectionHelper = null;
    }
  }

  getSelectedEntity() {
    this.selectionHelper?.update();
    return this.selectedEntityId ? this.getEntity(this.selectedEntityId) : null;
  }

  updateEntity(id: string, transform: StageEntityTransform) {
    const object = this.entityObjects.get(id);
    if (!object) return null;
    object.position.set(transform.x, transform.y, transform.z);
    object.rotation.y = THREE.MathUtils.degToRad(transform.rotationY);
    object.scale.setScalar(transform.scale);
    this.selectionHelper?.update();
    this.renderNow();
    return this.getEntity(id);
  }

  getEntity(id: string): StageEntitySnapshot | null {
    const object = this.entityObjects.get(id);
    if (!object) return null;
    return {
      id,
      label: typeof object.userData.entityLabel === "string" ? object.userData.entityLabel : id.replace(/^(actor|prop):/, ""),
      kind: id.startsWith("actor:") ? "actor" : "prop",
      x: object.position.x,
      y: object.position.y,
      z: object.position.z,
      rotationY: THREE.MathUtils.radToDeg(object.rotation.y),
      scale: object.scale.x,
    };
  }

  getCamera(): DirectorStageCamera {
    return {
      shot_size: "",
      angle: "",
      movement: "",
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
      fov: this.baseFov,
    };
  }

  capture(slot: DirectorStageSlot): DirectorStageCapture {
    const previousWidth = Math.max(1, this.canvas.clientWidth);
    const previousHeight = Math.max(1, this.canvas.clientHeight);
    const previousRatio = Math.min(2, window.devicePixelRatio || 1);

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(1280, 720, false);
    this.camera.aspect = 16 / 9;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.canvas.toDataURL("image/png");

    this.renderer.setPixelRatio(previousRatio);
    this.renderer.setSize(previousWidth, previousHeight, false);
    this.camera.aspect = previousWidth / previousHeight;
    this.camera.fov = responsiveFov(this.baseFov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.renderNow();

    return {
      shotId: slot.shot_id,
      slot: slot.slot,
      title: slot.dramatic_function,
      prompt: slot.compressed_video_prompt || slot.beat || slot.dramatic_function,
      dataUrl,
      width: 1280,
      height: 720,
    };
  }

  renderNow() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.cancelEntityDrag();
    this.clearSelection();
    clearObject(this.stageRoot);
    this.controls.dispose();
    this.transformControls.removeEventListener("dragging-changed", this.onTransformDraggingChanged);
    this.transformControls.dispose();
    this.scene.traverse(disposeRenderable);
    this.renderer.dispose();
  }

  private renderLoop = () => {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.renderLoop);
  };

  private updateRay(event: PointerEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  private onTransformDraggingChanged = (event: { value?: unknown }) => {
    this.controls.enabled = !Boolean(event.value);
  };

  private buildEnvironment(dark: boolean) {
    this.scene.add(new THREE.HemisphereLight(dark ? 0xdce8e4 : 0xffffff, dark ? 0x1a211f : 0x8b9691, 2.2));

    const key = new THREE.DirectionalLight(0xfff3df, 3.25);
    key.position.set(4.5, 8, 5.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x94d0c7, 1.4);
    rim.position.set(-5, 3.5, -4);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(32, 32),
      new THREE.MeshStandardMaterial({
        color: dark ? 0x262b29 : 0xc9cecb,
        roughness: 0.84,
        metalness: 0.03,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 12),
      new THREE.MeshStandardMaterial({ color: dark ? 0x1d2220 : 0xe7e9e7, roughness: 0.96 }),
    );
    backWall.position.set(0, 5.8, -7);
    backWall.receiveShadow = true;
    this.scene.add(backWall);

    const grid = new THREE.GridHelper(24, 24, dark ? 0x53635f : 0x82908b, dark ? 0x323b38 : 0xaeb7b3);
    grid.position.y = 0.008;
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = dark ? 0.28 : 0.4;
    });
    this.scene.add(grid);
  }
}

function createActor(index: number, entityId: string, label: string) {
  const color = ACTOR_COLORS[index % ACTOR_COLORS.length];
  const clothing = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.06 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xdfb79c, roughness: 0.72 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x29302e, roughness: 0.66 });
  const group = entityGroup(entityId, label);

  group.add(mesh(new THREE.CapsuleGeometry(0.29, 0.62, 6, 12), clothing, 1.18));
  group.add(mesh(new THREE.SphereGeometry(0.23, 24, 16), skin, 1.82));
  group.add(mesh(new THREE.BoxGeometry(0.48, 0.22, 0.3), dark, 0.74));
  [-1, 1].forEach((side) => {
    const arm = mesh(new THREE.CapsuleGeometry(0.085, 0.48, 4, 8), clothing, 1.2);
    arm.position.x = side * 0.38;
    arm.rotation.z = side * 0.08;
    group.add(arm);
    const leg = mesh(new THREE.CapsuleGeometry(0.105, 0.54, 4, 8), dark, 0.37);
    leg.position.x = side * 0.15;
    group.add(leg);
  });

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.48, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.74, side: THREE.DoubleSide }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.014;
  group.add(marker);
  markEntity(group, entityId);
  return group;
}

function createProp(label: string, index: number, entityId: string) {
  const material = new THREE.MeshStandardMaterial({
    color: PROP_COLORS[index % PROP_COLORS.length],
    roughness: 0.74,
    metalness: 0.025,
  });
  const group = entityGroup(entityId, label);
  const lower = label.toLowerCase();

  if (/桌|table/.test(lower)) addTable(group, material);
  else if (/椅|chair/.test(lower)) addChair(group, material);
  else if (/沙发|sofa/.test(lower)) addSofa(group, material);
  else if (/床|bed/.test(lower)) addBed(group, material);
  else if (/门|door/.test(lower)) group.add(mesh(new THREE.BoxGeometry(1.05, 2.2, 0.12), material, 1.1));
  else if (/窗|window/.test(lower)) addWindow(group, material);
  else if (/灯|lamp/.test(lower)) addLamp(group, material);
  else group.add(mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), material, 0.36));

  markEntity(group, entityId);
  return group;
}

function addTable(group: THREE.Group, material: THREE.Material) {
  group.add(mesh(new THREE.BoxGeometry(1.35, 0.12, 0.72), material, 0.78));
  [-0.52, 0.52].forEach((x) => [-0.24, 0.24].forEach((z) => {
    const leg = mesh(new THREE.BoxGeometry(0.09, 0.72, 0.09), material, 0.36);
    leg.position.set(x, leg.position.y, z);
    group.add(leg);
  }));
}

function addChair(group: THREE.Group, material: THREE.Material) {
  group.add(mesh(new THREE.BoxGeometry(0.64, 0.1, 0.64), material, 0.5));
  const back = mesh(new THREE.BoxGeometry(0.64, 0.82, 0.1), material, 0.9);
  back.position.z = -0.27;
  group.add(back);
  [-0.24, 0.24].forEach((x) => [-0.24, 0.24].forEach((z) => {
    const leg = mesh(new THREE.BoxGeometry(0.07, 0.45, 0.07), material, 0.225);
    leg.position.set(x, leg.position.y, z);
    group.add(leg);
  }));
}

function addSofa(group: THREE.Group, material: THREE.Material) {
  group.add(mesh(new THREE.BoxGeometry(1.8, 0.42, 0.72), material, 0.34));
  const back = mesh(new THREE.BoxGeometry(1.8, 0.76, 0.22), material, 0.76);
  back.position.z = -0.29;
  group.add(back);
  [-0.82, 0.82].forEach((x) => {
    const arm = mesh(new THREE.BoxGeometry(0.18, 0.58, 0.72), material, 0.48);
    arm.position.x = x;
    group.add(arm);
  });
}

function addBed(group: THREE.Group, material: THREE.Material) {
  group.add(mesh(new THREE.BoxGeometry(1.5, 0.34, 2.05), material, 0.32));
  const head = mesh(new THREE.BoxGeometry(1.5, 0.95, 0.14), material, 0.62);
  head.position.z = -0.96;
  group.add(head);
}

function addWindow(group: THREE.Group, material: THREE.Material) {
  const frame = new THREE.Group();
  const top = mesh(new THREE.BoxGeometry(1.55, 0.1, 0.1), material, 1.72);
  const bottom = mesh(new THREE.BoxGeometry(1.55, 0.1, 0.1), material, 0.42);
  frame.add(top, bottom);
  [-0.72, 0, 0.72].forEach((x) => {
    const bar = mesh(new THREE.BoxGeometry(0.08, 1.3, 0.1), material, 1.07);
    bar.position.x = x;
    frame.add(bar);
  });
  group.add(frame);
}

function addLamp(group: THREE.Group, material: THREE.Material) {
  group.add(mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.08, 24), material, 0.04));
  group.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 12), material, 0.68));
  group.add(mesh(new THREE.ConeGeometry(0.34, 0.48, 24, 1, true), material, 1.48));
}

function entityGroup(entityId: string, label: string) {
  const group = new THREE.Group();
  group.userData.entityId = entityId;
  group.userData.entityLabel = label;
  return group;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, y: number) {
  const result = new THREE.Mesh(geometry, material);
  result.position.y = y;
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function markEntity(root: THREE.Object3D, entityId: string) {
  root.traverse((child) => {
    child.userData.entityId = entityId;
  });
}

function findEntityId(object?: THREE.Object3D) {
  let current = object;
  while (current) {
    if (typeof current.userData.entityId === "string") return current.userData.entityId as string;
    current = current.parent || undefined;
  }
  return "";
}

function stageTarget(slot: DirectorStageSlot) {
  const entities = [...slot.subjects, ...slot.props];
  if (!entities.length) return new THREE.Vector3(0, 1, 0);
  const x = entities.reduce((sum, item) => sum + item.x, 0) / entities.length;
  const z = entities.reduce((sum, item) => sum + item.z, 0) / entities.length;
  return new THREE.Vector3(x, slot.subjects.length ? 1.15 : 0.65, z);
}

function responsiveFov(baseFov: number, aspect: number) {
  const referenceAspect = 16 / 9;
  if (aspect >= referenceAspect) return baseFov;
  const vertical = THREE.MathUtils.degToRad(baseFov);
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * referenceAspect);
  const adapted = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(horizontal / 2) / Math.max(0.2, aspect)));
  return Math.min(100, Math.max(baseFov, adapted));
}

function clearObject(root: THREE.Object3D) {
  root.children.slice().forEach((child) => {
    root.remove(child);
    child.traverse(disposeRenderable);
  });
}

function disposeRenderable(item: THREE.Object3D) {
  const renderable = item as THREE.Mesh;
  renderable.geometry?.dispose?.();
  const materials = Array.isArray(renderable.material)
    ? renderable.material
    : renderable.material
      ? [renderable.material]
      : [];
  materials.forEach((material) => material.dispose());
}

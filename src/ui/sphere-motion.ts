export interface SphereCamera {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface SpherePointerSample {
  x: number;
  y: number;
  time: number;
}

interface ActiveDrag {
  pointerId: number;
  start: SpherePointerSample;
  last: SpherePointerSample;
  moved: boolean;
  velocityYaw: number;
  velocityPitch: number;
}

export type DragCompletion = "click" | "drag" | "none";

export const SPHERE_INITIAL_CAMERA: SphereCamera = { yaw: -0.42, pitch: -0.16, zoom: 1 };
export const SPHERE_MIN_ZOOM = 0.62;
export const SPHERE_MAX_ZOOM = 1.55;
export const SPHERE_DRAG_THRESHOLD_PX = 5;
export const SPHERE_IDLE_YAW_SPEED = 0.055;

const RADIANS_PER_PIXEL = 0.008;
const MAX_ANGULAR_SPEED = 3.6;
const INERTIA_DAMPING = 2.8;
const RELEASE_HOLD_DAMPING = 5;
const VELOCITY_RESPONSE = 18;
const MIN_SAMPLE_SECONDS = 1 / 240;
const MAX_FRAME_SECONDS = 0.05;
const MIN_PITCH = -1.35;
const MAX_PITCH = 1.35;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeAngle(value: number): number {
  const turn = Math.PI * 2;
  return ((value + Math.PI) % turn + turn) % turn - Math.PI;
}

function copyCamera(camera: SphereCamera): SphereCamera {
  return { yaw: camera.yaw, pitch: camera.pitch, zoom: camera.zoom };
}

function maxVelocity(yaw: number, pitch: number): number {
  return Math.max(Math.abs(yaw), Math.abs(pitch));
}

/** Owns transient camera motion without placing per-frame values in React state. */
export class SphereMotionController {
  readonly camera: SphereCamera;
  private drag: ActiveDrag | null = null;
  private velocityYaw = 0;
  private velocityPitch = 0;
  private idleDirection: -1 | 1 = 1;

  constructor(initialCamera: SphereCamera = SPHERE_INITIAL_CAMERA) {
    this.camera = copyCamera(initialCamera);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  get activePointerId(): number | null {
    return this.drag?.pointerId ?? null;
  }

  get hasInertia(): boolean {
    return maxVelocity(this.velocityYaw, this.velocityPitch) > SPHERE_IDLE_YAW_SPEED;
  }

  beginDrag(pointerId: number, sample: SpherePointerSample): void {
    this.stopMotion();
    this.drag = {
      pointerId,
      start: sample,
      last: sample,
      moved: false,
      velocityYaw: 0,
      velocityPitch: 0,
    };
  }

  updateDrag(pointerId: number, sample: SpherePointerSample): boolean {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== pointerId) return false;

    let deltaX: number;
    let deltaY: number;
    let elapsedSeconds: number;
    const firstMotion = !drag.moved;
    if (firstMotion) {
      deltaX = sample.x - drag.start.x;
      deltaY = sample.y - drag.start.y;
      if (Math.hypot(deltaX, deltaY) < SPHERE_DRAG_THRESHOLD_PX) return false;
      elapsedSeconds = Math.max(MIN_SAMPLE_SECONDS, (sample.time - drag.start.time) / 1_000);
      drag.moved = true;
    } else {
      deltaX = sample.x - drag.last.x;
      deltaY = sample.y - drag.last.y;
      if (deltaX === 0 && deltaY === 0) return false;
      elapsedSeconds = Math.max(MIN_SAMPLE_SECONDS, (sample.time - drag.last.time) / 1_000);
    }

    this.camera.yaw = normalizeAngle(this.camera.yaw + deltaX * RADIANS_PER_PIXEL);
    this.camera.pitch = clamp(this.camera.pitch + deltaY * RADIANS_PER_PIXEL, MIN_PITCH, MAX_PITCH);

    const sampledYaw = clamp(deltaX * RADIANS_PER_PIXEL / elapsedSeconds, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
    const sampledPitch = clamp(deltaY * RADIANS_PER_PIXEL / elapsedSeconds, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
    if (firstMotion) {
      drag.velocityYaw = sampledYaw;
      drag.velocityPitch = sampledPitch;
    } else {
      const response = 1 - Math.exp(-VELOCITY_RESPONSE * elapsedSeconds);
      drag.velocityYaw += (sampledYaw - drag.velocityYaw) * response;
      drag.velocityPitch += (sampledPitch - drag.velocityPitch) * response;
    }
    drag.last = sample;
    return true;
  }

  endDrag(pointerId: number, sample?: SpherePointerSample): DragCompletion {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== pointerId) return "none";
    if (sample !== undefined && (sample.x !== drag.last.x || sample.y !== drag.last.y)) {
      this.updateDrag(pointerId, sample);
    }
    this.drag = null;
    if (!drag.moved) {
      this.stopMotion();
      return "click";
    }

    const releaseTime = sample?.time ?? drag.last.time;
    const heldSeconds = Math.max(0, (releaseTime - drag.last.time) / 1_000);
    const releaseDecay = Math.exp(-RELEASE_HOLD_DAMPING * heldSeconds);
    this.velocityYaw = drag.velocityYaw * releaseDecay;
    this.velocityPitch = drag.velocityPitch * releaseDecay;
    if (Math.abs(this.velocityYaw) > SPHERE_IDLE_YAW_SPEED) {
      this.idleDirection = this.velocityYaw < 0 ? -1 : 1;
    }
    if (!this.hasInertia) this.stopMotion();
    return "drag";
  }

  /** Pointer/host interruption retains the last visible camera instead of snapping back. */
  cancelDrag(): boolean {
    if (this.drag === null) return false;
    this.drag = null;
    this.stopMotion();
    return true;
  }

  stopMotion(): void {
    this.velocityYaw = 0;
    this.velocityPitch = 0;
  }

  rotate(deltaYaw: number, deltaPitch: number): void {
    this.stopMotion();
    this.camera.yaw = normalizeAngle(this.camera.yaw + deltaYaw);
    this.camera.pitch = clamp(this.camera.pitch + deltaPitch, MIN_PITCH, MAX_PITCH);
    if (Math.abs(deltaYaw) > 0) this.idleDirection = deltaYaw < 0 ? -1 : 1;
  }

  setZoom(zoom: number): number {
    this.camera.zoom = clamp(zoom, SPHERE_MIN_ZOOM, SPHERE_MAX_ZOOM);
    return this.camera.zoom;
  }

  reset(): void {
    this.drag = null;
    this.stopMotion();
    Object.assign(this.camera, SPHERE_INITIAL_CAMERA);
    this.idleDirection = 1;
  }

  /** Advances inertia first, then the subtle idle drift in the last horizontal direction. */
  advance(elapsedSeconds: number, idlePaused: boolean): boolean {
    if (this.drag !== null) return false;
    const seconds = clamp(elapsedSeconds, 0, MAX_FRAME_SECONDS);
    if (seconds === 0) return false;

    if (this.hasInertia) {
      this.camera.yaw = normalizeAngle(this.camera.yaw + this.velocityYaw * seconds);
      const nextPitch = clamp(this.camera.pitch + this.velocityPitch * seconds, MIN_PITCH, MAX_PITCH);
      if (nextPitch === MIN_PITCH || nextPitch === MAX_PITCH) this.velocityPitch = 0;
      this.camera.pitch = nextPitch;
      const decay = Math.exp(-INERTIA_DAMPING * seconds);
      this.velocityYaw *= decay;
      this.velocityPitch *= decay;
      if (!this.hasInertia) this.stopMotion();
      return true;
    }

    if (idlePaused) return false;
    this.camera.yaw = normalizeAngle(this.camera.yaw + this.idleDirection * SPHERE_IDLE_YAW_SPEED * seconds);
    return true;
  }

  wantsAnimation(idlePaused: boolean): boolean {
    return this.drag === null && (this.hasInertia || !idlePaused);
  }
}

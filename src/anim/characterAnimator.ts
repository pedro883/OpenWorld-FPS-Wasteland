import * as THREE from 'three';

/**
 * Two-layer character animation: legs from one clip, upper body from another.
 *
 * A crouch clip is a whole-body clip — it animates the arms as much as the
 * legs. Playing it on an NPC holding a rifle threw the arms wide open, because
 * the crouch's arm tracks simply overwrote the weapon pose. Splitting each clip
 * by bone fixes that at the source: the legs take the crouch, the arms take the
 * aim, and because the two track sets are disjoint they compose without any
 * blend weights to balance.
 *
 * The hips stay in the lower layer, so crouching still lowers the whole body —
 * the upper layer only ever overrides rotations further up the chain.
 */

/** Spine and up, both arms, hands and fingers. Everything else is the legs. */
const UPPER_BODY = /^(Spine|Chest|UpperChest|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand))/;

export type BodyLayer = 'upper' | 'lower';

/**
 * Merging four bodies into one GLB collides their bone names, so the pipeline
 * suffixes them: `Hips` becomes `Hips_2`. Clips keep whatever suffix their own
 * body got, which means a clip only binds to the body it was exported with —
 * every other body silently falls back to its bind pose, arms wide open.
 * Matching on the bare name and rebinding sidesteps that entirely.
 */
const MERGE_SUFFIX = /_\d+$/;

function baseName(name: string): string {
  return name.replace(MERGE_SUFFIX, '');
}

/** Finds a node by its pre-merge name, e.g. `RightHand` in a `RightHand_2`. */
export function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (!found && baseName(obj.name) === name) found = obj;
  });
  return found;
}

/** Rewrites a clip's track names onto the bones this particular model has. */
function retarget(clip: THREE.AnimationClip, root: THREE.Object3D): THREE.AnimationClip {
  const byBase = new Map<string, string>();
  root.traverse((obj) => {
    if (obj.name) byBase.set(baseName(obj.name), obj.name);
  });

  let changed = false;
  const tracks = clip.tracks.map((track) => {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) return track;
    const node = track.name.slice(0, dot);
    const actual = byBase.get(baseName(node));
    if (!actual || actual === node) return track;
    changed = true;
    const copy = track.clone();
    copy.name = `${actual}${track.name.slice(dot)}`;
    return copy;
  });
  if (!changed) return clip;
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  out.blendMode = clip.blendMode;
  return out;
}

function boneOf(trackName: string): string {
  const dot = trackName.lastIndexOf('.');
  const name = dot < 0 ? trackName : trackName.slice(0, dot);
  // Tracks are `bone.property`, but a bone reached through a path keeps slashes.
  const slash = name.lastIndexOf('/');
  return slash < 0 ? name : name.slice(slash + 1);
}

/** A copy of `clip` carrying only the tracks that belong to `layer`. */
export function maskClip(clip: THREE.AnimationClip, layer: BodyLayer): THREE.AnimationClip {
  const wantUpper = layer === 'upper';
  const tracks = clip.tracks.filter((t) => UPPER_BODY.test(boneOf(t.name)) === wantUpper);
  const masked = new THREE.AnimationClip(`${clip.name}:${layer}`, clip.duration, tracks);
  masked.blendMode = clip.blendMode;
  return masked;
}

/**
 * A single-keyframe clip holding the first frame of `clip`.
 *
 * The pack has no "rifle at the ready" clip, only `shoot`. Its opening frame is
 * exactly that pose, so freezing it gives an armed idle without inventing an
 * animation — and without a character who fires continuously while standing.
 */
export function poseFromClip(clip: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    const stride = track.getValueSize();
    const Ctor = track.constructor as new (
      name: string,
      times: ArrayLike<number>,
      values: ArrayLike<number>,
    ) => THREE.KeyframeTrack;
    return new Ctor(track.name, [0], Array.from(track.values.slice(0, stride)));
  });
  return new THREE.AnimationClip(name, -1, tracks);
}

/**
 * The opening slice of a clip, as its own clip.
 *
 * Kenney's `shoot` is a full second in which the arm swings the weapon up to
 * vertical and back down — fine for a thrown grenade, wrong for a rifle, which
 * would spend half its burst pointing at the sky. Only the first fraction reads
 * as recoil, and ping-ponged it kicks and settles for as long as the trigger is
 * held.
 */
export function trimClip(
  clip: THREE.AnimationClip,
  seconds: number,
  name: string,
): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    const stride = track.getValueSize();
    let count = 0;
    while (count < track.times.length && track.times[count]! <= seconds) count++;
    // Always keep the opening keyframe: a track trimmed to nothing would drop
    // its bone back to the bind pose.
    count = Math.max(count, 1);
    if (count === track.times.length) return track.clone();
    const Ctor = track.constructor as new (
      name: string,
      times: ArrayLike<number>,
      values: ArrayLike<number>,
    ) => THREE.KeyframeTrack;
    return new Ctor(
      track.name,
      Array.from(track.times.slice(0, count)),
      Array.from(track.values.slice(0, count * stride)),
    );
  });
  return new THREE.AnimationClip(name, seconds, tracks);
}

/** How long of `shoot` still points the barrel where the character is looking. */
const RECOIL_SECONDS = 0.1;

interface LayerState {
  current: string;
  action: THREE.AnimationAction | null;
}

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly source = new Map<string, THREE.AnimationClip>();
  /** Masked clips are derived once and reused; keyed `<clip>:<layer>`. */
  private readonly masked = new Map<string, THREE.AnimationClip>();
  private readonly layers: Record<BodyLayer, LayerState> = {
    upper: { current: '', action: null },
    lower: { current: '', action: null },
  };
  /** While a one-shot like `die` runs, the layers stop being driven. */
  private locked = false;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) this.source.set(clip.name, retarget(clip, root));
    const shoot = this.source.get('shoot');
    if (shoot) {
      this.source.set('aim', poseFromClip(shoot, 'aim'));
      this.source.set('fire', trimClip(shoot, RECOIL_SECONDS, 'fire'));
    }
  }

  get has(): boolean {
    return this.source.size > 0;
  }

  hasClip(name: string): boolean {
    return this.source.has(name);
  }

  private clipFor(name: string, layer: BodyLayer): THREE.AnimationClip | null {
    const key = `${name}:${layer}`;
    const cached = this.masked.get(key);
    if (cached) return cached;
    const source = this.source.get(name);
    if (!source) return null;
    const clip = maskClip(source, layer);
    this.masked.set(key, clip);
    return clip;
  }

  /**
   * Drives both layers. `upper` defaults to `lower`, which reproduces a plain
   * whole-body animation for anyone not holding anything.
   */
  set(lower: string, upper: string = lower, fade = 0.18): void {
    if (this.locked) return;
    this.playLayer('lower', lower, fade);
    this.playLayer('upper', upper, fade);
  }

  private playLayer(layer: BodyLayer, name: string, fade: number): void {
    const state = this.layers[layer];
    if (state.current === name) return;
    const clip = this.clipFor(name, layer);
    if (!clip) return;
    const next = this.mixer.clipAction(clip);
    // The recoil slice runs back and forth; everything else simply loops.
    next.setLoop(name === 'fire' ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
    next.reset().setEffectiveWeight(1).play();
    // `crossFadeFrom` needs the outgoing action to still be running; when it is
    // not, fading from it leaves both near zero weight and the skeleton snaps
    // back to its bind pose.
    if (state.action?.isRunning()) next.crossFadeFrom(state.action, fade, false);
    state.action = next;
    state.current = name;
  }

  /** Plays a whole-body clip once and holds the last frame, e.g. a death. */
  once(name: string, fade = 0.15): void {
    const clip = this.source.get(name);
    if (!clip) return;
    this.locked = true;
    const action = this.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    const previous = this.layers.lower.action ?? this.layers.upper.action;
    if (previous?.isRunning()) action.crossFadeFrom(previous, fade, false);
    action.play();
    this.layers.lower.action = action;
    this.layers.upper.action = null;
    this.layers.lower.current = name;
    this.layers.upper.current = '';
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
  }
}

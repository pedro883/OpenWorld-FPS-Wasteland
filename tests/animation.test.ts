import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { maskClip, poseFromClip, trimClip } from '../src/anim/characterAnimator';

/** A stand-in for a Kenney whole-body clip: hips and legs plus spine and arms. */
function wholeBodyClip(): THREE.AnimationClip {
  const times = [0, 0.5, 1];
  const quat = (a: number, b: number) => [0, 0, 0, 1, 0, a, 0, b, 0, 0, 0, 1];
  return new THREE.AnimationClip('crouch-idle', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', times, [0, 1, 0, 0, 0.6, 0, 0, 1, 0]),
    new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', times, quat(0.4, 0.7)),
    new THREE.QuaternionKeyframeTrack('RightUpLeg.quaternion', times, quat(0.4, 0.7)),
    new THREE.QuaternionKeyframeTrack('LeftFoot.quaternion', times, quat(0.1, 0.2)),
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', times, quat(0.2, 0.3)),
    new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', times, quat(0.9, 0.9)),
    new THREE.QuaternionKeyframeTrack('RightForeArm.quaternion', times, quat(0.9, 0.9)),
    new THREE.QuaternionKeyframeTrack('RightHandIndex1.quaternion', times, quat(0.1, 0.1)),
    new THREE.QuaternionKeyframeTrack('Head.quaternion', times, quat(0.1, 0.1)),
  ]);
}

describe('máscara de corpo', () => {
  it('manda pernas e quadril para a camada de baixo', () => {
    const names = maskClip(wholeBodyClip(), 'lower').tracks.map((t) => t.name);
    expect(names).toEqual([
      'Hips.position',
      'LeftUpLeg.quaternion',
      'RightUpLeg.quaternion',
      'LeftFoot.quaternion',
    ]);
  });

  it('manda coluna, braços, mãos e cabeça para a camada de cima', () => {
    const names = maskClip(wholeBodyClip(), 'upper').tracks.map((t) => t.name);
    expect(names).toEqual([
      'Spine.quaternion',
      'LeftArm.quaternion',
      'RightForeArm.quaternion',
      'RightHandIndex1.quaternion',
      'Head.quaternion',
    ]);
  });

  it('não perde nem duplica nenhuma track entre as duas camadas', () => {
    const clip = wholeBodyClip();
    const lower = maskClip(clip, 'lower').tracks.length;
    const upper = maskClip(clip, 'upper').tracks.length;
    expect(lower + upper).toBe(clip.tracks.length);
  });

  it('mantém o quadril embaixo, para o agachamento descer o corpo inteiro', () => {
    // If the hips travelled with the upper layer, an aiming pose would cancel
    // the crouch and the NPC would stand back up while still crouching its legs.
    const lower = maskClip(wholeBodyClip(), 'lower');
    expect(lower.tracks.some((t) => t.name === 'Hips.position')).toBe(true);
  });

  it('congela uma pose de um frame preservando o valor inicial', () => {
    const pose = poseFromClip(wholeBodyClip(), 'aim');
    expect(pose.name).toBe('aim');
    for (const track of pose.tracks) {
      expect(track.times.length).toBe(1);
    }
    const arm = pose.tracks.find((t) => t.name === 'LeftArm.quaternion')!;
    expect(Array.from(arm.values)).toEqual([0, 0, 0, 1]);
  });

  it('a pose congelada cobre os mesmos ossos do clip de origem', () => {
    // A pose that dropped tracks would let those bones snap back to the bind
    // pose — which is exactly the arms-wide-open bug this replaces.
    const clip = wholeBodyClip();
    const pose = poseFromClip(clip, 'aim');
    expect(pose.tracks.map((t) => t.name)).toEqual(clip.tracks.map((t) => t.name));
  });
});

describe('recorte do recuo', () => {
  it('mantém só os keyframes iniciais e preserva todas as tracks', () => {
    const clip = wholeBodyClip();
    const fire = trimClip(clip, 0.4, 'fire');
    expect(fire.name).toBe('fire');
    expect(fire.duration).toBe(0.4);
    expect(fire.tracks.length).toBe(clip.tracks.length);
    for (const track of fire.tracks) {
      expect(track.times.length).toBe(1);
      expect(track.times[0]).toBe(0);
    }
  });

  it('nunca deixa uma track vazia, mesmo cortando antes do primeiro frame', () => {
    // An emptied track would drop its bone to the bind pose mid-burst.
    const fire = trimClip(wholeBodyClip(), 0, 'fire');
    for (const track of fire.tracks) expect(track.times.length).toBeGreaterThan(0);
  });

  it('mantém os valores do frame de origem', () => {
    const clip = wholeBodyClip();
    const fire = trimClip(clip, 0.4, 'fire');
    const hips = fire.tracks.find((t) => t.name === 'Hips.position')!;
    expect(Array.from(hips.values)).toEqual([0, 1, 0]);
  });
});

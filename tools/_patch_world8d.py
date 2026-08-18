import io

p = 'src/scenes/world.ts'
s = io.open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, 'nao encontrado: ' + old[:80]
    assert s.count(old) == 1, 'ambiguo: ' + old[:80]
    s = s.replace(old, new, 1)


# ---- impacto e explosão ----
rep(
    """    this.ballistics.onImpact = (e) => {
      this.effects.handleImpact(e);""",
    """    this.ballistics.onImpact = (e) => {
      this.effects.handleImpact(e);
      this.audio.impact(e.point, e.material);""",
)

rep(
    "    this.ballistics.onExplosion = this.explosions.handle;",
    """    this.ballistics.onExplosion = (e) => {
      this.audio.explosion(e.point);
      this.explosions.handle(e);
    };""",
)

# ---- crack-thump: a passagem já é detectada para supressão ----
rep(
    """  private applySuppression(from: THREE.Vector3, to: THREE.Vector3, shooter: unknown): void {
    const segment = to.clone().sub(from);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 1e-6) return;""",
    """  private applySuppression(from: THREE.Vector3, to: THREE.Vector3, shooter: unknown): void {
    const segment = to.clone().sub(from);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 1e-6) return;
    // A round going past the player is the other half of a crack-thump: the
    // segment we already have is exactly where it passed.
    if (shooter !== this.player) this.playerCrackThump(from, to, segment, lengthSq);""",
)

# ---- helper de crack-thump + som de tiro ----
rep(
    "  /** Chase or cockpit camera while riding; on foot this does nothing.",
    """  /** How close a round came to the player's ear, and how far the shooter was. */
  private playerCrackThump(
    from: THREE.Vector3,
    to: THREE.Vector3,
    segment: THREE.Vector3,
    lengthSq: number,
  ): void {
    const ear = this.player.controller.eyePosition;
    const earVec = new THREE.Vector3(ear.x, ear.y, ear.z);
    const t = THREE.MathUtils.clamp(earVec.clone().sub(from).dot(segment) / lengthSq, 0, 1);
    const closest = from.clone().addScaledVector(segment, t);
    const miss = closest.distanceTo(earVec);
    if (miss > 8) return;
    this.audio.crackThump(closest, miss, from.distanceTo(earVec));
    // Being shot at is contact as far as the music is concerned.
    this.audio.reportContact();
  }

  /** Open ground, trees or walls — what the shot's tail should sound like. */
  private shotEnvironment(): ShotEnvironment {
    const p = this.player.position;
    if (this.layout.pois.some((poi) => Math.hypot(p.x - poi.x, p.z - poi.z) < poi.radius * 0.6)) {
      return 'interior';
    }
    return this.terrain.biomeAt(p.x, p.z) === 'floresta' ? 'floresta' : 'aberto';
  }

  /** Chase or cockpit camera while riding; on foot this does nothing.""",
)

# ---- tiro do jogador ----
rep(
    """    if (recoil) {
      this.player.pitch = Math.min(this.player.pitch + recoil.pitch, Math.PI / 2 - 0.02);
      this.player.yaw += recoil.yaw;
      this.viewmodel.addRecoil(recoil.pitch * 1.6, recoil.yaw * 1.6);
      this.muzzle.trigger(this.viewmodel.muzzleWorld());
    }""",
    """    if (recoil) {
      this.player.pitch = Math.min(this.player.pitch + recoil.pitch, Math.PI / 2 - 0.02);
      this.player.yaw += recoil.yaw;
      this.viewmodel.addRecoil(recoil.pitch * 1.6, recoil.yaw * 1.6);
      this.muzzle.trigger(this.viewmodel.muzzleWorld());
      this.audio.shot(origin, weapon.def.class, this.shotEnvironment(), 0, true);
    }""",
)

# ---- tiro dos NPCs ----
rep(
    """      for (const npc of this.npcs) {
        if (npc.isAlive) npc.hearGunshot(target.eyePosition, weapon.def.noiseRadiusMeters);
      }""",
    """      for (const npc of this.npcs) {
        if (npc.isAlive) npc.hearGunshot(target.eyePosition, weapon.def.noiseRadiusMeters);
      }""",
)

# ---- passos, ambiente, música e motor no frame ----
rep(
    "    for (const vehicle of this.vehicles) vehicle.frame();",
    """    // Footsteps come from the actual travelled speed, so they stay in step with
    // the legs whether the player is walking, sprinting or sliding down a slope.
    const p = this.player.position;
    this.audio.footsteps(
      dt,
      p,
      this.ridingVehicle ? 0 : this.player.speed,
      this.terrain.biomeAt(p.x, p.z),
      this.player.isGrounded,
    );
    this.audio.update(dt, this.ctx.render.camera);

    this.ambienceTimer -= dt;
    if (this.ambienceTimer <= 0) {
      this.ambienceTimer = 2;
      void this.audio.setAmbience(this.terrain.biomeAt(p.x, p.z), this.cycle.isNight);
      void this.audio.updateMusic();
    }

    for (const vehicle of this.vehicles) vehicle.frame();""",
)

io.open(p, 'w', encoding='utf-8').write(s)
print('audio ligado nos eventos')

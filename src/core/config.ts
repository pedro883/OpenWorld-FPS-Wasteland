import worldConfig from '../../config/world.json';
import playerConfig from '../../config/player.json';

/**
 * Every balance number lives in /config/*.json. They are imported (not fetched)
 * so the type checker sees their shape and the boot path stays request-free.
 */
export const World = worldConfig;
export const Player = playerConfig;

export type WorldConfig = typeof worldConfig;
export type PlayerConfig = typeof playerConfig;

export const chunkCount = World.sizeMeters / World.chunkMeters;

if (!Number.isInteger(chunkCount)) {
  throw new Error(
    `world.json: sizeMeters (${World.sizeMeters}) must be an exact multiple of chunkMeters (${World.chunkMeters})`,
  );
}

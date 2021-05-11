import { Netcode, consoleLog, getMilliseconds } from "../netcode/netcode";

export namespace Physics {


//------------------------------------------------------------------------------
// Constants

export const kProjectileMaxAge: i32 = 10_000 * 4; // quarters of a second

export const kMinPlayerMass: f32 = 1.0; // map units
export const kMaxPlayerMass: f32 = 2.0;

export const kMinPlayerRadius: f32 = 40.0; // map units
export const kMaxPlayerRadius: f32 = 400.0;

export const kMinPlayerGuns: i32 = 1; // # bullets fired
export const kMaxPlayerGuns: i32 = 10;

export const kMapFriction: f32 = 0.001;

export const kPlayerVelocityLimit: f32 = 1.0;
export const kBulletSpeed: f32 = 0.5;

export const kBombRadius = 2.0;
export const kBulletRadius = 20.0;

export const kMapWidth: f32 = 32000.0; // map units

export const kScreenToMapFactor: f32 = 1000.0;
export const kMapToScreenFactor: f32 = 1.0 / kScreenToMapFactor;

// Size player tile so that players only overlap 2x2 for bullet lookups
export const kPlayerMatrixWidth: u32 = 64; // i32(kMapWidth / kMaxPlayerRadius + 0.5);
// Half a screen of bullets per bullet tile
export const kProjectileMatrixWidth: u32 = 64; // i32(kMapWidth / (kScreenToMapFactor * 0.5) + 0.5);

// Must be a power of two
export const kProjectileInterval: i32 = 512 * 4; // time units


//------------------------------------------------------------------------------
// Tools

/*
    Screen vs Map Coordinates:

    Upper left of screen is (-1,-1) in screen coordinates.
    Lower right of screen is (1, 1) in screen coordinates.
    (0,0) is the center of the screen.

    Map units are 1/1000th of a screen, so a screen is 1000x1000 map units.
    The map coordinates range from 0..31999, and then loop around back to 0.
*/
export function MapToScreenUnits(map_units: f32): f32 {
    return map_units * kMapToScreenFactor;
}

// Accepts x in [-kMapWidth, kMapWidth*2) and produces values in [0, kMapWidth)
function MapModX(x: f32): f32 {
    if (x >= kMapWidth) {
        return x - kMapWidth;
    } else if (x < 0.0) {
        return x + kMapWidth;
    } else {
        return x;
    }
}

// Returns x - x0, taking map wrap-around into account.
export function MapDiff(x: f32, x0: f32): f32 {
    let d = x - x0;
    if (abs(d) > kMapWidth * 0.5) {
        if (d > 0.0) {
            d -= kMapWidth;
        } else {
            d += kMapWidth;
        }
    }
    return d;
}

export function MassForSize(size: u8): f32 {
    return f32(f32(size) / 255.0) * (kMaxPlayerMass - kMinPlayerMass) + kMinPlayerMass;
}

export function RadiusForSize(size: u8): f32 {
    return f32(f32(size) / 255.0) * (kMaxPlayerRadius - kMinPlayerRadius) + kMinPlayerRadius;
}

export function GunsForSize(size: u8): i32 {
    return i32(size) * (kMaxPlayerGuns - kMinPlayerGuns) / 255 + kMinPlayerGuns;
}


//------------------------------------------------------------------------------
// PlayerCollider

// Synchronized, queued size change
class PlayerSizeChange {
    server_ts: u64;
    size: u8;
    constructor(server_ts: u64, size: i32) {
        this.server_ts = server_ts;
        this.size = size;
    }
}

export class PlayerCollider {
    // Simulation state
    x: f32 = 0.0;
    y: f32 = 0.0;
    vx: f32 = 0.0;
    vy: f32 = 0.0;
    ax: f32 = 0.0;
    ay: f32 = 0.0;

    last_shot_local_ts: u64 = 0;
    last_shot_x: f32 = 0.0;
    last_shot_y: f32 = 0.0;
    last_shot_vx: f32 = 0.0; // Player velocity during shot
    last_shot_vy: f32 = 0.0;

    // Number of guns
    gun_count: i32 = 1;

    // Team for collision detection
    team: u8 = 0;

    size: u8 = 0;

    // Collision radius in map units
    r: f32 = 0.0;

    mass: f32 = 1.0;

    // Size changes
    changes: Array<PlayerSizeChange> = new Array<PlayerSizeChange>();

    // Which collision bin are we in?
    collider_matrix_bin: Array<PlayerCollider>;
    collider_matrix_index: i32 = -1;

    SetSize(size: u8): void {
        this.size = size;
        this.gun_count = GunsForSize(size);
        this.r = RadiusForSize(size);
        this.mass = MassForSize(size);
    }
}

export let PlayerColliderList: Array<PlayerCollider> = new Array<PlayerCollider>();

function UpdatePlayerSize(p: PlayerCollider, server_ts: u64): void {
    while (p.changes.length > 0) {
        let change = p.changes[0];

        let dt: i64 = i64(server_ts - change.server_ts);
        if (dt < 0) {
            continue;
        }

        p.SetSize(change.size);
        p.changes.shift();
    }
}

// FIXME: Add player

// Start resize sometime in the future
export function StartResize(p: PlayerCollider, server_ts: u64, size: u8): void {
    p.changes.push(new PlayerSizeChange(server_ts, size));
}


//------------------------------------------------------------------------------
// Projectile

export class Projectile {
    // Simulation state
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;

    // Team, radius for collision detection
    team: u8 = 0;
    r: f32 = 0.0;

    // Initial fire time (for expiry)
    local_ts: u64 = 0;
    server_ts: u64 = 0;

    // Which collision bin are we in?
    collider_matrix_bin: Array<Projectile>;
    collider_matrix_index: i32 = -1;
}

export let BombList: Array<Projectile> = new Array<Projectile>();
export let BulletList: Array<Projectile> = new Array<Projectile>();

function FireProjectiles(local_ts: u64, server_ts: u64, is_bomb: bool): void {
    const players_count = PlayerColliderList.length;

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerColliderList[i];

        let vx: f32 = p.vx, vy: f32 = p.vy;
        const player_speed: f32 = Mathf.sqrt(vx * vx + vy * vy);
        const inv_player_speed: f32 = 1.0 / player_speed;

        // Record last shot player state, useful for server
        p.last_shot_x = p.x;
        p.last_shot_y = p.y;
        p.last_shot_local_ts = local_ts;
        p.last_shot_vx = vx;
        p.last_shot_vy = vy;

        let angle0: f32 = Mathf.atan2(vy, vx);

        const k: f32 = Mathf.PI * 2.0 / f32(p.gun_count);

        for (let j: i32 = 0; j < p.gun_count; ++j) {
            const angle: f32 = angle0 + f32(j) * k;
            const nx: f32 = Mathf.cos(angle);
            const ny: f32 = Mathf.sin(angle);

            // Get main shot velocity
            const player_to_bullet_speed = kBulletSpeed * inv_player_speed;

            const pp = new Projectile;
            pp.x = p.x;
            pp.y = p.y;
            pp.vx = nx * player_to_bullet_speed + vx;
            pp.vy = ny * player_to_bullet_speed + vy;
            pp.local_ts = local_ts;
            pp.server_ts = server_ts;
            pp.team = p.team;

            if (is_bomb) {
                BombList.push(pp);
                pp.r = kBombRadius;
            } else {
                BulletList.push(pp);
                pp.r = kBulletRadius;
            }
        }
    }
}

// The tricky thing here is the time sync is not stable
let last_shot_server_ts: u64 = 0;

function UpdatePlayerProjectiles(local_ts: u64, server_ts: u64): void {
    const server_to_local: i64 = i64(local_ts - server_ts);

    const last_fuzzy_ts: i64 = i64(last_shot_server_ts) - (kProjectileInterval / 2);
    const dt: i32 = i32(server_ts - last_fuzzy_ts);
    if (dt < 0) {
        // Not at least half shot interval elapsed yet
        return;
    }

    let final_shot_ts = server_ts - i32(u32(server_ts) % u32(kProjectileInterval));
    const shots_dt: i32 = i32(final_shot_ts - last_fuzzy_ts);
    if (shots_dt < 0) {
        // No new shots before the last one we already fired
        return;
    }

    let shot_count: u32 = u32(shots_dt) / u32(kProjectileInterval) + 1;
    if (shot_count > 5) {
        shot_count = 5;
    }

    let server_shot_ts: u64 = final_shot_ts - shot_count * kProjectileInterval;

    for (let i: u32 = 0; i < shot_count; ++i) {
        const is_bomb: bool = (server_shot_ts / kProjectileInterval) % 4 == 0;

        const local_shot_ts: u64 = u64(server_to_local + server_shot_ts);
        FireProjectiles(local_shot_ts, server_shot_ts, is_bomb);

        server_shot_ts += kProjectileInterval;
    }

    last_shot_server_ts = final_shot_ts;
}


//------------------------------------------------------------------------------
// Collision Detection

export let PlayerMatrix = new Array<Array<PlayerCollider>>(kPlayerMatrixWidth * kPlayerMatrixWidth);
export let ProjectileMatrix = new Array<Array<Projectile>>(kProjectileMatrixWidth * kProjectileMatrixWidth);

function PositionToPlayerMatrixTile(x: f32): u32 {
    if (x <= 0.0) {
        return 0;
    }

    let tx: u32 = u32(x) / kPlayerMatrixWidth;
    if (tx >= kPlayerMatrixWidth) {
        return kPlayerMatrixWidth - 1;
    }

    return tx;
}

function PositionToProjectileMatrixTile(x: f32): u32 {
    if (x <= 0.0) {
        return 0;
    }

    let tx: u32 = u32(x) / kProjectileMatrixWidth;
    if (tx >= kProjectileMatrixWidth) {
        return kProjectileMatrixWidth - 1;
    }

    return tx;
}

export function InitializeCollisions(): void {
    for (let i: i32 = 0; i < kPlayerMatrixWidth * kPlayerMatrixWidth; ++i) {
        PlayerMatrix[i] = new Array<PlayerCollider>();
    }
    for (let i: i32 = 0; i < kProjectileMatrixWidth * kProjectileMatrixWidth; ++i) {
        ProjectileMatrix[i] = new Array<Projectile>();
    }
}

function UpdatePlayerMatrix(p: PlayerCollider): void {
    let tx: u32 = PositionToPlayerMatrixTile(p.x);
    let ty: u32 = PositionToPlayerMatrixTile(p.y);

    let bin_index: u32 = tx + ty * kPlayerMatrixWidth;
    let new_bin = PlayerMatrix[bin_index];

    // If it is in the same bin:
    if (new_bin === p.collider_matrix_bin) {
        // No need to move
        return;
    }

    // Remove from old bin:
    if (p.collider_matrix_index != -1) {
        let old_bin = p.collider_matrix_bin;
        old_bin[p.collider_matrix_index] = old_bin[old_bin.length - 1];
        old_bin.length--;
    }

    // Insert into new bin
    p.collider_matrix_bin = new_bin;
    p.collider_matrix_index = new_bin.length;
    new_bin.push(p);
}

function UpdateProjectileMatrix(p: Projectile): void {
    let tx: u32 = PositionToProjectileMatrixTile(p.x);
    let ty: u32 = PositionToProjectileMatrixTile(p.y);

    let bin_index: u32 = tx + ty * kProjectileMatrixWidth;
    let new_bin = ProjectileMatrix[bin_index];

    // If it is in the same bin:
    if (new_bin === p.collider_matrix_bin) {
        // No need to move
        return;
    }

    // Remove from old bin:
    if (p.collider_matrix_index != -1) {
        let old_bin = p.collider_matrix_bin;
        old_bin[p.collider_matrix_index] = old_bin[old_bin.length - 1];
        old_bin.length--;
    }

    // Insert into new bin
    p.collider_matrix_bin = new_bin;
    p.collider_matrix_index = new_bin.length;
    new_bin.push(p);
}

function MatrixRemovePlayer(p: PlayerCollider): void {
    if (p.collider_matrix_index != -1) {
        let old_bin = p.collider_matrix_bin;
        old_bin[p.collider_matrix_index] = old_bin[old_bin.length - 1];
        old_bin.length--;
        p.collider_matrix_index = -1;
    }
}

function MatrixRemoveProjectile(p: Projectile): void {
    if (p.collider_matrix_index != -1) {
        let old_bin = p.collider_matrix_bin;
        old_bin[p.collider_matrix_index] = old_bin[old_bin.length - 1];
        old_bin.length--;
        p.collider_matrix_index = -1;
    }
}

function IsColliding(p: PlayerCollider, projectile: Projectile): bool {
    const x: f32 = p.x - projectile.x;
    const y: f32 = p.y - projectile.y;
    const r: f32 = projectile.r + p.r;
    return x*x + y*y < r*r;

}

function CheckProjectileCollisions(): void {
    const players_count: i32 = PlayerColliderList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerColliderList[i];

        const x0: u32 = PositionToProjectileMatrixTile(p.x - p.r);
        const y0: u32 = PositionToProjectileMatrixTile(p.y - p.r);

        const x1: u32 = PositionToProjectileMatrixTile(p.x + p.r);
        const y1: u32 = PositionToProjectileMatrixTile(p.y + p.r);

        // Check all the projectile tiles the player overlaps:
        for (let y: u32 = y0; y <= y1; ++y) {
            let off: u32 = y * kProjectileMatrixWidth;
            for (let x: u32 = x0; x <= x1; ++x) {
                const tile = ProjectileMatrix[off + x];

                // Check all the bullets on the tile
                const count: i32 = tile.length;
                for (let i: i32 = 0; i < count; ++i) {
                    const projectile = tile[i];

                    if (p.team == projectile.team) {
                        continue;
                    }

                    if (IsColliding(p, projectile)) {
                        // FIXME: Report collision with bullet
                        // FIXME: Delete bullet
                    }
                }
            }
        }
    }
}


//------------------------------------------------------------------------------
// Simulator

function SimulatePlayerStep(p: PlayerCollider, dt: f32, local_ts: u64, server_ts: u64): void {
    UpdatePlayerSize(p, server_ts);

    const inv_mass: f32 = 1.0 / p.mass;

    let ax: f32 = p.ax * inv_mass;
    let ay: f32 = p.ay * inv_mass;

    let vx = p.vx + ax * dt;
    let vy = p.vy + ay * dt;

    let norm: f32 = f32(Math.sqrt(vx * vx + vy * vy));
    let mag = norm;

    if (norm <= 0.0) {
        // Skip if we are not moving
        return;
    }

    // Apply friction directly to velocity prior to max limit
    const vf: f32 = kMapFriction * inv_mass;
    if (mag > vf) {
        mag -= vf;
    } else {
        // Entirely eaten by friction
        mag = 0.0;
    }

    // Limit velocity
    if (mag > kPlayerVelocityLimit) {
        mag = kPlayerVelocityLimit;
    }

    // Rescale velocity down to limit
    mag /= norm;
    vx *= mag;
    vy *= mag;

    p.vx = vx;
    p.vy = vy;

    p.x = MapModX(p.x + vx * dt);
    p.y = MapModX(p.y + vy * dt);

    UpdatePlayerMatrix(p);
}

function SimulateProjectileStep(p: Projectile, dt: f32): void {
    p.x = MapModX(p.x + p.vx * dt);
    p.y = MapModX(p.y + p.vy * dt);
}

function SimulationStep(dt: f32, local_ts: u64, server_ts: u64): void {
    const players_count: i32 = PlayerColliderList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerColliderList[i];

        SimulatePlayerStep(p, dt, local_ts, server_ts);
    }

    UpdatePlayerProjectiles(local_ts, server_ts);

    const bomb_count: i32 = BombList.length;
    for (let i: i32 = 0; i < bomb_count; ++i) {
        const p = BombList[i];

        SimulateProjectileStep(p, dt);

        if (i32(local_ts - p.local_ts) > kProjectileMaxAge) {
            MatrixRemoveProjectile(p);
            BombList[i] = BombList[BombList.length - 1];
            BombList.length--;
            --i;
        }

        UpdateProjectileMatrix(p);
    }

    const bullet_count: i32 = BulletList.length;
    for (let i: i32 = 0; i < bullet_count; ++i) {
        const p = BulletList[i];

        SimulateProjectileStep(p, dt);

        if (i32(local_ts - p.local_ts) > kProjectileMaxAge) {
            MatrixRemoveProjectile(p);
            BulletList[i] = BulletList[BombList.length - 1];
            BulletList.length--;
            --i;
        }

        UpdateProjectileMatrix(p);
    }

    CheckProjectileCollisions();
}

let last_ts: u64 = 0;

export function SimulateTo(local_ts: u64, server_ts: u64): void {
    let dt: i32 = i32(local_ts - last_ts);
    server_ts -= dt;

    const step: i32 = 40;

    while (dt >= step) {
        SimulationStep(f32(step) * 0.25, last_ts, server_ts);
        dt -= step;
        last_ts += step;
        server_ts += step;
    }

    if (dt > 0) {
        SimulationStep(f32(dt) * 0.25, last_ts, server_ts);
        last_ts += dt;
    }
}


} // namespace Physics

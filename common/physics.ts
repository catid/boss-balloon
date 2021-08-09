import { jsConsoleLog, jsGetMilliseconds } from "./javascript"
import { Player as RenderPlayer } from "../client/main"

export namespace Physics {


//------------------------------------------------------------------------------
// Constants

export const kNumTeams: i32 = 5;

export const kProjectileMaxAge: i32 = 10_000 * 4; // quarters of a second

export const kSpawnSize: u8 = 3;

export const kMinPlayerMass: f32 = 1.0; // map units
export const kMaxPlayerMass: f32 = 2.0;

export const kMinPlayerRadius: f32 = 40.0; // map units
export const kMaxPlayerRadius: f32 = 400.0;

// Larger scale = zoom out
export const kMinScale: f32 = 1.0;
export const kMaxScale: f32 = 10.0;

export const kMinPlayerGuns: i32 = 1; // # bullets fired
export const kMaxPlayerGuns: i32 = 10;

export const kMapFriction: f32 = 0.001;

// Velocities are map units per 4 time ticks
export const kPlayerVelocityLimit: f32 = 1.0;
export const kBulletSpeed: f32 = 0.5;

export const kBombRadius: f32 = 20.0; // map units
export const kBulletRadius: f32 = 5.0; // map units

export const kMapWidth: f32 = 32000.0; // map units

export const kRenderScreenRadius: f32 = 1.0;

export const kMapScreenWidth: f32 = 1000.0;
export const kInvMapScreenWidth: f32 = 1.0 / kMapScreenWidth;

export const kPlayerMatrixWidth: i32 = 512;
export const kProjectileMatrixWidth: i32 = 512;

// Delay between hits allowed
export const kHitShieldDelay: i32 = 1000 * 4; // time units

// Must be a power of two
export const kProjectileInterval: i32 = 512 * 4; // time units


//------------------------------------------------------------------------------
// Time Units

// LSB = 1/4 of a millisecond

let time_epoch_msec: f64 = 0.0;

function InitTimeConversion(t_msec: f64): void {
    time_epoch_msec = t_msec;
}

// Convert to internal integer time units from floating-point performance.now() milliseconds
export function ConvertWallclock(t_msec: f64): u64 {
    return u64((t_msec - time_epoch_msec) * 4.0) & ~(u64(1) << 63);
}


//------------------------------------------------------------------------------
// Tools

function clamp_i32(x: i32, minval: i32, maxval: i32): i32 {
    if (x <= minval) {
        return minval;
    }
    if (x >= maxval) {
        return maxval;
    }
    return x;
}

function abs_i32(x: i32): i32 {
    return x < 0 ? -x : x;
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

/*
    This converts the map coordinates to screen coordinates relative to the player avatar in the center.
    The object may be fully outside of the screen, or partially in the screen.

    Screen vs Map Coordinates:

    Upper left of screen is (-1,-1) in screen coordinates.
    Lower right of screen is (1, 1) in screen coordinates.
    (0,0) is the center of the screen.

    The screen is 2000x2000 map units.
    The map coordinates range from 0..31999, and then loop around back to 0.
*/
export let ScreenCenterX: f32 = 0.0, ScreenCenterY: f32 = 0.0;

// Center in map coordinates
export function SetScreenCenter(x: f32, y: f32): void {
    ScreenCenterX = x;
    ScreenCenterY = y;
}

// Larger scale = zoom out, smaller scale = zoom in
export let ScreenScale: f32 = 1.0, InvScreenScale: f32 = 1.0;

// Factor to convert from map to screen coordinates
export let MapToScreen: f32 = kInvMapScreenWidth, ScreenToMap: f32 = kMapScreenWidth;

export function SetScreenScale(scale: f32): void {
    ScreenScale = scale;
    InvScreenScale = 1.0 / scale;

    MapToScreen = kInvMapScreenWidth * InvScreenScale;
    ScreenToMap = kMapScreenWidth * ScreenScale;
}

export function MapToScreenX(map_x: f32): f32 {
    return MapDiff(map_x, ScreenCenterX) * MapToScreen;
}
export function MapToScreenY(map_y: f32): f32 {
    return MapDiff(map_y, ScreenCenterY) * MapToScreen;
}

// Input: Screen x or y coordinate
// Output: Is this coordinate on the screen?
export function IsScreenXVisible(screen_x: f32, screen_r: f32): bool {
    return abs(screen_x) < kRenderScreenRadius + screen_r;
}
export function IsScreenXYVisible(screen_x: f32, screen_y: f32, screen_r: f32): bool {
    return IsScreenXVisible(screen_x, screen_r) && IsScreenXVisible(screen_y, screen_r);
}

// Input coordinates and radius in map units
export function IsMapObjectOnScreen(map_x: f32, map_y: f32, r: f32): bool {
    const sx: f32 = MapToScreenX(map_x);
    if (!IsScreenXVisible(sx, r)) {
        return false;
    }
    const sy: f32 = MapToScreenY(map_y);
    if (!IsScreenXVisible(sy, r)) {
        return false;
    }
    return true;
}

function lerp_f32(f: f32, minval: f32, maxval: f32): f32 {
    if (f <= 0.0) {
        return minval;
    }
    if (f >= 1.0) {
        return maxval;
    }
    return f * (maxval - minval) + minval;
}

export function ScaleForSize(size: u8): f32 {
    return lerp_f32(f32(size) / 255.0, kMinScale, kMaxScale);
}

export function MassForSize(size: u8): f32 {
    return lerp_f32(f32(size) / 255.0, kMinPlayerMass, kMaxPlayerMass);
}

export function RadiusForSize(size: u8): f32 {
    return lerp_f32(f32(size) / 255.0, kMinPlayerRadius, kMaxPlayerRadius);
}

export function GunsForSize(size: u8): i32 {
    return i32(size) * (kMaxPlayerGuns - kMinPlayerGuns) / 255 + kMinPlayerGuns;
}


//------------------------------------------------------------------------------
// PlayerCollider

export class PlayerCollider {
    // Indicates that the position data is out of sync with the 
    dirty: bool = false;
    t: u64 = 0; // Latest physics update timestamp

    // Simulation state
    x: f32 = 0.0;
    y: f32 = 0.0;
    vx: f32 = 0.0;
    vy: f32 = 0.0;
    ax: f32 = 0.0;
    ay: f32 = 0.0;

    last_shot_local_ts: u64 = 0;

    // Last shot info for server
    has_last_shot: bool = false;
    last_shot_x: f32 = 0.0;
    last_shot_y: f32 = 0.0;
    last_shot_vx: f32 = 0.0;
    last_shot_vy: f32 = 0.0;

    size: u8 = 0;

    last_collision_local_ts: u64 = 0;

    // Only used on client side
    client_render_player: RenderPlayer | null = null;

    // Number of guns
    gun_count: i32 = 1;

    // Team for collision detection
    team: u8 = 0;

    // Collision radius in map units
    r: f32 = 0.0;

    mass: f32 = 1.0;

    // Is player dead?
    is_ghost: bool = true;

    // Useful flag for rendering on client side
    on_screen: bool = false;

    // Which collision bin are we in?
    collider_matrix_bin: Array<Physics.PlayerCollider> | null = null;
    collider_matrix_index: i32 = -1;

    SetSize(size: u8): void {
        this.size = size;
        this.gun_count = GunsForSize(size);
        this.r = RadiusForSize(size);
        this.mass = MassForSize(size);
    }
}

let PlayerList: Array<Physics.PlayerCollider> = new Array<Physics.PlayerCollider>();

export function CreatePlayerCollider(team: u8): Physics.PlayerCollider {
    const p: Physics.PlayerCollider = new Physics.PlayerCollider();
    p.team = team;

    p.SetSize(0);

    // Initially creates a ghost player until we get position data
    p.is_ghost = true;

    PlayerList.push(p);

    return p;
}

export function RemovePlayerCollider(p: Physics.PlayerCollider): void {
    // Remove from collision matrix
    MatrixRemovePlayer(p);

    // Remove player projectiles when they leave
    RemovePlayerProjectiles(p);

    // Remove from PlayerList
    const count: i32 = PlayerList.length;
    for (let i: i32 = 0; i < count; ++i) {
        if (PlayerList[i] == p) {
            PlayerList[i] = PlayerList[count - 1];
            PlayerList.pop();
            break;
        }
    }
}

export function SetRandomSpawnPosition(p: Physics.PlayerCollider): void {
    p.x = Mathf.random() * kMapWidth;
    p.y = Mathf.random() * kMapWidth;
    p.vx = 0.0;
    p.vy = 0.0;
    p.ax = 0.0;
    p.ay = 0.0;
    p.is_ghost = false;

    p.SetSize(kSpawnSize);
}


//------------------------------------------------------------------------------
// Projectile

export class Projectile {
    // Waiting for initial simulation sync
    dirty: bool = false;

    // Simulation state
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;

    // Team, radius for collision detection
    team: u8 = 0;
    r: f32 = 0.0;
    is_bomb: bool = false;

    // Initial fire time (for expiry, and simulation sync)
    local_ts: u64 = 0;
    server_ts: u64 = 0;

    angle0: f32 = 0.0;

    // Which collision bin are we in?
    collider_matrix_bin: Array<Projectile> | null = null;
    collider_matrix_index: i32 = -1;

    shooter: Physics.PlayerCollider;

    constructor(shooter: Physics.PlayerCollider) {
        this.shooter = shooter;
    }
}

export let BombList: Array<Physics.Projectile> = new Array<Physics.Projectile>();
export let BulletList: Array<Physics.Projectile> = new Array<Physics.Projectile>();

function IsBombServerTime(server_shot_ts: u64): bool {
    return ((server_shot_ts + kProjectileInterval/2) / kProjectileInterval) % 4 == 0;
}

function PlayerFireProjectile(
    p: Physics.PlayerCollider, local_ts: u64, server_ts: u64, is_bomb: bool,
    x: f32, y: f32, vx: f32, vy: f32, dirty: bool): void {
    // Ghosts do not fire
    if (p.is_ghost) {
        p.has_last_shot = false;
        return;
    }

    // Record last shot player state, useful for server
    p.has_last_shot = true;
    p.last_shot_local_ts = local_ts;
    p.last_shot_x = x;
    p.last_shot_y = y;
    p.last_shot_vx = vx;
    p.last_shot_vy = vy;

    let angle0: f32 = Mathf.atan2(vy, vx);

    const k: f32 = Mathf.PI * 2.0 / f32(p.gun_count);

    for (let j: i32 = 0; j < p.gun_count; ++j) {
        const angle: f32 = angle0 + f32(j) * k;
        const nx: f32 = Mathf.cos(angle);
        const ny: f32 = Mathf.sin(angle);

        const pp = new Projectile(p);
        pp.x = x;
        pp.y = y;
        pp.vx = nx * kBulletSpeed + vx;
        pp.vy = ny * kBulletSpeed + vy;
        pp.local_ts = local_ts;
        pp.server_ts = server_ts;
        pp.team = p.team;
        pp.is_bomb = is_bomb;
        pp.angle0 = Mathf.random() * Mathf.PI;
        pp.dirty = dirty;

        if (is_bomb) {
            BombList.push(pp);
            pp.r = kBombRadius;
        } else {
            BulletList.push(pp);
            pp.r = kBulletRadius;
        }
    }
}

function FireProjectiles(local_ts: u64, server_ts: u64, is_bomb: bool): void {
    const players_count = PlayerList.length;

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];
        PlayerFireProjectile(
            p, local_ts, server_ts, is_bomb,
            p.x, p.y, p.vx, p.vy, false);
    }
}

// The tricky thing here is the time sync is not stable
let last_shot_server_ts: u64 = 0;

function GeneratePlayerProjectiles(local_ts: u64, server_ts: u64): void {
    const server_to_local: i64 = i64(local_ts - server_ts);

    let final_shot_ts = server_ts - i32(u32(server_ts) % u32(kProjectileInterval));
    const dt: i32 = i32(final_shot_ts - last_shot_server_ts - kProjectileInterval / 2);
    if (dt < 0) {
        // No new shots before the last one we already fired
        return;
    }

    let shot_count: u32 = u32(dt) / u32(kProjectileInterval) + 1;
    if (shot_count > 5) {
        shot_count = 5;
    }

    let server_shot_ts: u64 = final_shot_ts - shot_count * kProjectileInterval;

    for (let i: u32 = 0; i < shot_count; ++i) {
        const is_bomb: bool = IsBombServerTime(server_shot_ts);

        const local_shot_ts: u64 = u64(server_to_local + server_shot_ts);
        FireProjectiles(local_shot_ts, server_shot_ts, is_bomb);

        server_shot_ts += kProjectileInterval;
    }

    last_shot_server_ts = final_shot_ts;
}

function RemovePlayerProjectiles(p: Physics.PlayerCollider): void {
    for (let i: i32 = 0; i < BombList.length; ++i) {
        const pp = BombList[i];
        if (pp.shooter == p) {
            MatrixRemoveProjectile(pp);
            BombList[i] = BombList[BombList.length - 1];
            BombList.pop();
            --i;
        }
    }
    for (let i: i32 = 0; i < BulletList.length; ++i) {
        const pp = BulletList[i];
        if (pp.shooter == p) {
            MatrixRemoveProjectile(pp);
            BulletList[i] = BulletList[BulletList.length - 1];
            BulletList.pop();
            --i;
        }
    }
}


//------------------------------------------------------------------------------
// Collision Detection

export let PlayerMatrix = new Array<Array<Physics.PlayerCollider>>(kPlayerMatrixWidth * kPlayerMatrixWidth);
export let BombMatrix = new Array<Array<Physics.Projectile>>(kProjectileMatrixWidth * kProjectileMatrixWidth);
export let BulletMatrix = new Array<Array<Physics.Projectile>>(kProjectileMatrixWidth * kProjectileMatrixWidth);

// This assumes x ranges from [0, kPlayerMatrixWidth)
function PositionToPlayerMatrixTile(x: f32): i32 {
    if (x <= 0.0) {
        return 0;
    }

    let t: i32 = u32(x) / u32(kPlayerMatrixWidth);
    if (t >= kPlayerMatrixWidth) {
        return kPlayerMatrixWidth - 1;
    }

    return t;
}

// This assumes x ranges from [0, kProjectileMatrixWidth)
function PositionToProjectileMatrixTile(x: f32): i32 {
    if (x <= 0.0) {
        return 0;
    }

    let t: i32 = u32(x) / u32(kProjectileMatrixWidth);
    if (t >= kProjectileMatrixWidth) {
        return kProjectileMatrixWidth - 1;
    }

    return t;
}

function InitializeCollisions(): void {
    for (let i: i32 = 0; i < kPlayerMatrixWidth * kPlayerMatrixWidth; ++i) {
        PlayerMatrix[i] = new Array<Physics.PlayerCollider>();
    }
    for (let i: i32 = 0; i < kProjectileMatrixWidth * kProjectileMatrixWidth; ++i) {
        BombMatrix[i] = new Array<Physics.Projectile>();
    }
    for (let i: i32 = 0; i < kProjectileMatrixWidth * kProjectileMatrixWidth; ++i) {
        BulletMatrix[i] = new Array<Physics.Projectile>();
    }
}

function MatrixRemovePlayer(p: Physics.PlayerCollider): void {
    if (p.collider_matrix_index == -1) {
        return;
    }

    let old_bin = p.collider_matrix_bin!;

    // Move last element to take its place
    let last_p = old_bin[old_bin.length - 1];
    old_bin[p.collider_matrix_index] = last_p;
    last_p.collider_matrix_index = p.collider_matrix_index;

    old_bin.pop();

    p.collider_matrix_index = -1;
}

function MatrixRemoveProjectile(p: Physics.Projectile): void {
    if (p.collider_matrix_index == -1) {
        return;
    }

    let old_bin = p.collider_matrix_bin!;

    // Move last element to take its place
    let last_p = old_bin[old_bin.length - 1];
    old_bin[p.collider_matrix_index] = last_p;
    last_p.collider_matrix_index = p.collider_matrix_index;

    old_bin.pop();

    p.collider_matrix_index = -1;
}

function UpdatePlayerMatrix(p: Physics.PlayerCollider): void {
    let tx: u32 = PositionToPlayerMatrixTile(p.x);
    let ty: u32 = PositionToPlayerMatrixTile(p.y);

    let bin_index: u32 = tx + ty * kPlayerMatrixWidth;
    let new_bin = PlayerMatrix[bin_index];

    // If it is in the same bin:
    if (new_bin === p.collider_matrix_bin) {
        // No need to move
        return;
    }

    // Remove from old bin
    MatrixRemovePlayer(p);

    // Insert into new bin
    p.collider_matrix_bin = new_bin;
    p.collider_matrix_index = new_bin.length;
    new_bin.push(p);
}

function UpdateProjectileMatrix(m: Array<Array<Projectile>>, p: Projectile): void {
    let tx: u32 = PositionToProjectileMatrixTile(p.x);
    let ty: u32 = PositionToProjectileMatrixTile(p.y);

    let bin_index: u32 = tx + ty * kProjectileMatrixWidth;
    let new_bin = m[bin_index];

    // If it is in the same bin:
    if (new_bin === p.collider_matrix_bin) {
        // No need to move
        return;
    }

    // Remove from old bin
    MatrixRemoveProjectile(p);

    // Insert into new bin
    p.collider_matrix_bin = new_bin;
    p.collider_matrix_index = new_bin.length;
    new_bin.push(p);
}

function IsColliding(p: Physics.PlayerCollider, projectile: Physics.Projectile): bool {
    const x: f32 = p.x - projectile.x;
    const y: f32 = p.y - projectile.y;
    const r: f32 = projectile.r + p.r;
    return x*x + y*y < r*r;
}

let OnProjectileHit: (killee: Physics.PlayerCollider, killer: Physics.PlayerCollider) => void;

function OnHit(local_ts: u64, p: Physics.PlayerCollider, pp: Projectile): void {
    p.last_collision_local_ts = local_ts;

    OnProjectileHit(p, pp.shooter);
}

function CheckProjectileCollisions(local_ts: u64): void {
    const players_count: i32 = PlayerList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];

        if (p.is_ghost) {
            continue;
        }

        const x0: i32 = PositionToProjectileMatrixTile(p.x - p.r);
        const y0: i32 = PositionToProjectileMatrixTile(p.y - p.r);

        const x1: i32 = PositionToProjectileMatrixTile(p.x + p.r) + 1;
        const y1: i32 = PositionToProjectileMatrixTile(p.y + p.r) + 1;

        // Check all the projectile tiles the player overlaps:
        for (let y: i32 = y0; y != y1; ++y) {
            if (y >= kProjectileMatrixWidth) {
                y = 0; // Loop around
            }
            let off: i32 = y * kProjectileMatrixWidth;

            for (let x: i32 = x0; x != x1; ++x) {
                if (x >= kProjectileMatrixWidth) {
                    x = 0; // Loop around
                }

                {
                    const tile = BombMatrix[off + x];
                    const count: i32 = tile.length;
                    for (let i: i32 = 0; i < count; ++i) {
                        const pp = tile[i];
    
                        if (p.team == pp.team) {
                            continue;
                        }
    
                        if (!IsColliding(p, pp)) {
                            continue;
                        }
    
                        const cdt: i32 = i32(local_ts - p.last_collision_local_ts);
                        if (cdt < kHitShieldDelay) {
                            continue;
                        }
    
                        OnHit(local_ts, p, pp);
                    }
                }

                {
                    const tile = BulletMatrix[off + x];
                    const count: i32 = tile.length;
                    for (let i: i32 = 0; i < count; ++i) {
                        const pp = tile[i];
    
                        if (p.team == pp.team) {
                            continue;
                        }
    
                        if (!IsColliding(p, pp)) {
                            continue;
                        }
    
                        const cdt: i32 = i32(local_ts - p.last_collision_local_ts);
                        if (cdt < kHitShieldDelay) {
                            continue;
                        }
    
                        OnHit(local_ts, p, pp);
                    }
                }
            }
        }
    }
}

export function ForEachBombOnScreen(callback: (p: Projectile, sx: f32, sy: f32)=>void): void {
    const r: f32 = ScreenToMap + kBombRadius;

    const x0: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterX - r));
    const y0: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterY - r));

    const x1: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterX + r)) + 1;
    const y1: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterY + r)) + 1;

    for (let y: i32 = y0; y != y1; ++y) {
        if (y >= kProjectileMatrixWidth) {
            y = 0; // Loop around
        }
        let off: i32 = y * kProjectileMatrixWidth;

        for (let x: i32 = x0; x != x1; ++x) {
            if (x >= kProjectileMatrixWidth) {
                x = 0; // Loop around
            }

            const tile = BombMatrix[off + x];
            const count: i32 = tile.length;
            for (let i: i32 = 0; i < count; ++i) {
                const p = tile[i];

                if (!IsMapObjectOnScreen(p.x, p.y, p.r)) {
                    continue;
                }
                const sx: f32 = MapToScreenX(p.x);
                if (!IsScreenXVisible(sx, p.r)) {
                    continue;
                }
                const sy: f32 = MapToScreenY(p.y);
                if (!IsScreenXVisible(sy, p.r)) {
                    continue;
                }

                callback(p, sx, sy);
            }
        }
    }
}

export function ForEachBulletOnScreen(callback: (p: Projectile, sx: f32, sy: f32)=>void): void {
    const r: f32 = ScreenToMap + kBulletRadius;

    const x0: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterX - r));
    const y0: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterY - r));

    const x1: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterX + r)) + 1;
    const y1: i32 = PositionToProjectileMatrixTile(MapModX(ScreenCenterY + r)) + 1;

    for (let y: i32 = y0; y != y1; ++y) {
        if (y >= kProjectileMatrixWidth) {
            y = 0; // Loop around
        }
        let off: i32 = y * kProjectileMatrixWidth;

        for (let x: i32 = x0; x != x1; ++x) {
            if (x >= kProjectileMatrixWidth) {
                x = 0; // Loop around
            }

            const tile = BulletMatrix[off + x];
            const count: i32 = tile.length;
            for (let i: i32 = 0; i < count; ++i) {
                const p = tile[i];

                const sx: f32 = MapToScreenX(p.x);
                if (!IsScreenXVisible(sx, p.r)) {
                    continue;
                }
                const sy: f32 = MapToScreenY(p.y);
                if (!IsScreenXVisible(sy, p.r)) {
                    continue;
                }

                callback(p, sx, sy);
            }
        }
    }
}

export function ForEachPlayerOnScreen(callback: (p: Physics.PlayerCollider, sx: f32, sy: f32) => void): void {
    const r: f32 = ScreenToMap + kMaxPlayerRadius;

    const x0: i32 = PositionToPlayerMatrixTile(MapModX(ScreenCenterX - r));
    const y0: i32 = PositionToPlayerMatrixTile(MapModX(ScreenCenterY - r));

    const x1: i32 = PositionToPlayerMatrixTile(MapModX(ScreenCenterX + r)) + 1;
    const y1: i32 = PositionToPlayerMatrixTile(MapModX(ScreenCenterY + r)) + 1;

    for (let y: i32 = y0; y != y1; ++y) {
        if (y >= kPlayerMatrixWidth) {
            y = 0; // Loop around
        }
        let off: i32 = y * kPlayerMatrixWidth;
 
        for (let x: i32 = x0; x != x1; ++x) {
            if (x >= kPlayerMatrixWidth) {
                x = 0; // Loop around
            }
            const tile = PlayerMatrix[off + x];

            const count: i32 = tile.length;
            for (let i: i32 = 0; i < count; ++i) {
                const p = tile[i];

                if (p.is_ghost) {
                    continue;
                }

                const sx: f32 = MapToScreenX(p.x);
                if (!IsScreenXVisible(sx, p.r)) {
                    continue;
                }
                const sy: f32 = MapToScreenY(p.y);
                if (!IsScreenXVisible(sy, p.r)) {
                    continue;
                }

                callback(p, sx, sy);
            }
        }
    }
}


//------------------------------------------------------------------------------
// Simulator

function SimulatePlayerStep(p: Physics.PlayerCollider, dt: f32): void {
    const inv_mass: f32 = 1.0 / p.mass;

    let ax: f32 = p.ax * inv_mass;
    let ay: f32 = p.ay * inv_mass;

    let vx = p.vx + ax * dt;
    let vy = p.vy + ay * dt;

    let norm: f32 = Mathf.sqrt(vx * vx + vy * vy);
    let mag = norm;

    if (!p.dirty && norm <= 0.0) {
        // Optimization: Skip if player is not moving
        return;
    }

    // Disable dirty flag after first step
    p.dirty = false;

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
    if (norm > 0.001) {
        mag /= norm;
        vx *= mag;
        vy *= mag;
    } else {
        vx = 0.0;
        vy = 0.0;
    }

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

// Handle player that is out of sync with simulation
function ResyncDirtyPlayer(p: Physics.PlayerCollider, local_ts: u64): void {
    let dt: i32 = i32(local_ts - p.t);

    // If current simulation time is behind the position timetamp:
    if (dt < 0) {
        // Pause simulation for this player until we catch up.
        // The player will freeze on the screen, but it should be brief
        // because the simulation only lags behind a little.
        return;
    }

    const step: i32 = 40;

    // Note: This does not handle collisions during the roll-up.

    while (dt >= step) {
        // Note: This may clear dirty flag
        SimulatePlayerStep(p, f32(step) * 0.25);
        dt -= step;
    }

    if (dt > 0) {
        SimulatePlayerStep(p, f32(dt) * 0.25);
    }

    // Sync complete
    p.dirty = false;
}

// Handle projectile that is out of sync with simulation
function ResyncDirtyProjectile(p: Projectile, local_ts: u64): void {
    let dt: i32 = i32(local_ts - p.local_ts);

    // If current simulation time is behind the position timetamp:
    if (dt < 0) {
        // Pause simulation for this projectile until we catch up.
        // The projectile will freeze on the screen, but it should be brief
        // because the simulation only lags behind a little.
        return;
    }

    const step: i32 = 40;

    // Note: This does not handle collisions during the roll-up.

    while (dt >= step) {
        SimulateProjectileStep(p, f32(step) * 0.25);
        dt -= step;
    }

    if (dt > 0) {
        SimulateProjectileStep(p, f32(dt) * 0.25);
    }

    // Sync complete
    p.dirty = false;
}

function SimulationStep(dt: f32, local_ts: u64, server_ts: u64): void {
    const players_count: i32 = PlayerList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];

        // If needs re-sync:
        if (p.dirty) {
            ResyncDirtyPlayer(p, local_ts);
        } else {
            SimulatePlayerStep(p, dt);
        }
    }

    // FIXME: For now we do not generate projectiles on the client side.
    // In the future we can do latency hiding by predicting where the bullets will be,
    // and then "correct" the projectile positions when the server sends us info.
    if (ShouldGenerateProjectiles) {
        GeneratePlayerProjectiles(local_ts, server_ts);
    }

    for (let i: i32 = 0; i < BombList.length; ++i) {
        const p = BombList[i];

        // If needs re-sync:
        if (p.dirty) {
            ResyncDirtyProjectile(p, local_ts);
        } else {
            SimulateProjectileStep(p, dt);
        }

        if (i32(local_ts - p.local_ts) > kProjectileMaxAge) {
            MatrixRemoveProjectile(p);
            BombList[i] = BombList[BombList.length - 1];
            BombList.pop();
            --i;
        } else {
            UpdateProjectileMatrix(BombMatrix, p);
        }
    }

    for (let i: i32 = 0; i < BulletList.length; ++i) {
        const p = BulletList[i];

        // If needs re-sync:
        if (p.dirty) {
            ResyncDirtyProjectile(p, local_ts);
        } else {
            SimulateProjectileStep(p, dt);
        }

        if (i32(local_ts - p.local_ts) > kProjectileMaxAge) {
            MatrixRemoveProjectile(p);
            BulletList[i] = BulletList[BulletList.length - 1];
            BulletList.pop();
            --i;
        } else {
            UpdateProjectileMatrix(BulletMatrix, p);
        }
    }

    CheckProjectileCollisions(local_ts);
}


export let MasterTimestamp: u64 = 0;

export function SimulateTo(local_ts: u64, server_ts: u64): void {
    let dt: i32 = i32(local_ts - MasterTimestamp);

    // Roll back server time to current MasterTimestamp
    server_ts -= dt;

    const step: i32 = 40;

    while (dt >= step) {
        SimulationStep(f32(step) * 0.25, MasterTimestamp, server_ts);
        dt -= step;
        MasterTimestamp += step;
        server_ts += step;
    }

    if (dt > 0) {
        SimulationStep(f32(dt) * 0.25, MasterTimestamp, server_ts);
        MasterTimestamp += dt;
    }
}


//------------------------------------------------------------------------------
// Client Side API

// We assume that the player object has been updated by the caller to the
// provided x, y, vx, vy, ax, ay members.
export function IncorporateServerPosition(
    p: Physics.PlayerCollider,
    local_ts: u64, send_delay: i32, server_ts: u64): void
{
    // This implies they are not a ghost anymore
    p.is_ghost = false;

    // Send delay is always at least 1/2 millisecond,
    // and the ping time to the other side of the globe is under 200 milliseconds,
    // so bound the upper end too.
    send_delay = clamp_i32(send_delay, 2, 500 * 4);

    const local_sent_ts: u64 = local_ts - send_delay;

    // Next time we update the physics simulation, we'll fix this.
    // We assume that if the client is ahead of the server's simulation it's just by a little
    // bit and doesn't cause bullets to miss.
    p.t = local_sent_ts;
}

// We assume that the player object has been updated by the caller to the
// provided x, y, vx, vy, ax, ay members.
export function IncorporateServerShot(
    p: Physics.PlayerCollider,
    local_ts: u64, send_delay: i32, server_ts: u64,
    shot_x: f32, shot_y: f32,
    shot_vx: f32, shot_vy: f32): void
{
    // This implies they are not a ghost anymore
    p.is_ghost = false;

    // Send delay is always at least 1/2 millisecond,
    // and the ping time to the other side of the globe is under 200 milliseconds,
    // so bound the upper end too.
    send_delay = clamp_i32(send_delay, 2, 500 * 4);

    const local_sent_ts: u64 = local_ts - send_delay;

    // If a new shot has been fired:
    const last_shot_offset: i32 = i32(u32(server_ts) % u32(kProjectileInterval));
    const server_shot_ts: u64 = server_ts - last_shot_offset;
    const local_shot_ts: u64 = local_sent_ts - last_shot_offset;
    const shot_dt: i32 = abs_i32(i32(p.last_shot_local_ts - local_shot_ts));

    if (shot_dt >= kProjectileInterval / 2) {
        p.last_shot_local_ts = local_shot_ts;

        const is_bomb: bool = IsBombServerTime(server_shot_ts);

        PlayerFireProjectile(
            p, local_shot_ts, server_shot_ts, is_bomb,
            shot_x, shot_y, shot_vx, shot_vy, true);
    }
}


//------------------------------------------------------------------------------
// Server Side API

// We assume that the player object has been updated by the caller to the
// provided x, y, vx, vy, ax, ay members.
export function IncorporateClientPosition(p: Physics.PlayerCollider, local_ts: u64, send_delay: i32): void
{
    // Send delay is always at least 1/2 millisecond,
    // and the ping time to the other side of the globe is under 200 milliseconds,
    // so bound the upper end too.
    send_delay = clamp_i32(send_delay, 2, 500 * 4);

    const local_sent_ts: u64 = local_ts - send_delay;

    p.dirty = true;

    // Next time we update the physics simulation, we'll fix this.
    // We assume that if the client is ahead of the server's simulation it's just by a little
    // bit and doesn't cause bullets to miss.
    p.t = local_sent_ts;
}


//------------------------------------------------------------------------------
// Initialize

let ShouldGenerateProjectiles: bool = false;

export function Initialize(should_generate_projectiles: bool, t_msec: f64, on_projectile_hit: (killee: PlayerCollider, killer: PlayerCollider) => void): void {
    ShouldGenerateProjectiles = should_generate_projectiles;
    OnProjectileHit = on_projectile_hit;
    InitTimeConversion(t_msec);
    InitializeCollisions();
}


} // namespace Physics

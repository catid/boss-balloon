import { Netcode, consoleLog, getMilliseconds } from "../netcode/netcode";

export namespace Physics {


//------------------------------------------------------------------------------
// Constants

export const kProjectileMaxAge: i32 = 10_000 * 4; // quarters of a second

export const kMinPlayerRadius: f32 = 40.0; // map units
export const kMaxPlayerRadius: f32 = 400.0;

export const kMinPlayerGuns: i32 = 1; // # bullets fired
export const kMaxPlayerGuns: i32 = 10;

export const kMapWidth: f32 = 32000.0; // map units


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
    return map_units * 0.001;
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
    t: u64;
    size: u8;
    constructor(t: u64, size: i32) {
        this.t = t;
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

    last_shot_t: u64 = 0;
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

    // Size changes
    changes: Array<PlayerSizeChange> = new Array<PlayerSizeChange>();

    // Which collision bin are we in?
    collider_matrix_bin: Array<PlayerCollider>;
    collider_matrix_index: i32 = -1;

    SetSize(size: u8): void {
        this.size = size;
        this.gun_count = GunsForSize(size);
        this.r = RadiusForSize(size);
    }
}

export let PlayerColliderList: Array<PlayerCollider> = new Array<PlayerCollider>();

const kMatrixWidth: i32 = 512;
export let ColliderMatrix = new Array<Array<PlayerCollider>>(kMatrixWidth * kMatrixWidth);

export function StartResize(p: PlayerCollider, t: u64, size: u8): void {
    p.changes.push(new PlayerSizeChange(t, size));
}

function UpdatePlayerSize(p: PlayerCollider, t: u64): void {
    while (p.changes.length > 0) {
        let change = p.changes[0];

        let dt: i64 = i64(t - change.t);
        if (dt < 0) {
            continue;
        }

        p.SetSize(change.size);
        p.changes.shift();
    }
}


//------------------------------------------------------------------------------
// Collision Detection

export function InitializeCollisions(): void {
    for (let i: i32 = 0; i < kMatrixWidth * kMatrixWidth; ++i) {
        ColliderMatrix[i] = new Array<PlayerCollider>();
    }
}

function UpdateCollider(p: PlayerCollider): void {
    let tx: i32 = i32(p.x) / kMatrixWidth;
    let ty: i32 = i32(p.y) / kMatrixWidth;
    if (tx >= kMatrixWidth) {
        tx = kMatrixWidth - 1;
    }
    if (ty >= kMatrixWidth) {
        ty = kMatrixWidth - 1;
    }

    let bin_index: i32 = tx + ty * kMatrixWidth;
    let new_bin = ColliderMatrix[bin_index];

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


//------------------------------------------------------------------------------
// Projectile

export class Projectile {
    // Simulation state
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;

    // Team for collision detection
    team: u8 = 0;

    // Initial fire time (for expiry)
    t: u64 = 0;
}

export let BombList: Array<Projectile> = new Array<Projectile>();
export let BulletList: Array<Projectile> = new Array<Projectile>();

// FIXME: Simulate to exact time

function FireProjectiles(t: u64): void {
    const players_count = PlayerColliderList.length;

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerColliderList[i];

        let vx: f32 = p.vx;
        let vy: f32 = p.vy;
        const player_speed: f32 = Mathf.sqrt(vx * vx + vy * vy);

        // Record last shot player state, useful for server
        p.last_shot_x = p.x;
        p.last_shot_y = p.y;
        p.last_shot_t = t;
        p.last_shot_vx = p.vx;
        p.last_shot_vy = p.vy;

        let angle: f32 = Mathf.atan2(p.vy, p.vx);

        for (let j: i32 = 0; j < p.bullet_count; ++j) {
            // Get main shot velocity
            const bullet_speed: f32 = 0.5;
            const player_to_bullet_speed = bullet_speed / player_speed;
            let bvx: f32 = vx * player_to_bullet_speed + vx;
            let bvy: f32 = vy * player_to_bullet_speed + vy;
        }




        if (p.vx == 0.0 && p.vy == 0.0) {
            p.last_shot_vx = 0.0;
            p.last_shot_vy = 0.0;
        } else {

            vx = vx * vfactor + p.vx;
            vy = vy * vfactor + p.vy;

            const is_bomb: bool = (t / (500*4)) % 4 == 0;

            const pp = new Projectile;
            pp.x = p.x;
            pp.y = p.y;
            pp.vx = vx;
            pp.vy = vy;
            pp.t = t;
            pp.team = p.team;

            if (is_bomb) {
                BombList.push(pp);
            } else {
                BulletList.push(pp);
            }
        }

        p.last_shot_t = t;
        p.last_shot_x = p.x;
        p.last_shot_y = p.y;
        p.last_shot_vx = vx;
        p.last_shot_vy = vy;
}
}


//------------------------------------------------------------------------------
// Simulator

function SimulatePlayerStep(p: PlayerCollider, dt: f32, t: u64): void {
    UpdatePlayerSize(p, t);

    // TODO: Make slower if ship is larger

    const mass: f32 = 1.0;
    const inv_mass: f32 = 1.0 / mass;

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
    const friction: f32 = 0.001;
    const vf: f32 = friction * inv_mass;
    if (mag > vf) {
        mag -= vf;
    } else {
        // Entirely eaten by friction
        mag = 0.0;
    }

    // Limit velocity
    const limit: f32 = 1.0;
    if (mag > limit) {
        mag = limit;
    }

    // Rescale velocity down to limit
    mag /= norm;
    vx *= mag;
    vy *= mag;

    p.vx = vx;
    p.vy = vy;

    p.x = MapModX(p.x + vx * dt);
    p.y = MapModX(p.y + vy * dt);

    UpdateCollider(p);
}

function SimulateProjectileStep(p: Projectile, dt: f32): void {
    p.x = MapModX(p.x + p.vx * dt);
    p.y = MapModX(p.y + p.vy * dt);
}

function SimulationStep(dt: f32, t: u64): void {
    const players_count: i32 = PlayerColliderList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const player = PlayerColliderList[i];

        SimulatePlayerStep(player, dt, t);
    }

    const bomb_count: i32 = BombList.length;
    for (let i: i32 = 0; i < bomb_count; ++i) {
        const p = BombList[i];

        SimulateProjectileStep(p, dt);

        if (i32(t - p.t) > kProjectileMaxAge) {
            // Delete projectile
            BombList[i] = BombList[BombList.length - 1];
            BombList.length--;
            --i;
        }
    }

    const bullet_count: i32 = BulletList.length;
    for (let i: i32 = 0; i < bullet_count; ++i) {
        const p = BulletList[i];

        SimulateProjectileStep(p, dt);

        if (i32(t - p.t) > kProjectileMaxAge) {
            // Delete projectile
            BulletList[i] = BulletList[BombList.length - 1];
            BulletList.length--;
            --i;
        }
    }
}

let last_t: u64 = 0;

export function SimulateTo(t: u64): void {
    let dt: i32 = i32(t - last_t);

    const step: i32 = 40;

    while (dt >= step) {
        SimulationStep(f32(step) * 0.25, last_t);
        dt -= step;
        last_t += step;
    }

    if (dt > 0) {
        SimulationStep(f32(dt) * 0.25, last_t);
        last_t += dt;
    }
}


} // namespace Physics

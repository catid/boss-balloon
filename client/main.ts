import { InitializeRender } from "./render/render"
import { RenderContext } from "./render_context"
import { RenderTextData, RenderTextProgram, RenderTextHorizontal, RenderTextVertical } from "./render_text"
import { RenderPlayerProgram, RenderPlayerData } from "./render_player"
import { RenderStringProgram } from "./render_string"
import { RenderBombProgram } from "./render_bomb"
import { RenderBulletProgram } from "./render_bullet"
import { RenderMapProgram } from "./render_map"
import { RenderArrowProgram } from "./render_arrow"
import { RenderSunProgram } from "./render_sun"
import { RenderColor } from "./render_common"
import { Physics } from "../common/physics"


//------------------------------------------------------------------------------
// Constants

const kTeamColors = [
    new RenderColor(0.8, 0.4, 0.2), // red
    new RenderColor(0.2, 1.0, 0.2), // green
    new RenderColor(0.2, 0.4, 0.8), // blue
    new RenderColor(0.8, 0.3, 0.8), // purple
    new RenderColor(0.8, 0.8, 0.5)  // pink
];

const kTeamTextColors = [
    new RenderColor(1.0, 0.4, 0.2), // red
    new RenderColor(0.6, 1.0, 0.6), // green
    new RenderColor(0.2, 0.4, 1.0), // blue
    new RenderColor(1.0, 0.3, 1.0), // purple
    new RenderColor(1.0, 1.0, 0.5)  // pink
];

const kTextStrokeColor = new RenderColor(0.0, 0.0, 0.0);

const kStringColor = new RenderColor(1.0, 1.0, 1.0);


//------------------------------------------------------------------------------
// Programs

export let FontProgram: RenderTextProgram;
export let PlayerProgram: RenderPlayerProgram;
export let StringProgram: RenderStringProgram;
export let BombProgram: RenderBombProgram;
export let BulletProgram: RenderBulletProgram;
export let MapProgram: RenderMapProgram;
export let ArrowProgram: RenderArrowProgram;
export let SunProgram: RenderSunProgram;


//------------------------------------------------------------------------------
// Tools

function clamp(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
}


//------------------------------------------------------------------------------
// Render

function RenderPlayers(t: u64): void {
    Physics.ForEachPlayerOnScreen((p: Physics.Player, sx: f32, sy: f32) => void {
        let sun_x: f32 = p.x;
        if (sun_x > Physics.kMapWidth * 0.5) {
            sun_x -= Physics.kMapWidth;
        }
        let sun_y: f32 = p.y;
        if (sun_y > Physics.kMapWidth * 0.5) {
            sun_y -= Physics.kMapWidth;
        }
        const shine_angle: f32 = Mathf.atan2(sun_y, sun_x);
        const shine_max: f32 = 10000.0;
        const shine_dist: f32 = clamp(1.0 - (sun_x * sun_x + sun_y * sun_y) / (shine_max * shine_max), 0.5, 1.0);

        PlayerProgram.DrawPlayer(
            kTeamColors[p.team],
            sx, sy, p.r, shine_angle, shine_dist, t);

        StringProgram.DrawString(kTeamColors[p.team], sx, sy, sx + p.vx * 0.1, sy + p.vy * 0.1, t);

        if (p.render_name_data != null) {
            FontProgram.BeginRender();
            FontProgram.SetColor(kTeamTextColors[p.team],  kTextStrokeColor);
            FontProgram.Render(
                RenderTextHorizontal.Center, RenderTextVertical.Center,
                sx, sy + 0.06,
                0.32/p.render_name_data!.width, p.render_name_data!);
        }
    });
}

function RenderProjectiles(t: u64): void {
    let last_was_bullet = false;
    let last_was_bomb = false;

    Physics.ForEachProjectileOnScreen((p: Physics.Projectile, sx: f32, sy: f32) => void {
        if (p.is_bomb) {
            last_was_bullet = false;
            if (!last_was_bomb) {
                last_was_bomb = true;
                BombProgram.BeginBombs(t, 0.1);
            }
            BombProgram.DrawBomb(kTeamColors[p.team], sx, sy, p.angle0 + angle);
        } else {
            last_was_bomb = false;
            if (!last_was_bullet) {
                last_was_bullet = true;
                BulletProgram.BeginBullets(t, 0.1);
            }
            BulletProgram.DrawBullet(kTeamColors[p.team], sx, sy, p.angle0 + angle);
        }
    });
}

function RenderArrows(t: u64): void {
    const players_count = player_list.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = player_list[i];

        if (p.on_screen || p.is_self || p.Collider.is_ghost) {
            continue;
        }

        let x: f32 = Physics.MapToScreenX(p.Collider.x);
        let y: f32 = Physics.MapToScreenY(p.Collider.y);
        const dist: f32 = Mathf.sqrt(x * x + y * y);
        const scale_min: f32 = 0.01;
        const scale_max: f32 = 0.04;
        const scale: f32 = scale_min + clamp(scale_max - dist * 0.004, 0.0, scale_max - scale_min);

        const angle: f32 = Mathf.atan2(y, x);

        if (x > y) {
            if (x > -y) {
                // right
                x = 1.0;
                y = Mathf.tan(angle);
            } else {
                // top
                x = Mathf.tan(angle - Mathf.PI * 0.5);
                y = -1.0;
            }
        } else {
            if (x > -y) {
                // bottom
                x = -Mathf.tan(angle + Mathf.PI * 0.5);
                y = 1.0;
            } else {
                // left
                x = -1.0;
                y = -Mathf.tan(angle);
            }
        }

        const edge_limit: f32 = 0.04;
        if (x < -1.0 + edge_limit) {
            x = -1.0 + edge_limit;
        } else if (x > 1.0 - edge_limit) {
            x = 1.0 - edge_limit;
        }
        if (y < -1.0 + edge_limit) {
            y = -1.0 + edge_limit;
        } else if (y > 1.0 - edge_limit) {
            y = 1.0 - edge_limit;
        }

        ArrowProgram.DrawArrow(
            kTeamColors[p.team],
            x, y, scale, angle, t);
    }
}


//------------------------------------------------------------------------------
// Objects

export let TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
export let MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();


//------------------------------------------------------------------------------
// Player

export class Player {
    network_id: u8 = 0;
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;
    name: string = "";

    is_self: bool = false;

    size: u8 = 0;

    temp_screen_x: f32 = 0;
    temp_screen_y: f32 = 0;
    on_screen: bool = false;

    Collider: Physics.Player;

    constructor() {
    }

    SetName(name: string): void {
        this.name = name;
        this.Collider.render_name_data = FiracodeFont.GenerateLine(name);
    }
};

export let SelfId: i32 = -1;
export let PlayerMap = new Map<u8, Player>();

// Temporary self/player list for current frame
export let FrameSelf: Player | null;
export let FramePlayers: Player[]; // temp

export function UpdateFrameInfo(): void {
    FramePlayers = PlayerMap.values();

    FrameSelf = null;
    if (SelfId != -1 && PlayerMap.has(u8(SelfId))) {
        FrameSelf = PlayerMap.get(u8(SelfId));
    }
}


//------------------------------------------------------------------------------
// Music

let last_music_change: u64 = 0;
let active_music: string = "chill";
let next_music: string = "";
let next_music_ts: u64 = 0;

function UpdateMusic(t: u64, sx: f32, sy: f32): void {
    if (temp_self == null) {
        return;
    }

    // Do not change music faster than 10 seconds.
    const dt: i64 = i64(t - last_music_change);
    if (dt < 10_000 * 4) {
        return;
    }

    let enemy_near: bool = false;
    let highest_size: i32 = 0;

    const players_count = player_list.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const player = player_list[i];

        if (player.team == temp_self!.team) {
            continue;
        }

        // Wide radius around screen
        if (IsObjectOnScreen(player.temp_screen_x, player.temp_screen_y, 0.5)) {
            enemy_near = true;
            if (highest_size < i32(player.size)) {
                highest_size = i32(player.size);
            }
        }
    }

    let music: string = "chill";

    if (enemy_near) {
        const diff: i32 = i32(temp_self!.size) - highest_size;
        if (diff > 3) {
            music = "fight2";
        } else {
            music = "fight1";
        }
    }

    // Require new music to be consistent for at least 5 seconds before changing.
    if (next_music != music) {
        next_music_ts = t;
        next_music = music;
        return;
    }

    const next_dt: i64 = i64(t - next_music_ts);
    if (next_dt < 5_000 * 4) {
        return;
    }

    if (active_music != next_music) {
        active_music = next_music;
        last_music_change = t;
        jsPlayMusic(active_music);
        next_music = "";
    }
}


//------------------------------------------------------------------------------
// Initialization

export function Initialize(): void {
    new RenderContext();

    FontProgram = new RenderTextProgram("gfx/fira_code_sdf.png");
    PlayerProgram = new RenderPlayerProgram();
    StringProgram = new RenderStringProgram();
    BombProgram = new RenderBombProgram();
    BulletProgram = new RenderBulletProgram();
    MapProgram = new RenderMapProgram();
    ArrowProgram = new RenderArrowProgram();
    SunProgram = new RenderSunProgram();
}


//------------------------------------------------------------------------------
// Render

export function RenderFrame(
    now_msec: f64,
    finger_x: i32, finger_y: i32,
    canvas_w: i32, canvas_h: i32): void
{
    RenderContext.I.UpdateViewport(canvas_w, canvas_h);
    RenderContext.I.Clear();

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = Physics.ConvertWallclock(now_msec);

    let fx: f32 = f32(finger_x) / f32(canvas_w) * 2.0 - 1.0;
    let fy: f32 = f32(finger_y) / f32(canvas_h) * 2.0 - 1.0;

    let pointer_active: bool = Physics.IsOnScreen(fx, fy);

    if (temp_self != null) {
        temp_self!.ax = 0;
        temp_self!.ay = 0;

        if (pointer_active) {
            const mag: f32 = Mathf.sqrt(fx * fx + fy * fy);
            const dead_zone: f32 = 0.1;
            if (mag > dead_zone) {
                const accel: f32 = 0.001;
                temp_self!.ax = f32(fx) * accel / mag;
                temp_self!.ay = f32(fy) * accel / mag;
            }
        }

        temp_self!.is_self = true;
    }

    Physics.SimulateTo(t);

    SendPosition(t);

    const origin_x = ObjectToScreen(0.0, sx);
    const origin_y = ObjectToScreen(0.0, sy);
    map_prog.DrawMap(-origin_x, -origin_y, 1.0, t);

    RenderPlayers(t, sx, sy);
    RenderBombs(t, sx, sy);
    RenderBullets(t, sx, sy);

    const sun_radius: f32 = 1.4;
    if (IsObjectOnScreen(origin_x, origin_y, sun_radius)) {
        sun_prog.DrawSun(origin_x, origin_y, sun_radius, t);
    }

    RenderArrows(t, sx, sy);

    if (pointer_active) {
        StringProgram.DrawString(
            kStringColor,
            fx,
            fy,
            0.0, 0.0,
            t);
    }

    RenderContext.I.Flush();

    if (temp_self != null) {
        temp_self!.is_self = false;
    }

    UpdateMusic(t, sx, sy);

    // Collect GC after render tasks are done
    __collect();
}

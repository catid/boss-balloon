//------------------------------------------------------------------------------
// Imports

import { Netcode } from "../common/netcode";
import { Physics } from "../common/physics";
import { Tools } from "./common/tools";


//------------------------------------------------------------------------------
// Objects

let TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
let MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();
let TimeConverter: Tools.TimeConverter;

let SelfId: i32 = -1;

let player_map = new Map<u8, Player>();
let player_list: Player[]; // temp
let temp_self: Player | null;


//------------------------------------------------------------------------------
// Player

class Player {
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

    name_data: RenderTextData | null = null;

    Collider: Physics.PlayerCollider;

    constructor() {
    }
};


//------------------------------------------------------------------------------
// Initialization

export function Initialize(): void {

    Physics.InitializeCollisions();
}


//------------------------------------------------------------------------------
// Position Update

let last_position_send: u64 = 0;
let last_ax: f32 = 0.0;
let last_ay: f32 = 0.0;

function SendPosition(t: u64): void {
    if (temp_self == null) {
        return;
    }

    let dt: i64 = i64(t - last_position_send);
    if (dt < 100 * 4) {
        return;
    }

    if (dt < 200 * 4) {
        if (Mathf.abs(temp_self!.ax - last_ax) < 0.3 &&
            Mathf.abs(temp_self!.ay - last_ay) < 0.3) {
            return;
        }
    }

    last_position_send = t;
    last_ax = temp_self!.ax;
    last_ay = temp_self!.ay;

    let buffer: Uint8Array = new Uint8Array(14);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.UnreliableType.ClientPosition, 0);

    let remote_ts: u32 = TimeSync.LocalToPeerTime_ToTS23(t);
    Netcode.Store24(ptr, 1, remote_ts);

    store<u16>(ptr, Netcode.ConvertXto16(temp_self!.x), 4);
    store<u16>(ptr, Netcode.ConvertXto16(temp_self!.y), 6);
    store<i16>(ptr, Netcode.ConvertVXto16(temp_self!.vx), 8);
    store<i16>(ptr, Netcode.ConvertVXto16(temp_self!.vy), 10);
    store<u16>(ptr, Netcode.ConvertAccelto16(temp_self!.ax, temp_self!.ay), 12);

    jsSendUnreliable(buffer);
}


//------------------------------------------------------------------------------
// Render

let hack_last_bullet_fire: u64 = 0;
let hack_bomb_counter: i32 = 0;

export function RenderFrame(
    now_msec: f64,
    finger_x: i32, finger_y: i32,
    canvas_w: i32, canvas_h: i32): void
{
    RenderContext.I.UpdateViewport(canvas_w, canvas_h);
    RenderContext.I.Clear();

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = TimeConverter.MsecToTime(now_msec);

    let fx: f32 = f32(finger_x) / f32(canvas_w) * 2.0 - 1.0;
    let fy: f32 = f32(finger_y) / f32(canvas_h) * 2.0 - 1.0;

    let pointer_active: bool = IsObjectOnScreen(fx, fy);

    player_list = player_map.values();

    temp_self = null;
    if (SelfId != -1 && player_map.has(u8(SelfId))) {
        temp_self = player_map.get(u8(SelfId));
    }
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
        string_prog.DrawString(
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

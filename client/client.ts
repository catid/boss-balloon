//------------------------------------------------------------------------------
// Imports

import { RenderContext } from "./gl/RenderContext";
import { RenderTextData, RenderTextProgram, RenderTextHorizontal, RenderTextVertical } from "./gl/RenderText";
import { Box3 } from "../node_modules/as-3d-math/src/as/index";
import { Netcode, consoleLog, getMilliseconds } from "../netcode/netcode";
import { RenderPlayerProgram, RenderPlayerData } from "./gl/RenderPlayer";
import { RenderStringProgram } from "./gl/RenderString";
import { RenderBombProgram } from "./gl/RenderBomb";
import { RenderBulletProgram } from "./gl/RenderBullet";
import { RenderMapProgram } from "./gl/RenderMap";
import { RenderArrowProgram } from "./gl/RenderArrow";
import { RenderSunProgram } from "./gl/RenderSun";
import { RenderColor } from "./gl/RenderCommon";
import { Physics } from "../physics/physics";

declare function sendReliable(buffer: Uint8Array): void;
declare function sendUnreliable(buffer: Uint8Array): void;
declare function playSFX(name: string): void;
declare function playMusic(name: string): void;
declare function serverLoginGood(): void;
declare function serverLoginBad(reason: string): void;

export const UINT8ARRAY_ID = idof<Uint8Array>();

let TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
let MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();
let TimeConverter: Netcode.TimeConverter;


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
// Tools

function clamp(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
}


//------------------------------------------------------------------------------
// Player

let SelfId: i32 = -1;

class Player {
    id: u8 = 0;
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;
    name: string = "";

    is_self: bool = false;

    size: u8 = 0;

    x: f32 = 0.0;
    y: f32 = 0.0;
    vx: f32 = 0.0;
    vy: f32 = 0.0;
    ax: f32 = 0.0;
    ay: f32 = 0.0;

    server_x: f32 = 0.0;
    server_y: f32 = 0.0;
    server_vx: f32 = 0.0;
    server_vy: f32 = 0.0;

    temp_screen_x: f32 = 0;
    temp_screen_y: f32 = 0;
    on_screen: bool = false;

    name_data: RenderTextData | null = null;

    constructor() {
    }
};

let player_map = new Map<u8, Player>();
let player_list: Player[]; // temp
let temp_self: Player | null;

function OnPlayerKilled(killer: Player, killee: Player): void {

}

function OnChat(player: Player, m: string): void {
    consoleLog("Chat: " + m.toString());
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
        playMusic(active_music);
        next_music = "";
    }
}


//------------------------------------------------------------------------------
// Connection

export function OnConnectionOpen(now_msec: f64): void {
    consoleLog("UDP link up");

    TimeConverter = new Netcode.TimeConverter(now_msec);

    player_map.clear();
    SelfId = -1;
    TimeSync = new Netcode.TimeSync();

    SendTimeSync();

    let chat = Netcode.MakeChatRequest("Hello World");
    if (chat != null) {
        sendReliable(chat);
    }
}

export function OnReliableSendTimer(): void {
    let buffer : Uint8Array | null = MessageCombiner.PopNextDatagram();
    if (buffer == null) {
        return;
    }

    sendReliable(buffer);
}

export function OnConnectionClose(): void {
    consoleLog("UDP link down");
}


//------------------------------------------------------------------------------
// Message Deserializers

export function OnConnectionUnreliableData(recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = TimeConverter.MsecToTime(recv_msec);

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr: usize = buffer.dataStart + offset;
        const remaining: i32 = buffer.length - offset;
        const type: u8 = load<u8>(ptr, 0);

        if (type == Netcode.UnreliableType.TimeSync && remaining >= 14) {
            let remote_send_ts: u32 = Netcode.Load24(ptr, 1);
            let min_trip_send_ts24_trunc: u32 = Netcode.Load24(ptr, 4);
            let min_trip_recv_ts24_trunc: u32 = Netcode.Load24(ptr, 7);
            let slope: f32 = load<f32>(ptr, 10);

            TimeSync.OnPeerSync(t, remote_send_ts, min_trip_send_ts24_trunc, min_trip_recv_ts24_trunc, slope);

            //sendUnreliable(Netcode.MakeTimeSyncPong(remote_send_ts, TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = TimeSync.ExpandLocalTime_FromTS23(t, ping_ts);
            let pong: u64 = TimeSync.ExpandLocalTime_FromTS23(t, pong_ts);

            if (pong < ping || t + 1 < pong) {
                consoleLog("*** TEST FAILED!");
                consoleLog("Ping T = " + ping.toString());
                consoleLog("Pong T = " + pong.toString());
                consoleLog("Recv T = " + t.toString());
                TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ServerPosition && remaining >= 6) {
            let server_ts: u32 = Netcode.Load24(ptr, 1);
            let update_t = TimeSync.PeerToLocalTime_FromTS23(server_ts);

            let dt: i32 = i32(t - update_t);
            if (dt < 0) {
                update_t = t;
            }

            const bytes_per_client: i32 = 19;
            const player_count: i32 = load<u8>(ptr, 4);
            const expected_bytes: i32 = 5 + player_count * bytes_per_client;

            if (remaining < expected_bytes) {
                consoleLog("Truncated server position");
                break;
            }

            let pptr: usize = ptr + 5;

            for (let i: i32 = 0; i < player_count; ++i) {
                const player_id: u8 = load<u8>(pptr, 0);
                if (player_map.has(player_id)) {
                    const player: Player = player_map.get(player_id);

                    if (player.is_self) {
                        continue;
                    }

                    player.server_x = Netcode.Convert16toX(load<u16>(pptr, 1));
                    player.server_y = Netcode.Convert16toX(load<u16>(pptr, 3));
                    player.server_vx = Netcode.Convert16toVX(load<i16>(pptr, 5));
                    player.server_vy = Netcode.Convert16toVX(load<i16>(pptr, 7));

                    const aa: u16 = load<u16>(pptr, 9);
                    let ax: f32 = 0.0, ay: f32 = 0.0;
                    if (aa != 0) {
                        const angle: f32 = (aa - 1) * Netcode.inv_aa_factor;
                        ax = Mathf.cos(angle);
                        ay = Mathf.sin(angle);
                    }

                    player.ax = ax;
                    player.ay = ay;

                    const last_shot_x: f32 = Netcode.Convert16toX(load<u16>(pptr, 11));
                    const last_shot_y: f32 = Netcode.Convert16toX(load<u16>(pptr, 13));
                    const last_shot_vx: f32 = Netcode.Convert16toVX(load<i16>(pptr, 15));
                    const last_shot_vy: f32 = Netcode.Convert16toVX(load<i16>(pptr, 17));
                }

                pptr += bytes_per_client;
            }

            offset += expected_bytes;
        } else {
            consoleLog("Server sent invalid unreliable data");
            return;
        }
    }
}

export function OnConnectionReliableData(buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr = buffer.dataStart + offset;
        const remaining: i32 = buffer.length - offset;
        const type: u8 = load<u8>(ptr, 0);

        if (type == Netcode.ReliableType.SetId && remaining >= 2) {
            SelfId = load<u8>(ptr, 1);
            offset += 2;
        } else if (type == Netcode.ReliableType.ServerLoginGood) {
            serverLoginGood();
            offset++;
        } else if (type == Netcode.ReliableType.ServerLoginBad && remaining >= 3) {
            let len: i32 = load<u16>(ptr, 1);
            if (len + 3 > remaining) {
                consoleLog("Truncated loginbad response");
                return;
            }

            let s: string = String.UTF8.decodeUnsafe(ptr + 3, len, false);

            serverLoginBad(s);

            offset += 3 + len;
        } else if (type == Netcode.ReliableType.SetPlayer && remaining >= 15) {
            let id: u8 = load<u8>(ptr, 1);
            let player: Player | null = null;
            if (player_map.has(id)) {
                player = player_map.get(id);
            } else {
                player = new Player();
                player_map.set(id, player);
                player.id = id;
            }

            player.score = load<u16>(ptr, 2);
            player.wins = load<u32>(ptr, 4);
            player.losses = load<u32>(ptr, 8);
            player.skin = load<u8>(ptr, 12);
            player.team = load<u8>(ptr, 13);

            let name_len: u8 = load<u8>(ptr, 14);
            if (15 + name_len > remaining) {
                consoleLog("Truncated setplayer");
                return;
            }

            player.name = String.UTF8.decodeUnsafe(ptr + 15, name_len, false);
            player.name_data = firacode_font.GenerateLine(player.name);

            consoleLog("SetPlayer: " + id.toString() + " = " + player.name.toString());

            offset += 15 + name_len;
        } else if (type == Netcode.ReliableType.RemovePlayer && remaining >= 2) {
            let id: u8 = load<u8>(ptr, 1);

            player_map.delete(id);

            consoleLog("RemovePlayer: " + id.toString());

            offset += 2;
        } else if (type == Netcode.ReliableType.PlayerKill && remaining >= 7) {
            let killer_id: u8 = load<u8>(ptr, 1);
            let killee_id: u8 = load<u8>(ptr, 2);
            if (player_map.has(killer_id) && player_map.has(killee_id)) {
                let killer: Player = player_map.get(killer_id);
                let killee: Player = player_map.get(killee_id);
                killer.score = load<u16>(ptr, 3);
                killee.score = load<u16>(ptr, 5);

                OnPlayerKilled(killer, killee);
            }
            offset += 7;
        } else if (type == Netcode.ReliableType.Chat && remaining >= 5) {
            let id: u8 = load<u8>(ptr, 1);
            let m_len: u16 = load<u16>(ptr, 2);

            if (4 + m_len > remaining) {
                consoleLog("Truncated chat");
                return;
            }

            if (player_map.has(id)) {
                let player: Player = player_map.get(id);
                let m: string = String.UTF8.decodeUnsafe(ptr + 4, m_len, false);

                OnChat(player, m);
            }

            offset += 4 + m_len;
        } else {
            consoleLog("Server sent invalid reliable data");
            return;
        }
    }
}


//------------------------------------------------------------------------------
// Message Serializers

export function SendClientLogin(name: string, password: string): i32 {
    let buffer: Uint8Array | null = Netcode.MakeClientLogin(name, password);
    if (buffer == null) {
        return -1;
    }
    MessageCombiner.Push(buffer);
    return 0;
}

export function SendChatRequest(m: string): i32 {
    let buffer: Uint8Array | null = Netcode.MakeChatRequest(m);
    if (buffer == null) {
        return -1;
    }
    MessageCombiner.Push(buffer);
    return 0;
}

export function SendTimeSync(): void {
    const send_msec = getMilliseconds();
    sendUnreliable(TimeSync.MakeTimeSync(TimeConverter.MsecToTime(send_msec)));
}


//------------------------------------------------------------------------------
// Initialization

let firacode_font: RenderTextProgram;
let player_prog: RenderPlayerProgram;
let string_prog: RenderStringProgram;
let bomb_prog: RenderBombProgram;
let bullet_prog: RenderBulletProgram;
let map_prog: RenderMapProgram;
let arrow_prog: RenderArrowProgram;
let sun_prog: RenderSunProgram;

export function Initialize(): void {
    new RenderContext();

    firacode_font = new RenderTextProgram("textures/fira_code_sdf.png");
    player_prog = new RenderPlayerProgram();
    string_prog = new RenderStringProgram();
    bomb_prog = new RenderBombProgram();
    bullet_prog = new RenderBulletProgram();
    map_prog = new RenderMapProgram();
    arrow_prog = new RenderArrowProgram();
    sun_prog = new RenderSunProgram();

    Physics.InitializeCollisions();
}


//------------------------------------------------------------------------------
// Render

/*
    Screen coordinates are (-1, -1) for upper-left corner and (1, 1) for the
    lower-right corner.
*/

function ObjectToScreen(x: f32, sx: f32): f32 {
    let d = x - sx;
    if (abs(d) > Netcode.kMapWidth * 0.5) {
        if (d > 0.0) {
            d -= Netcode.kMapWidth;
        } else {
            d += Netcode.kMapWidth;
        }
    }
    return d * 0.001;
}

function IsObjectOnScreen(x: f32, y: f32, r: f32 = 0.0): bool {
    r += 1.0;
    return abs(x) <= r && abs(y) <= r;
}

function RenderPlayers(t: u64, sx: f32, sy: f32): void {
    const players_count = player_list.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = player_list[i];

        const x = ObjectToScreen(player.x, sx);
        const y = ObjectToScreen(player.y, sy);

        player.temp_screen_x = x;
        player.temp_screen_y = y;
        player.on_screen = IsObjectOnScreen(x, y, 0.04);

        if (!player.on_screen) {
            continue;
        }

        let sun_x: f32 = player.x;
        if (sun_x > Netcode.kMapWidth * 0.5) {
            sun_x -= Netcode.kMapWidth;
        }
        let sun_y: f32 = player.y;
        if (sun_y > Netcode.kMapWidth * 0.5) {
            sun_y -= Netcode.kMapWidth;
        }
        const shine_angle: f32 = Mathf.atan2(sun_y, sun_x);
        const shine_max: f32 = 10000.0;
        const shine_dist: f32 = clamp(1.0 - (sun_x * sun_x + sun_y * sun_y) / (shine_max * shine_max), 0.5, 1.0);

        player_prog.DrawPlayer(
            kTeamColors[player.team],
            x, y, 0.04, shine_angle, shine_dist, t);

        string_prog.DrawString(kTeamColors[player.team], x, y, x + player.vx * 0.1, y + player.vy * 0.1, t);
    }

    firacode_font.BeginRender();

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = player_list[i];

        if (player.name_data == null || !player.on_screen) {
            continue;
        }

        firacode_font.SetColor(kTeamTextColors[player.team],  kTextStrokeColor);

        firacode_font.Render(
            RenderTextHorizontal.Center, RenderTextVertical.Center,
            player.temp_screen_x, player.temp_screen_y + 0.06,
            0.32/player.name_data!.width, player.name_data!);
    }
}

function RenderBullets(t: u64, sx: f32, sy: f32): void {
    const count = BulletList.length;

    const angle: f32 = f32(t % 100000) / 5000.0;

    for (let i: i32 = 0; i < count; ++i) {
        const bullet = BulletList[i];

        const x = ObjectToScreen(bullet.x, sx);
        const y = ObjectToScreen(bullet.y, sy);

        if (!IsObjectOnScreen(x, y, 0.04)) {
            continue;
        }

        bullet_prog.DrawBullet(
            kTeamColors[bullet.team],
            x, y, 0.04, bullet.angle0 + angle, t);
    }
}

function RenderBombs(t: u64, sx: f32, sy: f32): void {
    const count = BombList.length;

    const angle: f32 = f32(t % 100000) / 4000.0;

    for (let i: i32 = 0; i < count; ++i) {
        const bomb = BombList[i];

        const x = ObjectToScreen(bomb.x, sx);
        const y = ObjectToScreen(bomb.y, sy);

        if (!IsObjectOnScreen(x, y, 0.1)) {
            continue;
        }

        bomb_prog.DrawBomb(
            kTeamColors[bomb.team],
            x, y, 0.1, bomb.angle0 + angle, t);
    }
}

function RenderArrows(t: u64, sx: f32, sy: f32): void {
    const players_count = player_list.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = player_list[i];

        if (player.on_screen || player.is_self) {
            continue;
        }

        let x: f32 = ObjectToScreen(player.x, sx);
        let y: f32 = ObjectToScreen(player.y, sy);
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

        arrow_prog.DrawArrow(
            kTeamColors[player.team],
            x, y, scale, angle, t);
    }
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

    sendUnreliable(buffer);
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

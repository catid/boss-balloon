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

declare function sendReliable(buffer: Uint8Array): void;
declare function sendUnreliable(buffer: Uint8Array): void;
declare function playExplosion(): void;
declare function playLaser(): void;
declare function serverLoginGood(): void;
declare function serverLoginBad(reason: string): void;

export const UINT8ARRAY_ID = idof<Uint8Array>();

let TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
let MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();
let TimeConverter: Netcode.TimeConverter = new Netcode.TimeConverter(0);


//------------------------------------------------------------------------------
// Player

let SelfId: i32 = -1;

class PositionMessage {
    valid: bool = false;

    t: u64;

    x: u16;
    y: u16;
    size: u8;
    vx: i8;
    vy: i8;
    not_moving: u8;
    accel_angle: u8;

    constructor() {
    }

    SetFromBuffer(t: u64, buffer: Uint8Array, offset: i32): void {
        this.valid = true;

        this.t = t;

        let ptr: usize = buffer.dataStart + offset;

        // Note: Skip player id at offset 0
        this.x = load<u16>(ptr, 1);
        this.y = load<u16>(ptr, 3);

        let bf: u16 = load<u16>(ptr, 5);

        this.size = u8(bf & 15);
        this.vx = i8((bf >> 4) & 31) - 16;
        this.vy = i8((bf >> (4+5)) & 31) - 16;
        this.not_moving = u8((bf >> (4+5+5))) & 1;

        this.accel_angle = load<u8>(ptr, 7);
    }
};

class Player {
    id: u8 = 0;
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;
    name: string = "";

    size: u8 = 0;
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;
    ax: f32 = 0;
    ay: f32 = 0;

    LastPositionMessage: PositionMessage = new PositionMessage();

    name_data: RenderTextData | null = null;

    constructor() {
    }
};

let player_map = new Map<u8, Player>();

function OnPlayerKilled(killer: Player, killee: Player): void {

}

function OnChat(player: Player, m: string): void {
    consoleLog("Chat: " + m.toString());
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

            sendUnreliable(Netcode.MakeTimeSyncPong(remote_send_ts, TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = TimeSync.ExpandLocalTime_FromTS23(t, ping_ts);
            let pong: u64 = TimeSync.ExpandLocalTime_FromTS23(t, pong_ts);

            if (pong < ping || t < pong) {
                consoleLog("*** TEST FAILED!");
                consoleLog("Ping T = " + ping.toString());
                consoleLog("Pong T = " + pong.toString());
                consoleLog("Recv T = " + t.toString());
                TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ServerPosition && remaining >= 6) {
            let peer_ts: u32 = Netcode.Load24(ptr, 1);

            TimeSync.OnTimeSample(t, peer_ts);
            t = TimeSync.PeerToLocalTime_FromTS23(peer_ts);

            const player_count: i32 = load<u8>(ptr, 4);
            const expected_bytes: i32 = 5 + player_count * 8; // 64 bits per player

            if (remaining < expected_bytes) {
                consoleLog("Truncated server position");
                break;
            }

            offset += 5;

            for (let i: i32 = 0; i < player_count; ++i) {
                let player_id: u8 = buffer[offset];
                if (player_map.has(player_id)) {
                    let player: Player = player_map.get(player_id);
                    player.LastPositionMessage.SetFromBuffer(t, buffer, offset);
                }

                offset += 8;
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

export function Initialize(): void {
    new RenderContext();

    firacode_font = new RenderTextProgram("textures/fira_code_sdf.png");
    player_prog = new RenderPlayerProgram();
    string_prog = new RenderStringProgram();
    bomb_prog = new RenderBombProgram();
    bullet_prog = new RenderBulletProgram();
    map_prog = new RenderMapProgram();
}


//------------------------------------------------------------------------------
// Weaponry

class BulletWeapon {
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;
    team: u8 = 0;
    t: u64 = 0;
}

class BombWeapon {
    x: f32 = 0;
    y: f32 = 0;
    vx: f32 = 0;
    vy: f32 = 0;
    team: u8 = 0;
    t: u64 = 0;
}

let BulletList: Array<BulletWeapon> = new Array<BulletWeapon>();
let BombList: Array<BombWeapon> = new Array<BombWeapon>();


//------------------------------------------------------------------------------
// Render

let render_last_msec: f64 = 0;

function ObjectToScreenX(x: f32, sx: f32): f32 {
    return (x - sx) * 0.001 + 0.5;
}
function ObjectToScreenY(y: f32, sy: f32): f32 {
    return (y - sy) * 0.001 + 0.5;
}

function RenderPlayers(t: u64, sx: f32, sy: f32): void {
    const players = player_map.values();
    const players_count = players.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = players[i];

        const x = ObjectToScreenX(player.x, sx);
        const y = ObjectToScreenY(player.y, sy);

        player_prog.DrawPlayer(
            1.0, 0.5, 0.5,
            x, y, 0.02, t);
    }

    firacode_font.BeginRender();

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = players[i];

        if (player.name_data == null) {
            continue;
        }

        firacode_font.SetColor(0.5, 1.0, 0.5,  0.0, 0.0, 0.0);

        const x = ObjectToScreenX(player.x, sx);
        const y = ObjectToScreenY(player.y, sy);

        firacode_font.Render(
            RenderTextHorizontal.Center, RenderTextVertical.Center,
            x, y + 0.02,
            0.1/player.name_data!.width, player.name_data!);
    }
}

function RenderBullets(t: u64, sx: f32, sy: f32): void {
    const count = BulletList.length;

    for (let i: i32 = 0; i < count; ++i) {
        const bullet = BulletList[i];

        const x = ObjectToScreenX(bullet.x, sx);
        const y = ObjectToScreenY(bullet.y, sy);

        bullet_prog.DrawBullet(
            1.0, 1.0, 0.5,
            x, y, 0.02, t);
    }
}

function RenderBombs(t: u64, sx: f32, sy: f32): void {
    const count = BombList.length;

    for (let i: i32 = 0; i < count; ++i) {
        const bomb = BombList[i];

        const x = ObjectToScreenX(bomb.x, sx);
        const y = ObjectToScreenY(bomb.y, sy);

        bomb_prog.DrawBomb(
            1.0, 1.0, 0.5,
            x, y, 0.05, t);
    }
}

function SimulationStep(dt: f32): void {
    const players = player_map.values();
    const players_count = players.length;

    for (let i: i32 = 0; i < players_count; ++i) {
        const player = players[i];

        // TODO: Make slower if ship is larger

        const inv_mass: f32 = 1.0 / 1.0;

        let ax: f32 = player.ax * inv_mass;
        let ay: f32 = player.ay * inv_mass;

        let vx = player.vx + ax * dt;
        let vy = player.vy + ay * dt;

        const friction: f32 = 0.001;
        const vf: f32 = friction * inv_mass;

        if (vx > vf) {
            vx -= vf;
        } else if (vx < -vf) {
            vx += vf;
        } else {
            vx = 0;
        }

        if (vy > vf) {
            vy -= vf;
        } else if (vy < -vf) {
            vy += vf;
        } else {
            vy = 0;
        }

        const mag: f32 = f32(Math.sqrt(vx * vx + vy * vy));
        const limit: f32 = 1.0;
        if (mag > limit) {
            const norm_factor = limit / mag;
            vx *= norm_factor;
            vy *= norm_factor;
        }

        player.vx = vx;
        player.vy = vy;

        player.x += vx * dt;
        player.y += vy * dt;
    }

    const bomb_count = BombList.length;

    for (let i: i32 = 0; i < bomb_count; ++i) {
        const bomb = BombList[i];

        bomb.x += bomb.vx * dt;
        bomb.y += bomb.vy * dt;
    }

    const bullet_count = BulletList.length;

    for (let i: i32 = 0; i < bullet_count; ++i) {
        const bullet = BulletList[i];

        bullet.x += bullet.vx * dt;
        bullet.y += bullet.vy * dt;
    }
}

function Physics(dt: f32): void {
    while (dt >= 10.0) {
        SimulationStep(10.0);
        dt -= 10.0;
    }

    if (dt > 0) {
        SimulationStep(dt);
    }
}

let hack_last_bullet_fire: u64 = 0;
let hack_bomb_counter: i32 = 0;

export function RenderFrame(
    now_msec: f64,
    finger_x: i32, finger_y: i32,
    canvas_w: i32, canvas_h: i32): void
{
    let dt: f64 = now_msec - render_last_msec;
    if (dt > 5000) {
        dt = 0;
    }
    render_last_msec = now_msec;

    RenderContext.I.UpdateViewport(canvas_w, canvas_h);
    RenderContext.I.Clear();

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = TimeConverter.MsecToTime(now_msec);

    let pointer_active: bool = (finger_x >= 0 && finger_x < canvas_w && finger_y >= 0 && finger_y < canvas_w);

    let self: Player | null = null;
    if (SelfId != -1 && player_map.has(u8(SelfId))) {
        self = player_map.get(u8(SelfId));
    }
    if (self != null) {
        self.ax = 0;
        self.ay = 0;

        if (pointer_active) {
            const fcx = finger_x - canvas_w / 2;
            const fcy = finger_y - canvas_h / 2;
            const mag: f32 = f32(Math.sqrt(fcx * fcx + fcy * fcy));
            if (mag > f32(canvas_w / 10)) {
                const limit: f32 = 0.001;
                if (mag > 0) {
                    self.ax = f32(fcx) * limit / mag;
                    self.ay = f32(fcy) * limit / mag;
                }
            }
        }
    }

    Physics(f32(dt));

    let sx: f32 = 0, sy: f32 = 0;
    if (self != null) {
        sx = self.x;
        sy = self.y;

        const weapon_dt = i64(t - hack_last_bullet_fire);
        if (weapon_dt > 500 * 4) {
            let vx = self.vx;
            let vy = self.vy;

            if (vx == 0.0 && vy == 0.0) {
                vy = 1.0;
            }

            const bullet_speed: f32 = 0.5;

            const mag: f32 = f32(Math.sqrt(vx * vx + vy * vy));
            const vfactor = bullet_speed / mag;
            vx *= vfactor;
            vy *= vfactor;

            if (hack_bomb_counter == 0) {
                const bomb = new BombWeapon;
                bomb.vx = self.vx + vx;
                bomb.vy = self.vy + vy;
                bomb.x = self.x;
                bomb.y = self.y;
                bomb.t = t;
                BombList.push(bomb);
            } else {
                const bullet = new BulletWeapon;
                bullet.vx = self.vx + vx;
                bullet.vy = self.vy + vy;
                bullet.x = self.x;
                bullet.y = self.y;
                bullet.t = t;
                BulletList.push(bullet);
            }
            hack_bomb_counter++;
            if (hack_bomb_counter >= 4) {
                hack_bomb_counter = 0;
            }
            hack_last_bullet_fire = t;
        }
    }

    map_prog.DrawMap(sx/1000.0, sy/1000.0, 1.0, t);

    RenderPlayers(t, sx, sy);
    RenderBombs(t, sx, sy);
    RenderBullets(t, sx, sy);

    if (pointer_active) {
        string_prog.DrawString(
            1.0, 1.0, 1.0,
            f32(finger_x) / f32(canvas_w),
            f32(finger_y) / f32(canvas_h),
            0.5, 0.5,
            t);
    }

    // Collect GC after render tasks are done
    __collect();
}

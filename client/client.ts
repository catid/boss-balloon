//------------------------------------------------------------------------------
// Imports

import { RenderContext } from "./gl/RenderContext";
import { Box3 } from "../node_modules/as-3d-math/src/as/index";
import { Netcode, consoleLog, getMilliseconds } from "../netcode/netcode";

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
// Initialization

export function Initialize(): void {
    new RenderContext();
}


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
    x: i32 = 0;
    y: i32 = 0;
    vx: i32 = 0;
    vy: i32 = 0;
    ax: i32 = 0;
    ay: i32 = 0;

    LastPositionMessage: PositionMessage = new PositionMessage();

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
// Render

let render_last_msec: f64 = 0;

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

    //consoleLog("TEST: " + dt.toString() + " at " + finger_x.toString() + ", " + finger_y.toString());

    // Collect GC after render tasks are done
    __collect();
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

            offset += 15 + name_len;
        } else if (type == Netcode.ReliableType.RemovePlayer && remaining >= 2) {
            player_map.delete(load<u8>(ptr, 1));
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

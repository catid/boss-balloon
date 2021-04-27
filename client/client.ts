//------------------------------------------------------------------------------
// Imports

import { RenderContext } from "./gl/RenderContext";
import { Box3 } from "../node_modules/as-3d-math/src/as/index";
import { Netcode } from "../netcode/netcode";

declare function consoleLog(message: string): void;
declare function sendReliable(buffer: Uint8Array): void;
declare function sendUnreliable(buffer: Uint8Array): void;
declare function playExplosion(): void;
declare function playLaser(): void;
declare function serverLoginGood(): void;
declare function serverLoginBad(reason: string): void;

export const UINT8ARRAY_ID = idof<Uint8Array>();


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

    t: i64;

    x: u16;
    y: u16;
    size: u8;
    vx: i8;
    vy: i8;
    not_moving: u8;
    accel_angle: u8;

    constructor() {
    }

    SetFromBuffer(t: i64, buffer: Uint8Array, offset: i32): void {
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

}


//------------------------------------------------------------------------------
// Render

// For netcode we use timestamps relative to the connection open time, because
// we waste fewer mantissa bits on useless huge values.
let netcode_start_msec: f64 = 0;
let last_msec: f64 = 0;

export function RenderFrame(
    now_msec: f64,
    finger_x: i32, finger_y: i32,
    canvas_w: i32, canvas_h: i32): void
{
    let dt: f64 = now_msec - last_msec;
    if (dt > 5000) {
        dt = 0;
    }
    last_msec = now_msec;

    RenderContext.I.UpdateViewport(canvas_w, canvas_h);
    RenderContext.I.Clear();

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: i64 = i64((now_msec - netcode_start_msec) * 4.0);

    //consoleLog("TEST: " + dt.toString() + " at " + finger_x.toString() + ", " + finger_y.toString());

    // Collect GC after render tasks are done
    __collect();
}


//------------------------------------------------------------------------------
// Time Synchronization

class SampleTS24 {
    value: u32 = 0; // 24-bit
    t: i64 = 0; // recv msec

    constructor(value: u32 = 0, t: i64 = 0) {
        this.value = value;
        this.t = t;
    }

    TimeoutExpired(now: i64, timeout: i64): Boolean {
        return u64(now - this.t) > timeout;
    }

    CopyFrom(sample: SampleTS24): void {
        this.value = sample.value;
        this.t = sample.t;
    }
}

class WindowedMinTS24 {
    samples: Array<SampleTS24> = new Array<SampleTS24>(3);

    constructor() {
    }

    IsValid(): Boolean {
        return this.samples[0].value != 0;
    }

    GetBest(): u32 {
        return this.samples[0].value;
    }

    Reset(sample: SampleTS24 | null) {
        if (!sample) {
            sample = new SampleTS24();
        }
        this.samples[0].CopyFrom(sample);
        this.samples[1].CopyFrom(sample);
        this.samples[2].CopyFrom(sample);
    }

    Update(value: u32, t: i64, window_length: i64): void {

    }
}

function OnTimeSample(recv_msec: i64, peer_ts: u32): i64 {
    // FIXME
}

function OnTimeMinDelta(recv_msec: i64, min_delta: u32): i64 {
    // FIXME
}

function PeerToLocal(recv_msec: i64, peer_ts: u32): i64 {
    // FIXME
}

function LocalToPeer(t_msec: i64): u32 {
    // FIXME
}


//------------------------------------------------------------------------------
// Connection

export function OnConnectionOpen(now_msec: f64): void {
    consoleLog("UDP link up");

    netcode_start_msec = now_msec;
    player_map.clear();
    SelfId = -1;
}

export function OnConnectionClose(): void {
    consoleLog("UDP link down");
}

export function OnConnectionUnreliableData(recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    let offset: i32 = 0;
    while (offset < buffer.length) {
        const remaining: i32 = buffer.length - offset;
        const type: u8 = buffer[offset];

        if (type == Netcode.UnreliableType.TimeSync && remaining >= 7) {
            // Convert timestamp to integer with 1/4 msec (desired) precision
            let t: i64 = i64((recv_msec - netcode_start_msec) * 4.0);

            let ptr: usize = buffer.dataStart + offset;

            let peer_ts: u32 = load<u16>(ptr, 1);
            peer_ts |= u32(load<u8>(ptr, 3)) << 16;

            let min_delta: u32 = load<u16>(ptr, 4);
            min_delta |= u32(load<u8>(ptr, 6)) << 16;

            OnTimeSample(t, peer_ts);
            OnTimeMinDelta(t, min_delta);

            offset += 7;
        } else if (type == Netcode.UnreliableType.ServerPosition && remaining >= 6) {
            // Convert timestamp to integer with 1/4 msec (desired) precision
            let t: i64 = i64((recv_msec - netcode_start_msec) * 4.0);

            let ptr: usize = buffer.dataStart + offset;

            let peer_ts: u32 = load<u16>(ptr, 1);
            peer_ts |= u32(load<u8>(ptr, 3)) << 16;

            OnTimeSample(t, peer_ts);
            t = PeerToLocal(t, peer_ts);

            const player_count: i32 = load<u8>(ptr, 4);
            const expected_bytes: i32 = 5 + player_count * 8; // 64 bits per player

            if (remaining < expected_bytes) {
                consoleLog("Truncated server position");
                break;
            }

            offset += 5;

            for (let i: i32 = 0; i < player_count; ++i) {
                let player_id: u8 = buffer[offset];
                let player: Player = player_map.get(player_id);
                if (player != null) {
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

// type e.g. Netcode.ReliableType.ClientRegister
export function SendClientRegisterOrLogin(type: u8, name: string, password: string): i32 {
    let name_len: i32 = String.UTF8.byteLength(name, false);
    let password_len: i32 = String.UTF8.byteLength(password, false);

    if (name_len <= 0 || name_len >= 256) {
        return -1;
    }
    if (password_len <= 0 || password_len >= 256) {
        return -1;
    }

    let buffer: Uint8Array = new Uint8Array(3 + name_len + password_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, type, 0);
    store<u8>(ptr, u8(name_len), 1);

    // If dataStart stops working we can use this instead:
    // changetype<usize>(buffer) + buffer.byteOffset

    String.UTF8.encodeUnsafe(
        changetype<usize>(name),
        name.length,
        ptr + 2,
        false);

    store<u8>(ptr + name_len, u8(password_len), 2);

    String.UTF8.encodeUnsafe(
        changetype<usize>(password),
        password.length,
        ptr + 3 + name_len,
        false);

    sendReliable(buffer);
    return 0;
}

export function SendChatRequest(m: string): i32 {
    let m_len: i32 = String.UTF8.byteLength(m, false);

    if (m_len <= 0 || m_len >= 512) {
        return -1;
    }

    let buffer: Uint8Array = new Uint8Array(3 + m_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.ChatRequest, 0);
    store<u16>(ptr, u16(m_len), 1);

    // If dataStart stops working we can use this instead:
    // changetype<usize>(buffer) + buffer.byteOffset

    String.UTF8.encodeUnsafe(
        changetype<usize>(m),
        m.length,
        ptr + 3,
        false);

    sendReliable(buffer);
    return 0;
}

export function OnConnectionReliableData(buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr = buffer.dataStart + offset;

        const type: u8 = load<u8>(ptr, 0);
        if (type == Netcode.ReliableType.SetId && buffer.length >= 2) {
            SelfId = load<u8>(ptr, 1);
            offset += 2;
        } else if (type == Netcode.ReliableType.ServerLoginGood) {
            serverLoginGood();
            offset++;
        } else if (type == Netcode.ReliableType.ServerLoginBad && buffer.length >= 3) {
            let len: i32 = load<u16>(ptr, 1);
            if (len + 3 > buffer.length) {
                consoleLog("Truncated loginbad response");
                return;
            }

            let s: string = String.UTF8.decodeUnsafe(ptr + 3, len, false);

            serverLoginBad(s);

            offset += 3 + len;
        } else if (type == Netcode.ReliableType.SetPlayer && buffer.length >= 15) {
            let id: u8 = load<u8>(ptr, 1);
            let player: Player = player_map.get(id);
            if (player == null) {
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
            if (offset + 15 + name_len > buffer.length) {
                consoleLog("Truncated setplayer");
                return;
            }

            player.name = String.UTF8.decodeUnsafe(ptr + 15, name_len, false);

            offset += 15 + name_len;
        } else if (type == Netcode.ReliableType.RemovePlayer && buffer.length >= 2) {
            player_map.delete(load<u8>(ptr, 1));
            offset += 2;
        } else if (type == Netcode.ReliableType.PlayerKill && buffer.length >= 7) {
            let killer_id: u8 = load<u8>(ptr, 1);
            let killee_id: u8 = load<u8>(ptr, 2);
            let killer: Player = player_map.get(killer_id);
            let killee: Player = player_map.get(killee_id);
            if (killer != null && killee != null) {
                killer.score = load<u16>(ptr, 3);
                killee.score = load<u16>(ptr, 5);

                OnPlayerKilled(killer, killee);
            }
            offset += 7;
        } else if (type == Netcode.ReliableType.Chat && buffer.length >= 4) {
            let id: u8 = load<u8>(ptr, 1);
            let m_len: u16 = load<u16>(ptr, 2);

            if (offset + 4 + m_len > buffer.length) {
                consoleLog("Truncated chat");
                return;
            }

            let player: Player = player_map.get(id);
            if (player != null) {
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

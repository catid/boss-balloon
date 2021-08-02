import { RenderContext } from "./render/render_context"
import { RenderTextData, RenderTextProgram, RenderTextHorizontal, RenderTextVertical } from "./render/render_text"
import { RenderPlayerProgram, RenderPlayerData } from "./render/render_player"
import { RenderStringProgram } from "./render/render_string"
import { RenderBombProgram } from "./render/render_bomb"
import { RenderBulletProgram } from "./render/render_bullet"
import { RenderMapProgram } from "./render/render_map"
import { RenderArrowProgram } from "./render/render_arrow"
import { RenderSunProgram } from "./render/render_sun"
import { RenderColor } from "./render/render_common"
import { Physics } from "../common/physics"
import { jsPlayMusic, jsSendReliable, jsSendUnreliable, jsServerLoginBad, jsServerLoginGood } from "./javascript"
import { jsConsoleLog, jsGetMilliseconds } from "../common/javascript"
import { Netcode } from "../common/netcode"


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

// If someone is much larger, switch to boss battle music
const kMusicSizeDelta: i32 = 6;


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

function clamp_f32(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
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

    is_self: bool = false;

    temp_screen_x: f32 = 0;
    temp_screen_y: f32 = 0;
    on_screen: bool = false;

    // Time at which we last received a position packet for this player
    last_position_local_ts: u64 = 0;

    Collider: Physics.PlayerCollider;

    name: string = "...";
    render_name_data: RenderTextData | null = null;

    constructor(team: u8) {
        this.Collider = Physics.CreatePlayerCollider(team);
        this.Collider.client_render_player = this;
    }

    SetName(name: string): void {
        this.name = name;
        this.render_name_data = FontProgram.GenerateLine(name);
    }
};

export let SelfNetworkId: i32 = -1;
export let PlayerMap = new Map<u8, Player>();
export let PlayerList: Array<Player> = new Array<Player>(0);

// Temporary self/player list for current frame
export let HasFrameSelf: bool = false;
export let FrameSelf: Player;

export function UpdateFrameInfo(): void {
    HasFrameSelf = false;
    if (SelfNetworkId != -1 && PlayerMap.has(u8(SelfNetworkId))) {
        FrameSelf = PlayerMap.get(u8(SelfNetworkId));
        HasFrameSelf = true;
    }
}


//------------------------------------------------------------------------------
// Render

let render_player_ts: u64;

function RenderPlayers(local_ts: u64): void {
    render_player_ts = local_ts;

    Physics.ForEachPlayerOnScreen((p: Physics.PlayerCollider, sx: f32, sy: f32) => {
        p.on_screen = true;

        // Calculate shine from sun
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
        const shine_dist: f32 = clamp_f32(1.0 - (sun_x * sun_x + sun_y * sun_y) / (shine_max * shine_max), 0.5, 1.0);

        PlayerProgram.DrawPlayer(
            kTeamColors[p.team],
            sx, sy, p.r * Physics.MapToScreen, shine_angle, shine_dist, render_player_ts);

        StringProgram.DrawString(kTeamColors[p.team], sx, sy, sx + p.vx * 0.1, sy + p.vy * 0.1, render_player_ts);

        const r: Player = p.client_render_player!;

        if (r.render_name_data != null) {
            FontProgram.BeginRender();
            FontProgram.SetColor(kTeamTextColors[p.team],  kTextStrokeColor);
            FontProgram.Render(
                RenderTextHorizontal.Center, RenderTextVertical.Center,
                sx, sy + p.r * Physics.MapToScreen,
                0.32 * Physics.InvScreenScale / r.render_name_data!.width, r.render_name_data!);
        }
    });
}

let proj_angle: f32;

function RenderProjectiles(local_ts: u64): void {
    proj_angle = f32(local_ts % 10000) * Mathf.PI * 2.0 / 10000.0;

    BombProgram.BeginBombs(local_ts, 0.1 * Physics.InvScreenScale);

    Physics.ForEachBombOnScreen((p: Physics.Projectile, sx: f32, sy: f32) => {
        BombProgram.DrawBomb(kTeamColors[p.team], sx, sy, p.angle0 + proj_angle);
    });

    BulletProgram.BeginBullets(local_ts, 0.05 * Physics.InvScreenScale);

    Physics.ForEachBulletOnScreen((p: Physics.Projectile, sx: f32, sy: f32) => {
        BulletProgram.DrawBullet(kTeamColors[p.team], sx, sy, p.angle0 + proj_angle);
    });
}

function RenderArrows(local_ts: u64): void {
    const players_count = PlayerList.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];

        if (p.Collider.on_screen || p.is_self || p.Collider.is_ghost) {
            continue;
        }

        let x: f32 = Physics.MapToScreenX(p.Collider.x);
        let y: f32 = Physics.MapToScreenY(p.Collider.y);
        const dist: f32 = Mathf.sqrt(x * x + y * y);
        const scale_min: f32 = 0.01;
        const scale_max: f32 = 0.04;
        const scale: f32 = scale_min + clamp_f32(scale_max - dist * 0.004, 0.0, scale_max - scale_min);

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
            kTeamColors[p.Collider.team],
            x, y, scale, angle, local_ts);
    }
}


//------------------------------------------------------------------------------
// Music

let last_music_change: u64 = 0;
let active_music: string = "chill";
let next_music: string = "";
let next_music_ts: u64 = 0;

function UpdateMusic(t: u64): void {
    if (!HasFrameSelf) {
        return;
    }

    // Do not change music faster than 10 seconds.
    const dt: i64 = i64(t - last_music_change);
    if (dt < 10_000 * 4) {
        return;
    }

    let enemy_near: bool = false;
    let highest_size: i32 = 0;

    const players_count = PlayerList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];

        if (p.Collider.team == FrameSelf.Collider.team) {
            continue;
        }

        // Wide radius around screen

        if (Physics.IsMapObjectOnScreen(p.Collider.x, p.Collider.y, p.Collider.r * Physics.MapToScreen)) {
            enemy_near = true;
            if (highest_size < i32(p.Collider.size)) {
                highest_size = i32(p.Collider.size);
            }
        }
    }

    let music: string = "chill";

    if (enemy_near) {
        const diff: i32 = highest_size - i32(FrameSelf.Collider.size);
        if (diff > kMusicSizeDelta) {
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

function OnPlayerKilled(killer: Player, killee: Player): void {
    jsConsoleLog(killer.name + " killed " + killee.name);
}

function OnChat(p: Player, m: string): void {
    jsConsoleLog("<" + p.name + "> " + m.toString());
}


//------------------------------------------------------------------------------
// Connection

let is_connection_open: bool = false;

export function OnConnectionOpen(now_msec: f64): void {
    is_connection_open = true;

    jsConsoleLog("UDP link up");

    Physics.Initialize(false, now_msec, (killee: Physics.PlayerCollider, killer: Physics.PlayerCollider) => {
        // FIXME: Handle bullet collision
    });

    PlayerMap.clear();
    SelfNetworkId = -1;
    TimeSync = new Netcode.TimeSync();

    SendTimeSync();

    let chat = Netcode.MakeChatRequest("Hello World");
    if (chat != null) {
        jsSendReliable(chat);
    }
}

export function OnReliableSendTimer(): void {
    let buffer : Uint8Array | null = MessageCombiner.PopNextDatagram();
    if (buffer == null) {
        return;
    }

    jsSendReliable(buffer);
}

export function OnConnectionClose(): void {
    jsConsoleLog("UDP link down");

    is_connection_open = false;
}


//------------------------------------------------------------------------------
// Message Deserializers

export function OnConnectionUnreliableData(recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let local_ts: u64 = Physics.ConvertWallclock(recv_msec);

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

            TimeSync.OnPeerSync(local_ts, remote_send_ts, min_trip_send_ts24_trunc, min_trip_recv_ts24_trunc, slope);

            //jsSendUnreliable(Netcode.MakeTimeSyncPong(remote_send_ts, TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = TimeSync.ExpandLocalTime_FromTS23(local_ts, ping_ts);
            let pong: u64 = TimeSync.ExpandLocalTime_FromTS23(local_ts, pong_ts);

            if (pong < ping || local_ts + 1 < pong) {
                jsConsoleLog("*** TEST FAILED!");
                jsConsoleLog("Ping T = " + ping.toString());
                jsConsoleLog("Pong T = " + pong.toString());
                jsConsoleLog("Recv T = " + local_ts.toString());
                TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ServerPosition && remaining >= 6) {
            let server_ts: u32 = Netcode.Load24(ptr, 1);
            let local_send_ts = TimeSync.PeerToLocalTime_FromTS23(server_ts);

            const bytes_per_client: i32 = 9;
            const player_count: i32 = load<u8>(ptr, 4);
            const expected_bytes: i32 = 5 + player_count * bytes_per_client;

            if (remaining < expected_bytes) {
                jsConsoleLog("Truncated server position");
                break;
            }

            let pptr: usize = ptr + 5;

            for (let i: i32 = 0; i < player_count; ++i) {
                const player_id: u8 = load<u8>(pptr, 0);
                if (PlayerMap.has(player_id)) {
                    const p: Player = PlayerMap.get(player_id);
                    if (p.is_self) {
                        continue;
                    }

                    const c: Physics.PlayerCollider = p.Collider;

                    if (c.is_ghost) {
                        jsConsoleLog("Player just spawned(on pos): " + p.name);
                        c.is_ghost = false;
                    }

                    p.last_position_local_ts = local_ts;

                    c.x = Netcode.Convert16toX(load<u16>(pptr, 1));
                    c.y = Netcode.Convert16toX(load<u16>(pptr, 3));
                    c.vx = Netcode.Convert8toVX(load<i8>(pptr, 5));
                    c.vy = Netcode.Convert8toVX(load<i8>(pptr, 6));

                    const aa: u16 = load<u16>(pptr, 7);
                    let ax: f32 = 0.0, ay: f32 = 0.0;
                    if (aa != 0) {
                        const angle: f32 = (aa - 1) * Netcode.inv_aa_factor;
                        ax = Mathf.cos(angle);
                        ay = Mathf.sin(angle);
                    }
                    c.ax = ax;
                    c.ay = ay;

                    const send_delay: i32 = i32(local_ts - local_send_ts);
                    Physics.IncorporateServerPosition(c, local_ts, send_delay, server_ts);
                }

                pptr += bytes_per_client;
            }

            offset += expected_bytes;
        } else if (type == Netcode.UnreliableType.ServerShot && remaining >= 6) {
            let server_ts: u32 = Netcode.Load24(ptr, 1);
            let local_send_ts = TimeSync.PeerToLocalTime_FromTS23(server_ts);

            const bytes_per_client: i32 = 10;
            const player_count: i32 = load<u8>(ptr, 4);
            const expected_bytes: i32 = 5 + player_count * bytes_per_client;

            if (remaining < expected_bytes) {
                jsConsoleLog("Truncated server position");
                break;
            }

            let pptr: usize = ptr + 5;

            for (let i: i32 = 0; i < player_count; ++i) {
                const player_id: u8 = load<u8>(pptr, 0);
                if (PlayerMap.has(player_id)) {
                    const p: Player = PlayerMap.get(player_id);
                    const c: Physics.PlayerCollider = p.Collider;

                    const size: u8 = load<u8>(pptr, 1);
                    if (c.size != size) {
                        // This also sets self size
                        c.SetSize(size);
                    }

                    const last_shot_x: f32 = Netcode.Convert16toX(load<u16>(pptr, 2));
                    const last_shot_y: f32 = Netcode.Convert16toX(load<u16>(pptr, 4));
                    const last_shot_vx: f32 = Netcode.Convert16toVX(load<i16>(pptr, 6));
                    const last_shot_vy: f32 = Netcode.Convert16toVX(load<i16>(pptr, 8));

                    // FIXME: Correct our shot positions too
                    //if (p.is_self)
                    {
                        if (c.is_ghost) {
                            jsConsoleLog("Player just spawned(on shot): " + p.name);
                            c.is_ghost = false;
                            c.x = last_shot_x;
                            c.y = last_shot_y;
                            c.vx = 0.0;
                            c.vy = 0.0;
                            c.ax = 0.0;
                            c.ay = 0.0;
                        }
                        //continue;
                    }

                    const send_delay: i32 = i32(local_ts - local_send_ts);

                    Physics.IncorporateServerShot(
                        c,
                        local_ts, send_delay, server_ts,
                        last_shot_x, last_shot_y,
                        last_shot_vx, last_shot_vy);
                }

                pptr += bytes_per_client;
            }

            offset += expected_bytes;
        } else {
            jsConsoleLog("Server sent invalid unreliable data: type = " + type.toString() + " remaining = " + remaining.toString());
            return;
        }
    }
}

function UpdateSelf(): void {
    const players_count = PlayerList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];
        p.is_self = i32(p.network_id) == SelfNetworkId;
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
            SelfNetworkId = i32(load<u8>(ptr, 1));
            UpdateSelf();

            offset += 2;
        } else if (type == Netcode.ReliableType.ServerLoginGood) {
            jsServerLoginGood();
            offset++;
        } else if (type == Netcode.ReliableType.ServerLoginBad && remaining >= 3) {
            let len: i32 = load<u16>(ptr, 1);
            if (len + 3 > remaining) {
                jsConsoleLog("Truncated loginbad response");
                return;
            }

            let s: string = String.UTF8.decodeUnsafe(ptr + 3, len, false);

            jsServerLoginBad(s);

            offset += 3 + len;
        } else if (type == Netcode.ReliableType.SetPlayer && remaining >= 15) {
            let network_id: u8 = load<u8>(ptr, 1);
            const team: u8 = load<u8>(ptr, 13);

            let player: Player | null = null;
            if (PlayerMap.has(network_id)) {
                player = PlayerMap.get(network_id);
            } else {
                player = new Player(team);
                PlayerMap.set(network_id, player);
                player.network_id = network_id;

                PlayerList.push(player);

                UpdateSelf();
            }

            player.score = load<u16>(ptr, 2);
            player.wins = load<u32>(ptr, 4);
            player.losses = load<u32>(ptr, 8);
            player.skin = load<u8>(ptr, 12);
            player.Collider.team = team;

            let name_len: u8 = load<u8>(ptr, 14);
            if (15 + name_len > remaining) {
                jsConsoleLog("Truncated setplayer");
                return;
            }

            player.SetName(String.UTF8.decodeUnsafe(ptr + 15, name_len, false));

            jsConsoleLog("SetPlayer: " + network_id.toString() + " = " + player.name.toString());

            offset += 15 + name_len;
        } else if (type == Netcode.ReliableType.RemovePlayer && remaining >= 2) {
            let id: u8 = load<u8>(ptr, 1);

            if (PlayerMap.has(id)) {
                const player = PlayerMap.get(id);

                Physics.RemovePlayerCollider(player.Collider);

                PlayerMap.delete(id);
            }

            jsConsoleLog("RemovePlayer: " + id.toString());

            offset += 2;
        } else if (type == Netcode.ReliableType.PlayerKill && remaining >= 7) {
            let killer_id: u8 = load<u8>(ptr, 1);
            let killee_id: u8 = load<u8>(ptr, 2);
            if (PlayerMap.has(killer_id) && PlayerMap.has(killee_id)) {
                let killer: Player = PlayerMap.get(killer_id);
                let killee: Player = PlayerMap.get(killee_id);
                killer.score = load<u16>(ptr, 3);
                killee.score = load<u16>(ptr, 5);

                OnPlayerKilled(killer, killee);
            }
            offset += 7;
        } else if (type == Netcode.ReliableType.Chat && remaining >= 5) {
            let id: u8 = load<u8>(ptr, 1);
            let m_len: u16 = load<u16>(ptr, 2);

            if (4 + m_len > remaining) {
                jsConsoleLog("Truncated chat");
                return;
            }

            if (PlayerMap.has(id)) {
                let player: Player = PlayerMap.get(id);
                let m: string = String.UTF8.decodeUnsafe(ptr + 4, m_len, false);

                OnChat(player, m);
            }

            offset += 4 + m_len;
        } else {
            jsConsoleLog("Server sent invalid reliable data");
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
    const send_msec = jsGetMilliseconds();
    jsSendUnreliable(TimeSync.MakeTimeSync(Physics.ConvertWallclock(send_msec)));
}


//------------------------------------------------------------------------------
// Position Update

let last_position_send: u64 = 0;
let last_ax: f32 = 0.0;
let last_ay: f32 = 0.0;

export function SendPosition(t: u64): void {
    if (!HasFrameSelf) {
        return;
    }

    // Max send rate
    let dt: i64 = i64(t - last_position_send);
    if (dt < 100 * 4) {
        return;
    }

    const c: Physics.PlayerCollider = FrameSelf.Collider;

    // Min send rate if not rapidly navigating
    if (dt < 200 * 4) {
        if (Mathf.abs(c.ax - last_ax) < 0.3 &&
            Mathf.abs(c.ay - last_ay) < 0.3) {
            return;
        }
    }

    last_position_send = t;
    last_ax = c.ax;
    last_ay = c.ay;

    let buffer: Uint8Array = new Uint8Array(14);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.UnreliableType.ClientPosition, 0);

    let remote_ts: u32 = TimeSync.LocalToPeerTime_ToTS23(t);
    Netcode.Store24(ptr, 1, remote_ts);

    store<u16>(ptr, Netcode.ConvertXto16(c.x), 4);
    store<u16>(ptr, Netcode.ConvertXto16(c.y), 6);
    store<i16>(ptr, Netcode.ConvertVXto16(c.vx), 8);
    store<i16>(ptr, Netcode.ConvertVXto16(c.vy), 10);
    store<u16>(ptr, Netcode.ConvertAccelto16(c.ax, c.ay), 12);

    jsSendUnreliable(buffer);
}


//------------------------------------------------------------------------------
// Initialization

export const UINT8ARRAY_ID = idof<Uint8Array>();

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

    if (!is_connection_open) {
        return;
    }

    // Convert timestamp to integer with 1/4 msec (desired) precision
    const local_ts: u64 = Physics.ConvertWallclock(now_msec);
    const server_ts: u64 = TimeSync.TransformLocalToRemote(local_ts);

    // Update positions to current time
    Physics.SimulateTo(local_ts, server_ts);

    // Update HasFrameSelf, FrameSelf, PlayerList
    UpdateFrameInfo();

    if (HasFrameSelf) {
        Physics.SetScreenCenter(FrameSelf.Collider.x, FrameSelf.Collider.y);
        Physics.SetScreenScale(Physics.ScaleForSize(FrameSelf.Collider.size));
    } else {
        Physics.SetScreenCenter(0.0, 0.0);
        Physics.SetScreenScale(1.0);
    }

    // Render screen coordinates for finger touch
    // Note: Render screen origin is (0,0) and corners are (-1,-1) -> (1,1)
    const fsx: f32 = f32(finger_x) / f32(canvas_w) * 2.0 - 1.0;
    const fsy: f32 = f32(finger_y) / f32(canvas_h) * 2.0 - 1.0;

    // Is the finger on the screen?
    const finger_on_screen: bool = Physics.IsScreenXYVisible(fsx, fsy, 0.0);

    // Now change acceleration at current time
    if (HasFrameSelf) {
        FrameSelf.Collider.ax = 0;
        FrameSelf.Collider.ay = 0;

        if (finger_on_screen) {
            const mag: f32 = Mathf.sqrt(fsx * fsx + fsy * fsy);
            const dead_zone: f32 = 0.1;
            if (mag > dead_zone) {
                const accel: f32 = 0.001;
                FrameSelf.Collider.ax = fsx * accel / mag;
                FrameSelf.Collider.ay = fsy * accel / mag;
            }
        }
    }

    // Include latest position and acceleration in position update message
    SendPosition(local_ts);

    // Rendering:

    // Clear on_screen flag for all players
    const players_count: i32 = PlayerList.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const p = PlayerList[i];
        p.Collider.on_screen = false;
    }

    // Render map with correct offset and scale
    const origin_sx = Physics.MapToScreenX(0.0);
    const origin_sy = Physics.MapToScreenY(0.0);
    {
        const origin_dx = Physics.MapDiff(Physics.ScreenCenterX, 0.0);
        const origin_dy = Physics.MapDiff(Physics.ScreenCenterY, 0.0);
        const origin_dist = Mathf.max(Mathf.abs(origin_dx), Mathf.abs(origin_dy)) / (Physics.kMapWidth * 0.5);
        const map_color: f32 = Mathf.pow(origin_dist, 5.0) * 10.0;
        MapProgram.DrawMap(-origin_sx, -origin_sy, Physics.ScreenScale, map_color, local_ts);
    }

    // Fills in on_screen that is used by RenderArrows later
    RenderPlayers(local_ts);

    RenderProjectiles(local_ts);

    const sun_radius: f32 = 1.4 * Physics.InvScreenScale;
    if (Physics.IsScreenXYVisible(origin_sx, origin_sy, sun_radius)) {
        SunProgram.DrawSun(origin_sx, origin_sy, sun_radius, local_ts);
    }

    RenderArrows(local_ts);

    if (HasFrameSelf) {
        // Draw string to finger position
        if (finger_on_screen) {
            StringProgram.DrawString(
                kStringColor,
                fsx,
                fsy,
                0.0, 0.0, // center of screen
                local_ts);
        }
    }

    RenderContext.I.Flush();

    UpdateMusic(local_ts);
}

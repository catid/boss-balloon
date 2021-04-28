export namespace Netcode {

/*
    Maximum packet size = 1100 bytes before splitting,
    since there are about 64 bytes of overhead from WebRTC,
    and we want to conservatively fit within UDP/IPv6 frame MTU.
*/
export const kMaxPacketBytes: i32 = 1100;


/*
    Unreliable packet formats:

    All packets can be appended to eachother.

    [UnreliableType.TimeSync(1 byte)] [Local-24bit-SendTimestamp(3 bytes)] [Remote-24bit-MinDelta(3 bytes)]
    Sent once a second by both sides to establish time sync.

    [UnreliableType.TimeSyncPong(1 byte)] [Timestamp from sender(3 bytes)] [Remote-23bit-SendTimestamp(3 bytes)]
    Reply to TimeSync.  Used to test the time sync code.

    [UnreliableType.ClientPosition(1 byte)] [Client-23bit-SendTimestamp(3 bytes)] [x(2 bytes)] [y(2 bytes)]
    Sent by client to request a position change.
    We use client time in the message to improve the time sync dataset.
    Finger position relative to center: ((x or y) - 32768) / 32768 = -1..1
*/

/*
    [UnreliableType.ServerPosition(1 byte)] [Server-23bit-PhysicsTimestamp(3 bytes)] [Player Count-1(1 byte)] Repeated (LSB-first): {
        [PlayerId(8 bits)]

        [x(16 bits)] [y(16 bits)]

        16-bit field:
            [Size(4 bits)]            (low bits)
            [vx(5 bits)] [vy(5 bits)]
            [Not Moving=1(1 bit)]
            [Reserved(1 bit)]         (high bits)

        [Acceleration Angle(8 bits)]
    }
    Sent by server to update client position.

    Each player takes 64 bits so it's just 8 bytes per player.

    Size of the ship implies number of guns firing bullets.
    Size=0 indicates dead player.
    Maybe: As gun count increases, the guns don't change positions, only new guns are added.

    Player (x, y) is in 1/2 pixel units.

    Player velocity (vx, vy) is in 1/2 pixels per 100 milliseconds, 2s complement,
    so ranging from -16 to 15.

    Acceleration is -1, 0 or 1 in x,y.

    Players all fire bullets when the server's timestamp is a multiple of 500.

    Player fire direction is the same as their velocity.
*/

export enum UnreliableType {
    TimeSync = 0,
    TimeSyncPong = 1,
    ClientPosition = 2,
    ServerPosition = 3,
}

/*
    Reliable packet formats:

    All packets can be appended to eachother.

    [ReliableType.SetId(1 byte)] [PlayerId(1 byte)]
    Server is assigning the client's info.


    [ReliableType.ClientLogin(1 byte)]
    [Name Length(1 byte)] [Name(NL bytes)]
    [Password Length(1 byte)] [Password(PL bytes)]
    Client is accessing a name.


    [ReliableType.ServerLoginGood(1 byte)]
    Player login accepted.

    [ReliableType.ServerLoginBad(1 byte)] [Reason Length(2 bytes)] [Reason String(X bytes)]
    Player login rejected and reason provided.


    [ReliableType.SetPlayer(1 byte)] [PlayerId(1 byte)]
    [Score(2 bytes)] [Wins(4 bytes)] [Losses(4 bytes)]
    [Skin(1 byte)] [Team(1 byte)] [Name Length(1 byte)] [Name(X bytes)]
    Add/update a player on the player list.

    [ReliableType.RemovePlayer(1 byte)] [PlayerId(1 byte)]
    Remove the player.

    [ReliableType.PlayerKill(1 byte)]
    [Killer PlayerId(1 byte)] [Killee PlayerId(1 byte)]
    [Killer New Score(2 bytes)] [Killee New Score(2 bytes)]
    Report a player kill.


    [ReliableType.ChatRequest(1 byte)] [Message Length(2 bytes)] [Message(X bytes)]
    Message to send to server.

    [ReliableType.Chat(1 byte)] [PlayerId(1 byte)] [Message Length(2 bytes)] [Message(X bytes)]
    Message received from server.
    Does not support historical messages from before they logged in.
*/

export enum ReliableType {
    SetId = 0,

    ClientLogin = 10,
    ServerLoginGood = 11,
    ServerLoginBad = 12,

    SetPlayer = 20,
    RemovePlayer = 21,
    PlayerKill = 22,

    ChatRequest = 30,
    Chat = 31,
}


//------------------------------------------------------------------------------
// Tools

export function Store24(ptr: usize, offset: usize, ts24: u32): void {
    store<u16>(ptr + offset, u16(ts24));
    store<u8>(ptr + offset + 2, u8(ts24 >> 16));
}

export function Load24(ptr: usize, offset: usize): u32 {
    let ts24: u32 = load<u16>(ptr + offset);
    ts24 |= u32(load<u8>(ptr + offset + 2)) << 16;
    return ts24;
}


//------------------------------------------------------------------------------
// Time Units

// For netcode we use timestamps relative to the connection open time, because
// we waste fewer mantissa bits on useless huge values.
let netcode_start_msec: f64 = 0;

export function SetStartMsec(msec: f64): void {
    netcode_start_msec = msec;
}

// Convert to internal integer time units from floating point performance.now() units
export function MsecToTime(msec: f64): u64 {
    return u64((msec - netcode_start_msec) * 4.0) & ~(u64(1) << 63);
}

const kMinDeltaWindowLength = 4 * 10_0000; // 10 seconds in our time units


//------------------------------------------------------------------------------
// Message Combiner

// Accumulates reliable messages to send together on a timer
export class MessageCombiner {
    messages: Array<Uint8Array> = new Array<Uint8Array>(0);

    constructor() {
    }

    Push(message: Uint8Array | null): void {
        if (message != null) {
            this.messages.push(message);
        }
    }

    PopNextDatagram(): Uint8Array | null {
        let datagram_bytes: i32 = 0;
        let combined: Array<Uint8Array> | null = null;

        while (this.messages.length > 0) {
            const first_len: i32 = this.messages[0].length;

            if (datagram_bytes + first_len > kMaxPacketBytes) {
                break;
            }

            datagram_bytes += first_len;
            if (combined == null) {
                combined = new Array<Uint8Array>(0);
            }
            combined.push(this.messages.shift());
        }

        if (combined == null) {
            return null;
        }

        let message: Uint8Array = new Uint8Array(datagram_bytes);
        let offset: i32 = 0;
        for (let i: i32 = 0; i < combined.length; ++i) {
            message.set(combined[i], offset);
            offset += combined[i].length;
        }

        return message;
    }
};


//------------------------------------------------------------------------------
// Time Synchronization

// x, y are 24-bit counters
// Returns true if x <= y
function TS24_IsLessOrEqual(x: u32, y: u32): bool {
    let temp: u32 = (x - y) & 0xffffff;
    return temp < 0x800000;
}

/*
    The bits in the smaller counter were all truncated from the correct
    value, so what needs to be determined now is all the higher bits.
    Examples:
    Recent    Smaller  =>  Expanded
    ------    -------      --------
    0x100     0xff         0x0ff
    0x16f     0x7f         0x17f
    0x17f     0x6f         0x16f
    0x1ff     0xa0         0x1a0
    0x1ff     0x01         0x201
    The choice to make is between -1, 0, +1 for the next bit position.
    Since we have no information about the high bits, it should be
    sufficient to compare the recent low bits with the smaller value
    in order to decide which one is correct:
    00 - ff = -ff -> -1
    6f - 7f = -10 -> 0
    7f - 6f = +10 -> 0
    ff - a0 = +5f -> 0
    ff - 01 = +fe -> +1
*/
function TS23ExpandFromTruncatedWithBias(recent: u64, trunc23: u32): u64 {
    const bias: u32 = 0x200000;
    const msb: u32 = 0x400000;

    let result: u64 = trunc23 | (recent & ~u64(0x7fffff));
    const recent_low: u32 = u32(recent) & 0x7fffff;

    // If recent - trunc would be negative:
    if (recent_low < trunc23)
    {
        // If it is large enough to roll back a MSB:
        const abs_diff: u32 = trunc23 - recent_low;
        if (abs_diff >= (msb - bias)) {
            result -= msb << 1;
        }
    }
    else
    {
        // If it is large enough to roll ahead a MSB:
        const abs_diff: u32 = recent_low - trunc23;
        if (abs_diff > (msb + bias)) {
            result += msb << 1;
        }
    }

    return result;
}

class SampleTS24 {
    value: u32 = 0; // 24-bit
    t: u64 = 0; // time in any units

    constructor(value: u32 = 0, t: u64 = 0) {
        this.value = value;
        this.t = t;
    }
    TimeoutExpired(now: u64, timeout: u64): bool {
        return u64(now - this.t) > timeout;
    }
    CopyFrom(sample: SampleTS24): void {
        this.value = sample.value;
        this.t = sample.t;
    }
    Set(value: u32 = 0, t: u64 = 0): void {
        this.value = value;
        this.t = t;
    }
}

class WindowedMinTS24 {
    samples: Array<SampleTS24> = new Array<SampleTS24>(3);

    constructor() {
        for (let i: i32 = 0; i < 3; ++i) {
            this.samples[i] = new SampleTS24();
        }
    }
    IsValid(): bool {
        return this.samples[0].value != 0;
    }
    GetBest(): u32 {
        return this.samples[0].value;
    }
    Reset(value: u32 = 0, t: u64 = 0): void {
        for (let i: i32 = 0; i < 3; ++i) {
            this.samples[i].Set(value, t);
        }
    }
    Update(value: u32, t: u64, window_length: u64): void {
        // On the first sample, new best sample, or if window length has expired:
        if (!this.IsValid() ||
            TS24_IsLessOrEqual(value, this.samples[0].value) ||
            this.samples[2].TimeoutExpired(t, window_length))
        {
            this.Reset(value, t);
            return;
        }

        // Insert the new value into the sorted array
        if (TS24_IsLessOrEqual(value, this.samples[1].value)) {
            this.samples[2].Set(value, t);
            this.samples[1].Set(value, t);
        } else if (TS24_IsLessOrEqual(value, this.samples[2].value)) {
            this.samples[2].Set(value, t);
        }

        // Expire best if it has been the best for a long time
        if (this.samples[0].TimeoutExpired(t, window_length)) {
            if (this.samples[1].TimeoutExpired(t, window_length)) {
                this.samples[0].CopyFrom(this.samples[2]);
                this.samples[1].Set(value, t);
            } else {
                this.samples[0].CopyFrom(this.samples[1]);
                this.samples[1].CopyFrom(this.samples[2]);
            }
            this.samples[2].Set(value, t);
            return;
        }

        // Quarter of window has gone by without a better value - Use the second-best
        if (this.samples[1].value == this.samples[0].value &&
            this.samples[1].TimeoutExpired(t, window_length / 4))
        {
            this.samples[1].Set(value, t);
            this.samples[2].Set(value, t);
            return;
        }

        // Half the window has gone by without a better value - Use the third-best one
        if (this.samples[2].value == this.samples[1].value &&
            this.samples[2].TimeoutExpired(t, window_length / 2))
        {
            this.samples[2].Set(value, t);
        }
    }
}

export class TimeSync {
    min_delta_calc_ts24: WindowedMinTS24 = new WindowedMinTS24();
    peer_min_delta_ts24: u32 = 0;
    clock_offset_ts23: i32 = 0;

    constructor() {
    }

    Reset(): void {
        this.peer_min_delta_ts24 = 0;
        this.clock_offset_ts23 = 0;
        this.min_delta_calc_ts24.Reset();
    }

    RecalculateClockOffset(): void {
        // min(OWD_i) + ClockDelta(L-R)_i
        let minRecvDelta_TS24: u32 = this.min_delta_calc_ts24.GetBest();
    
        // min(OWD_j) + ClockDelta(R-L)_j
        let minSendDelta_TS24: u32 = this.peer_min_delta_ts24;
    
        // Standard assumption: min(OWD_i) = min(OWD_j)
        // Given: ClockDelta(R-L)_j = -ClockDelta(L-R)_i
        // ClockDelta(R-L) ~= (ClockDelta(R-L)_j - ClockDelta(L-R)_i) / 2
        // Note we only get 23 valid bits not 24 out of this calculation.
        this.clock_offset_ts23 = ((minSendDelta_TS24 - minRecvDelta_TS24) >> 1) & 0x7fffff;
    }
    
    OnTimeSample(t: u64, peer_ts: u32): void {
        // OWD_i + ClockDelta(L-R)_i = Local Receive Time - Remote Send Time
        const delta = u32((t - peer_ts) & 0xffffff);
    
        this.min_delta_calc_ts24.Update(delta, t, kMinDeltaWindowLength);
    
        this.RecalculateClockOffset();
    }
    
    OnTimeMinDelta(t: u64, min_delta: u32): void {
        this.peer_min_delta_ts24 = min_delta;
    
        this.RecalculateClockOffset();
    }
    
    // Takes in a 23-bit timestamp in peer's clock domain,
    // and produces a full 64-bit timestamp in local clock domain.
    PeerToLocalTime_FromTS23(t: u64, peer_ts23: u32): u64 {
        // Offset = Remote - Local
        const local_ts23: u32 = peer_ts23 - this.clock_offset_ts23;
        return TS23ExpandFromTruncatedWithBias(t, local_ts23 & 0x7fffff);
    }

    // Produces a 23-bit timestamp in peer's clock domain.
    LocalToPeerTime_ToTS23(t: u64): u32 {
        return u32(t + this.clock_offset_ts23) & 0x7fffff;
    }

    // Takes in a full 64-bit timestamp in local clock domain,
    // and produces a truncated 23-bit timestamp in local clock domain.
    TruncateLocalTime_ToTS23(t: u64): u32 {
        return u32(t) & 0x7fffff;
    }

    // Takes in a 23-bit timestamp in local clock domain,
    // and produces a full 64-bit timestamp in local clock domain.
    ExpandLocalTime_FromTS23(t: u64, local_ts23: u32): u64 {
        return TS23ExpandFromTruncatedWithBias(t, local_ts23 & 0x7fffff);
    }

    MakeTimeSync(send_msec: f64): Uint8Array {
        let buffer: Uint8Array = new Uint8Array(7);
        let ptr: usize = buffer.dataStart;

        let min_delta: u32 = this.min_delta_calc_ts24.GetBest();
        let min_delta_trunc: u32 = u32(min_delta & 0xffffff);
    
        // Convert timestamp to integer with 1/4 msec (desired) precision
        let t: u64 = MsecToTime(send_msec);
        let t_trunc: u32 = u32(t & 0xffffff);
    
        store<u8>(ptr, Netcode.UnreliableType.TimeSync, 0);
        Netcode.Store24(ptr, 1, t_trunc);
        Netcode.Store24(ptr, 4, min_delta_trunc);

        return buffer;
    }
}


//------------------------------------------------------------------------------
// Common Serializers

// peer_ping_ts24: Taken from TimeSync received message.
// peer_pong_ts23: Local receive time converted to 23-bit remote timestamp.
export function MakeTimeSyncPong(peer_ping_ts24: u32, peer_pong_ts23: u32): Uint8Array {
    let buffer: Uint8Array = new Uint8Array(7);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.UnreliableType.TimeSyncPong, 0);
    Store24(ptr, 1, peer_ping_ts24);
    Store24(ptr, 4, peer_pong_ts23);

    return buffer;
}


//------------------------------------------------------------------------------
// Client Serializer

export function MakeChatRequest(m: string): Uint8Array | null {
    let m_len: i32 = String.UTF8.byteLength(m, false);

    if (m_len <= 0 || m_len >= 512) {
        return null;
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

    return buffer;
}

export function MakeClientLogin(name: string, password: string): Uint8Array | null {
    let name_len: i32 = String.UTF8.byteLength(name, false);
    let password_len: i32 = String.UTF8.byteLength(password, false);

    if (name_len <= 0 || name_len >= 256) {
        return null;
    }
    if (password_len <= 0 || password_len >= 256) {
        return null;
    }

    let buffer: Uint8Array = new Uint8Array(3 + name_len + password_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.ClientLogin, 0);
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

    return buffer;
}


//------------------------------------------------------------------------------
// Server Serializer

export function MakeSetId(id: u8): Uint8Array {
    let buffer: Uint8Array = new Uint8Array(2);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.SetId, 0);
    store<u8>(ptr, id, 1);

    return buffer;
}

export function MakeServerLoginGood(): Uint8Array {
    let buffer: Uint8Array = new Uint8Array(1);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.ServerLoginGood, 0);

    return buffer;
}

export function MakeServerLoginBad(m: string): Uint8Array | null {
    let m_len: i32 = String.UTF8.byteLength(m, false);

    if (m_len <= 0 || m_len >= 512) {
        return null;
    }

    let buffer: Uint8Array = new Uint8Array(3 + m_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.ServerLoginBad, 0);
    store<u16>(ptr, u16(m_len), 1);

    String.UTF8.encodeUnsafe(
        changetype<usize>(m),
        m.length,
        ptr + 3,
        false);

    return buffer;
}

export function MakeSetPlayer(
    id: u8,
    score: u16,
    wins: u32,
    losses: u32,
    skin: u8,
    team: u8,
    name: string): Uint8Array | null
{
    let name_len: i32 = String.UTF8.byteLength(name, false);

    if (name_len <= 0 || name_len >= 256) {
        return null;
    }

    let buffer: Uint8Array = new Uint8Array(15 + name_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.SetPlayer, 0);
    store<u8>(ptr, id, 1);
    store<u16>(ptr, score, 2);
    store<u32>(ptr, wins, 4);
    store<u32>(ptr, losses, 8);
    store<u8>(ptr, skin, 12);
    store<u8>(ptr, team, 13);
    store<u8>(ptr, u8(name_len), 14);

    String.UTF8.encodeUnsafe(
        changetype<usize>(name),
        name.length,
        ptr + 15,
        false);

    return buffer;
}

export function MakeRemovePlayer(id: u8): Uint8Array {
    let buffer: Uint8Array = new Uint8Array(2);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.RemovePlayer, 0);
    store<u8>(ptr, id, 1);

    return buffer;
}

export function MakePlayerKill(killer_id: u8, killee_id: u8, killer_score: u16, killee_score: u16): Uint8Array {
    let buffer: Uint8Array = new Uint8Array(7);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.PlayerKill, 0);
    store<u8>(ptr, killer_id, 1);
    store<u8>(ptr, killee_id, 2);
    store<u16>(ptr, killer_score, 3);
    store<u16>(ptr, killee_score, 5);

    return buffer;
}

export function MakeChat(id: u8, m: string): Uint8Array | null {
    let m_len: i32 = String.UTF8.byteLength(m, false);

    if (m_len <= 0 || m_len >= 512) {
        return null;
    }

    let buffer: Uint8Array = new Uint8Array(4 + m_len);
    let ptr: usize = buffer.dataStart;

    store<u8>(ptr, Netcode.ReliableType.Chat, 0);
    store<u8>(ptr, id, 1);
    store<u16>(ptr, u16(m_len), 2);

    // If dataStart stops working we can use this instead:
    // changetype<usize>(buffer) + buffer.byteOffset

    String.UTF8.encodeUnsafe(
        changetype<usize>(m),
        m.length,
        ptr + 4,
        false);

    return buffer;
}

} // namespace Netcode

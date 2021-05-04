//------------------------------------------------------------------------------
// Imports

export declare function consoleLog(message: string): void
export declare function getMilliseconds(): f64


//------------------------------------------------------------------------------
// Netcode

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

    [UnreliableType.TimeSync(1 byte)]
    [Local-24bit-SendTimestamp(3 bytes)]
    [min_trip_send_ts24_trunc(3 bytes)] [min_trip_recv_ts24_trunc(3 bytes)]
    [ClockDriftSlope(4 bytes)]
    Sent once a second by both sides.  Used to establish time sync.
    Includes a send timestamp for additional data points.
    Includes the probe received from remote peer we estimate had the shorted trip time,
    providing that probe's 24-bit send timestamp and 24-bit receive timestamp.
    Includes our best estimate of the clock drift slope.

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

// LSB = 1/4 of a millisecond

export class TimeConverter {
    // For netcode we use timestamps relative to the connection open time, because
    // we waste fewer mantissa bits on useless huge values.
    netcode_start_msec: f64 = 0;

    constructor(netcode_start_msec: f64) {
        this.netcode_start_msec = netcode_start_msec;
    }

    // Convert to internal integer time units from floating point performance.now() units
    MsecToTime(t_msec: f64): u64 {
        return u64((t_msec - this.netcode_start_msec) * 4.0) & ~(u64(1) << 63);
    }
}


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

// Similar to above but for 24 bits instead of 23.
function TS24ExpandFromTruncatedWithBias(recent: u64, trunc24: u32): u64 {
    const bias: u32 = 0x400000;
    const msb: u32 = 0x800000;

    let result: u64 = trunc24 | (recent & ~u64(0xffffff));
    const recent_low: u32 = u32(recent) & 0xffffff;

    // If recent - trunc would be negative:
    if (recent_low < trunc24)
    {
        // If it is large enough to roll back a MSB:
        const abs_diff: u32 = trunc24 - recent_low;
        if (abs_diff >= (msb - bias)) {
            result -= msb << 1;
        }
    }
    else
    {
        // If it is large enough to roll ahead a MSB:
        const abs_diff: u32 = recent_low - trunc24;
        if (abs_diff > (msb + bias)) {
            result += msb << 1;
        }
    }

    return result;
}

class SampleTrip {
    local_ts: u64;
    remote_ts: u64;

    constructor(local_ts: u64 = 0, remote_ts: u64 = 0) {
        this.local_ts = local_ts;
        this.remote_ts = remote_ts;
    }
    Set(local_ts: u64 = 0, remote_ts: u64 = 0): void {
        this.local_ts = local_ts;
        this.remote_ts = remote_ts;
    }
    IsTimeoutExpired(now: u64, timeout: u64): bool {
        return u64(now - this.local_ts) > timeout;
    }
    toString(): string {
        return "{ local_ts=" + this.local_ts.toString() + ", remote_ts=" + this.remote_ts.toString() + " }";
    }
}

// Bound the slope estimates to a reasonable range
const kMaxSlope: f32 = 1.003; // +3000 ppm
const kMinSlope: f32 = 0.997; // -3000 ppm

export class TimeSync {
    // Used to hallucinate the upper bits of peer timestamps
    last_remote_ts: u64 = 0;

    // incoming_min_trip: Remote send time, and local receive time (with lowest latency)
    incoming_min_trip: SampleTrip = new SampleTrip(0, 0);
    has_first_measurement: bool = false;

    // Provided by peer
    // outgoing_min_trip: Local send time, and remote receive time (with lowest latency)
    outgoing_min_trip: SampleTrip = new SampleTrip(0, 0);
    remote_slope: f32 = 1.0;
    has_remote_sync: bool = false;

    // X/Y intercept for remote timestamp drift correction to local tick rate
    remote_dy: i64 = 0;
    local_dx: i64 = 0;
    has_transform: bool = false;

    // incoming_min_trip recorded at regular intervals
    samples: Array<SampleTrip> = new Array<SampleTrip>(0);

    // Calculated from samples
    local_slope: f32 = 1.0;

    // Average of local slope and inverse remote slope
    consensus_slope: f32 = 1.0;
    inv_consensus_slope: f32 = 1.0;
    slope_uncertainty: f32 = 0.002;
    has_slope_estimate: bool = false;

    constructor() {
    }

    DumpState(): void {
        // FIXME
        consoleLog("local_slope = " + this.local_slope.toString());
        consoleLog("remote_slope = " + this.remote_slope.toString());
        consoleLog("consensus_slope = " + this.consensus_slope.toString());
        consoleLog("slope_uncertainty = " + this.slope_uncertainty.toString());
        consoleLog("samples: " + this.samples.toString());
        consoleLog("incoming_min_trip = " + this.incoming_min_trip.toString());
        consoleLog("outgoing_min_trip = " + this.outgoing_min_trip.toString());
        consoleLog("remote_dy = " + this.remote_dy.toString());
        consoleLog("local_dx = " + this.local_dx.toString());
    }

    // Update how we transform from remote to local timestamps,
    // based on the incoming_min_trip and outgoing_min_trip.
    UpdateTransform(): void {
        if (!this.has_remote_sync) {
            // Cannot estimate OWD yet
            this.local_dx = i64(this.incoming_min_trip.local_ts - this.incoming_min_trip.remote_ts);
            this.remote_dy = 0;
            return;
        }

        // Find which point is on left/right
        let left: SampleTrip = this.incoming_min_trip;
        let right: SampleTrip = this.outgoing_min_trip;
        if (i64(right.local_ts - left.local_ts) < 0) {
            left = this.outgoing_min_trip;
            right = this.incoming_min_trip;
        }

        // Correct out the trip time
        const dy = i32(right.remote_ts - left.remote_ts);
        const dx = i32(right.local_ts - left.local_ts);
        const owd_offset = (dx - i32(f32(dy) * this.inv_consensus_slope)) / 2;

        // Use right point as reference point,
        // because offsets to this point will be less affected by drift.
        // Local = (Remote - remote_dy) / slope + local_dx
        // Remote = (Local - local_dx) * slope + remote_dy
        this.local_dx = right.local_ts - owd_offset;
        this.remote_dy = right.remote_ts;
    }

    OnTimeSample(local_ts: u64, trunc_remote_ts24: u32): bool {
        //consoleLog("OnTimeSample()");

        // Expand incoming timestamps to 64-bit, though the high bits will be hallucinated.
        let remote_ts: u64 = TS24ExpandFromTruncatedWithBias(this.last_remote_ts, trunc_remote_ts24);

        // Do not roll this backwards
        if (i64(remote_ts - this.last_remote_ts) > 0) {
            this.last_remote_ts = remote_ts;
        }

        // Handle first few data-points
        if (!this.has_first_measurement || !this.has_remote_sync) {
            this.has_first_measurement = true;
        } else {
            // Estimate the OWD for incoming_min_trip and new candidate point.
            // Note: This takes drift slope into account
            const old_send_ts = this.TransformRemoteToLocal(this.incoming_min_trip.remote_ts);
            const old_owd = i64(this.incoming_min_trip.local_ts - old_send_ts);
            const new_send_ts = this.TransformRemoteToLocal(remote_ts);
            const new_owd = i64(local_ts - new_send_ts);

            consoleLog("old owd=" + old_owd.toString() + " new owd=" + new_owd.toString() + " slope=" + this.consensus_slope.toString());

            // If the new trip time looks worse:
            // Note: old_owd > 0 check added because sometimes the timestamps are crazy
            if (old_owd > 0 && new_owd > old_owd) {
                const age = i32(local_ts - this.incoming_min_trip.local_ts);
    
                let window = 4 * 3_000;
                if (this.has_slope_estimate) {
                    // Use a longer window if we can estimate slope
                    window = 4 * 10_000;
                }

                // If the previous min-trip is not aging:
                if (age < window) {
                    return false;
                }

                const uncertainty = i32(f32(age) * this.slope_uncertainty + 0.5);

                // If uncertainty is low:
                if (new_owd > old_owd + uncertainty) {
                    return false;
                }
            }
        }

        // Base transform on the new point
        this.incoming_min_trip.Set(local_ts, remote_ts);
        this.UpdateTransform();

        return true;
    }

    // Peer provides, for the best probe we have sent so far:
    // min_trip_send_ts24_trunc: Our 24-bit timestamp from the probe, from our clock.
    // min_trip_recv_ts24_trunc: When they received the probe, from their clock.
    OnPeerSync(local_ts: u64, trunc_remote_ts24: u32, min_trip_send_ts24_trunc: u32, min_trip_recv_ts24_trunc: u32, slope: f32): void {
        this.outgoing_min_trip.local_ts = TS24ExpandFromTruncatedWithBias(local_ts, min_trip_send_ts24_trunc);
        this.outgoing_min_trip.remote_ts = TS24ExpandFromTruncatedWithBias(this.last_remote_ts, min_trip_recv_ts24_trunc);

        if (!isFinite(slope)) {
            slope = 1.0;
        } else if (slope > kMaxSlope) {
            slope = kMaxSlope;
        } else if (slope < kMinSlope) {
            slope = kMinSlope;
        }

        this.remote_slope = slope;
        this.has_remote_sync = true;

        // Add sample after updating remote information
        if (!this.OnTimeSample(local_ts, trunc_remote_ts24)) {
            // Update transform even if the new sample isn't as good
            this.UpdateTransform();
        }

        this.UpdateDrift();
    }

    UpdateDrift(): void {
        // If we have seen this sample:
        if (this.samples.length > 0 && this.samples[this.samples.length - 1].local_ts == this.incoming_min_trip.local_ts) {
            consoleLog("Ignoring drift sample repeat");
            return;
        }

        let sample: SampleTrip = new SampleTrip(this.incoming_min_trip.local_ts, this.incoming_min_trip.remote_ts);
        this.samples.push(sample);

        if (this.samples.length >= 2)
        {
            const sample_i = this.samples[0];
            const sample_j = this.samples[this.samples.length - 1];
            const m = i32(sample_j.remote_ts - sample_i.remote_ts) / f64(i32(sample_j.local_ts - sample_i.local_ts));
            consoleLog("wide slope = " + m.toString());
        }

        if (this.samples.length < 50) {
            consoleLog("Waiting for 50 samples: " + this.samples.length.toString());
            return;
        }

        if (this.samples.length > 100) {
            this.samples.shift();
        }

        const t0 = getMilliseconds();

        let slopes: Array<f32> = new Array<f32>(0);

        const sample_count = this.samples.length;
        const split_i = sample_count / 2;
        for (let i: i32 = 0; i < split_i; ++i) {
            const sample_i = this.samples[i];

            for (let j: i32 = i + sample_count / 2; j < sample_count; ++j) {
                const sample_j = this.samples[j];

                const m = i32(sample_j.remote_ts - sample_i.remote_ts) / f64(i32(sample_j.local_ts - sample_i.local_ts));
                if (m >= kMinSlope && m <= kMaxSlope) {
                    slopes.push(f32(m));
                }
            }
        }

        if (slopes.length < 50) {
            consoleLog("Too few slopes");
            return;
        }

        slopes.sort();
        this.local_slope = slopes[slopes.length / 2];

        this.slope_uncertainty = abs(this.local_slope - 1.0) * 2;
        if (this.slope_uncertainty > kMaxSlope) {
            this.slope_uncertainty = kMaxSlope;
        }
        if (this.slope_uncertainty < 0.00005) {
            this.slope_uncertainty = 0.00005; // within 50 ppm
        }

        if (this.remote_slope == 1.0) {
            this.consensus_slope = this.local_slope;
        } else {
            this.consensus_slope = (this.local_slope + this.remote_slope) * 0.5;
        }
        this.inv_consensus_slope = 1.0 / this.consensus_slope;

        this.has_slope_estimate = true;

        const t1 = getMilliseconds();
        consoleLog("Updated slope estimate in " + (t1 - t0).toString() + " msec");
    }

    // Takes in a 23-bit timestamp in peer's clock domain,
    // and produces a full 64-bit timestamp in local clock domain.
    PeerToLocalTime_FromTS23(peer_ts23: u32): u64 {
        // Expand incoming timestamps to 64-bit, though the high bits will be hallucinated.
        const remote_ts: u64 = TS23ExpandFromTruncatedWithBias(this.last_remote_ts, peer_ts23);

        return this.TransformRemoteToLocal(remote_ts);
    }

    // Produces a 23-bit timestamp in peer's clock domain.
    LocalToPeerTime_ToTS23(local_ts: u64): u32 {
        // Convert local to remote, though the high bits will be hallucinated.
        const remote_ts: u64 = this.TransformLocalToRemote(local_ts);

        return u32(remote_ts) & 0x7fffff;
    }

    // Takes in a full 64-bit timestamp in local clock domain,
    // and produces a truncated 23-bit timestamp in local clock domain.
    TruncateLocalTime_ToTS23(local_ts: u64): u32 {
        return u32(local_ts) & 0x7fffff;
    }

    // Takes in a 23-bit timestamp in local clock domain,
    // and produces a full 64-bit timestamp in local clock domain.
    // local_ts: A recent local 64-bit timestamp.
    ExpandLocalTime_FromTS23(local_ts: u64, local_ts23: u32): u64 {
        return TS23ExpandFromTruncatedWithBias(local_ts, local_ts23 & 0x7fffff);
    }

    MakeTimeSync(send_ts: u64): Uint8Array {
        let buffer: Uint8Array = new Uint8Array(14);
        let ptr: usize = buffer.dataStart;

        store<u8>(ptr, Netcode.UnreliableType.TimeSync, 0);
        // Send timestamp
        Netcode.Store24(ptr, 1, u32(send_ts & 0xff_ff_ff));
        // min_trip_send_ts24_trunc:
        Netcode.Store24(ptr, 4, u32(this.incoming_min_trip.remote_ts) & 0xff_ff_ff);
        // min_trip_recv_ts24_trunc:
        Netcode.Store24(ptr, 7, u32(this.incoming_min_trip.local_ts) & 0xff_ff_ff);
        // Our slope estimate
        store<f32>(ptr, this.local_slope, 10);

        return buffer;
    }

    TransformRemoteToLocal(remote_ts: u64): u64 {
        return this.local_dx + i64(f64(i64(remote_ts - this.remote_dy)) * this.inv_consensus_slope);
    }

    // Note that only the low 23-bits are valid in the view of the remote computer because
    // we only have a view of 24 bits of the remote timestamps, and we lose one bit from the
    // division by 2 above.
    TransformLocalToRemote(local_ts: u64): u64 {
        return this.remote_dy + i64(f64(i64(local_ts - this.local_dx)) * this.consensus_slope);
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

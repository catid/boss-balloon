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
    [ClockDriftSlope(8 bytes)]
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

const kSyncWindowLength: u64 = 4 * 10_000; // 10 seconds in our time units


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

class SampleTS24 {
    local_ts: u64;
    remote_ts: u64;

    constructor(local_ts: u64 = 0, remote_ts: u64 = 0) {
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
const kMaxSlope = 1.0 + 3000.0 / 1000_000.0;
const kMinSlope = 1.0 - 3000.0 / 1000_000.0;

export class TimeSync {
    samples: Array<SampleTS24> = new Array<SampleTS24>(0);

    // Set to true if time sync estimates can be updated
    is_dirty: bool = false;

    // Used to hallucinate the upper bits of peer timestamps
    last_remote_ts: u64 = 0;

    // Calculated by RecalculateSlope()
    candidate_slopes: Array<f64> = new Array<f64>(0);
    local_slope: f64 = 1.0;
    smoothed_local_slope: f64 = 1.0;
    found_supported_slope_estimate: bool = false;

    // r2l_min_trip: Remote send time, and local receive time (with lowest latency)
    r2l_min_trip: SampleTS24 = new SampleTS24(0, 0);

    // Provided by peer
    remote_slope: f64 = 1.0;

    // Provided by peer
    // l2r_min_trip: Local send time, and remote receive time (with lowest latency)
    l2r_min_trip: SampleTS24 = new SampleTS24(0, 0);

    // Average of local and remote slopes
    consensus_slope: f64 = 1.0;

    // X/Y intercept for remote timestamp drift correction to local tick rate
    remote_dy: i64 = 0;
    local_dx: i64 = 0;

    constructor() {
    }

    DumpState(): void {
        consoleLog("local_slope = " + this.local_slope.toString());
        consoleLog("remote_slope = " + this.remote_slope.toString());
        consoleLog("consensus_slope = " + this.consensus_slope.toString());
        consoleLog("samples: " + this.samples.toString());
        consoleLog("candidate_slopes: " + this.candidate_slopes.toString());
        consoleLog("r2l_min_trip = " + this.r2l_min_trip.toString());
        consoleLog("l2r_min_trip = " + this.l2r_min_trip.toString());
        consoleLog("remote_dy = " + this.remote_dy.toString());
        consoleLog("local_dx = " + this.local_dx.toString());
    }

    // Update time sync with latest information
    UpdateTimeSync(): void {
        //consoleLog("UpdateTimeSync()");
        if (!this.is_dirty) {
            //consoleLog("Not dirty");
            return;
        }

        // Recalculate our slope estimate from one-way data from peer
        this.RecalculateSlope();

        // EWMA smoothing for our slope estimate
        this.smoothed_local_slope = this.smoothed_local_slope * 0.75 + this.local_slope * 0.25;

        //consoleLog("local slope = " + this.local_slope.toString());
        //consoleLog("remote slope = " + this.remote_slope.toString());
        //consoleLog("inv remote slope = " + (1.0 / this.remote_slope).toString());

        // Take the average of local and remote slope estimates
        this.consensus_slope = (this.smoothed_local_slope + 1.0/this.remote_slope) * 0.5;

        // Recalculate our best estimate of the shortest one-way trip
        this.RecalculateMinTrip();

        //consoleLog("consensus slope = " + m.toString());

        // Note that each has an unknown trip time, but we assume
        // that these trips are near the shortest trip each way, and further
        // that these trip times are similar since the shortest trips
        // on a balanced link should be almost always close since they are
        // Poisson arrival processes.
        // We also assume there is no clock drift over the short trip time,
        // which is reasonable even for large drift.

        // So to cancel out the Min(One-Way Delay) transit times:
        // r2l_min_trip.local_ts - r2l_min_trip.remote_ts = Min(OWD) + ClockDelta(L - R)
        // l2r_min_trip.remote_ts - l2r_min_trip.local_ts = Min(OWD) - ClockDelta(L - R)
        // 2 * ClockDelta(L - R) = (r2l_min_trip.local_ts - r2l_min_trip.remote_ts) - (l2r_min_trip.remote_ts - l2r_min_trip.local_ts)

        // The curve ball is that the remote timestamps are drifting relative to ours,
        // and this equation assumes the clocks are ticking at the same rate.
        // So first we must transform the remote timestamps to local ticks.

        // And since the slope is a guess, we should choose the point on the right
        // between the two points as the new origin, so that when we convert future
        // timestamps, the effect of the slope is as small as possible.

        //consoleLog("this.r2l_min_trip.local_ts = " + this.r2l_min_trip.local_ts.toString());
        //consoleLog("this.r2l_min_trip.remote_ts = " + this.r2l_min_trip.remote_ts.toString());

        //consoleLog("this.l2r_min_trip.local_ts = " + this.l2r_min_trip.local_ts.toString());
        //consoleLog("this.l2r_min_trip.remote_ts = " + this.l2r_min_trip.remote_ts.toString());

        // If r2l_min_trip is on the right of l2r_min_trip:
        if (i64(this.r2l_min_trip.local_ts - this.l2r_min_trip.local_ts) > 0) {
            //consoleLog("+++ r2l on the right");
            // Use r2l_min_trip as the origin for remote timestamp drift correction.
            this.remote_dy = this.r2l_min_trip.remote_ts;

            //consoleLog("this.remote_dy = " + this.remote_dy.toString());

            // Calculate distance from local/remote reference points (should be positive)
            const dy = i32(this.r2l_min_trip.remote_ts - this.l2r_min_trip.remote_ts);
            const dx = i32(this.r2l_min_trip.local_ts - this.l2r_min_trip.local_ts);

            //consoleLog("dy = " + dy.toString());
            //consoleLog("dx = " + dx.toString());

            // Calculate delta from local time when remote probe was sent remotely
            const owd = (dx - i32(dy / this.consensus_slope)) / 2;
            this.local_dx = this.r2l_min_trip.local_ts - owd;

            consoleLog("owd(l2r left) = " + owd.toString() + " slope = " + ((this.consensus_slope - 1) * 1000000).toString() + " ppm");

            //consoleLog("this.local_dx = " + this.local_dx.toString());
        } else {
            //consoleLog("--- l2r on the right");
            // Use l2r_min_trip as the origin for remote timestamp drift correction.
            this.remote_dy = this.l2r_min_trip.remote_ts;

            //consoleLog("this.remote_dy = " + this.remote_dy.toString());

            // Calculate distance from local/remote reference points (should be positive)
            const dy = i32(this.l2r_min_trip.remote_ts - this.r2l_min_trip.remote_ts);
            const dx = i32(this.l2r_min_trip.local_ts - this.r2l_min_trip.local_ts);

            //consoleLog("dy = " + dy.toString());
            //consoleLog("dx = " + dx.toString());

            // Calculate delta from local time when local probe was received remotely
            const owd = (dx - i32(dy / this.consensus_slope)) / 2;
            this.local_dx = this.l2r_min_trip.local_ts - owd;

            consoleLog("owd(l2r right) = " + owd.toString() + " slope = " + ((this.consensus_slope - 1) * 1000000).toString() + " ppm");

            //consoleLog("this.local_dx = " + this.local_dx.toString());
        }

        this.is_dirty = false;
    }

    // To convert from remote to local:
    // Local = local_dx + (Remote - remote_dy) / consensus_slope
    TransformRemoteToLocal(remote_ts: u64): u64 {
        return this.local_dx + i64(f64(i64(remote_ts - this.remote_dy)) / this.consensus_slope);
    }

    // To convert from local to remote:
    // Remote = remote_dy + (Local - local_dx) * consensus_slope
    // Note that only the low 23-bits are valid in the view of the remote computer because
    // we only have a view of 24 bits of the remote timestamps, and we lose one bit from the
    // division by 2 above.
    TransformLocalToRemote(local_ts: u64): u64 {
        return this.remote_dy + i64(f64(i64(local_ts - this.local_dx)) * this.consensus_slope);
    }

    DiscardOld(now_ts: u64): void {
        //consoleLog("DiscardOld()");

        // While at least 3 samples remain, so we can calculate a slope:
        while (this.samples.length >= 3) {
            // If the first one is still fresh:
            const age: u64 = u64(now_ts - this.samples[0].local_ts);
            //consoleLog("next oldest age = " + age.toString());
            if (age < kSyncWindowLength) {
                // Note that if samples arrive out of order this does not work,
                // but we assume that is rare enough to not skew the calculations.
                //consoleLog("age = " + age.toString() + " < len = " + kSyncWindowLength.toString());
                break; // Stop here
            }

            //consoleLog("discarding ts = " + this.samples[0].local_ts.toString(16));
            //consoleLog("new sample count = " + this.samples.length.toString());

            // Shift off the first one
            this.samples.shift();

            this.is_dirty = true;
        }
    }

    RecalculateMinTrip(): void {
        //consoleLog("RecalculateMinTrip()");

        const sample_count: i32 = this.samples.length;

        //consoleLog("sample_count = " + sample_count.toString());

        // If there is only one sample use that one:
        if (sample_count <= 1) {
            if (sample_count >= 1) {
                this.r2l_min_trip = this.samples[0];
                //consoleLog("this.r2l_min_trip.local_ts = " + this.r2l_min_trip.local_ts.toString());
                //consoleLog("this.r2l_min_trip.remote_ts = " + this.r2l_min_trip.remote_ts.toString());
            }
            return;
        }

        // Line equation: y = mx + b,
        // where x is the local time, and y is the remote time.
        const m: f64 = this.consensus_slope;

        // Maximize b = y - mx, so we find the left-most point,
        // which has the lowest latency if the slope estimate is good
        // and the data is reasonable.

        let best_sample = this.samples[0];
        let best_b: f64;
        {
            const y0: u64 = best_sample.remote_ts;
            const x0: u64 = best_sample.local_ts;
            best_b = f64(y0) - m * f64(x0);

            //consoleLog("b0 = " + best_b.toString());
        }

        // Calculate "b" for all sample points:
        for (let i: i32 = 1; i < sample_count; ++i) {
            const sample = this.samples[i];
            const y: u64 = sample.remote_ts;
            const x: u64 = sample.local_ts;
            const b: f64 = f64(y) - m * f64(x);

            //consoleLog("b[" + i.toString() + "] = " + b.toString());

            if (b > best_b) {
                best_sample = sample;
                best_b = b;
                //consoleLog("New best!");
            }
        }

        this.r2l_min_trip = best_sample;
        //consoleLog("this.r2l_min_trip.local_ts = " + this.r2l_min_trip.local_ts.toString());
        //consoleLog("this.r2l_min_trip.remote_ts = " + this.r2l_min_trip.remote_ts.toString());
    }

    RecalculateSlope(): void {
        //consoleLog("RecalculateSlope()");

        let slopes: Array<f64> = new Array<f64>(0);

        const sample_count: i32 = this.samples.length;

        // Regularly sample 3 offsets from each sample to discover candidate slopes
        let skip_j: i32 = sample_count / 4;
        if (skip_j < 1) {
            skip_j = 1;
        }
        let skip_k: i32 = sample_count * 3 / 8;
        if (skip_k <= skip_j) {
            // Make sure we do not sample the same points twice
            skip_k = skip_j + 1;
        }
        let skip_l: i32 = sample_count / 2;
        if (skip_l <= skip_k) {
            // Make sure we do not sample the same points twice
            skip_l = skip_k + 1;
        }

        //consoleLog("sample_count = " + sample_count.toString());
        //consoleLog("skip_j = " + skip_j.toString());
        //consoleLog("skip_k = " + skip_k.toString());
        //consoleLog("skip_l = " + skip_l.toString());

        for (let i: i32 = 0; i < sample_count; ++i) {
            const sample = this.samples[i];

            // Skip ahead to find a probe to compare:
            const j = i + skip_j;
            if (j >= sample_count) {
                continue;
            }

            const sample_j = this.samples[j];
            const local_dt_j = i32(sample_j.local_ts - sample.local_ts);
            if (local_dt_j == 0) {
                continue;
            }

            const m_j = i32(sample_j.remote_ts - sample.remote_ts) / f64(i32(local_dt_j));
            if (!isFinite(m_j) || m_j > kMaxSlope || m_j < kMinSlope) {
                continue;
            }
            slopes.push(m_j);

            //consoleLog("*** i = " + i.toString());
            //consoleLog("j = " + j.toString());
            //consoleLog("local_dt_j = " + local_dt_j.toString());
            //consoleLog("m_j = " + m_j.toString());

            // Skip further:
            const k = i + skip_k;
            if (k >= sample_count) {
                continue;
            }

            const sample_k = this.samples[k];
            const local_dt_k = i32(sample_k.local_ts - sample.local_ts);
            if (local_dt_k == 0) {
                continue;
            }

            const m_k = i32(sample_k.remote_ts - sample.remote_ts) / f64(i32(local_dt_k));
            if (!isFinite(m_k) || m_k > kMaxSlope || m_k < kMinSlope) {
                continue;
            }
            slopes.push(m_k);

            //consoleLog("*** i = " + i.toString());
            //consoleLog("k = " + k.toString());
            //consoleLog("local_dt_k = " + local_dt_k.toString());
            //consoleLog("m_k = " + m_k.toString());

            // Skip further:
            const l = i + skip_l;
            if (l >= sample_count) {
                continue;
            }

            const sample_l = this.samples[l];
            const local_dt_l = i32(sample_l.local_ts - sample.local_ts);
            if (local_dt_l == 0) {
                continue;
            }

            const m_l = i32(sample_l.remote_ts - sample.remote_ts) / f64(i32(local_dt_l));
            if (!isFinite(m_l) || m_l > kMaxSlope || m_l < kMinSlope) {
                continue;
            }
            slopes.push(m_l);

            //consoleLog("*** i = " + i.toString());
            //consoleLog("l = " + l.toString());
            //consoleLog("local_dt_l = " + local_dt_l.toString());
            //consoleLog("m_l = " + m_l.toString());
        }

        // Not enough points to pick a good slope yet
        if (slopes.length <= 2)
        {
            if (this.found_supported_slope_estimate) {
                // It's much better to just give up than to try to make do with bad data.
                // The slope doesn't change very often so there is no rush to come up with
                // a new estimate after we have found one.
                return;
            }

            //consoleLog("Not enough slope samples yet: " + slopes.length.toString());

            if (sample_count < 2) {
                this.local_slope = 1.0;
                return;
            }

            const sample_left = this.samples[0];
            const sample_right = this.samples[sample_count - 1];
            if (sample_right.local_ts == sample_left.local_ts) {
                this.local_slope = 1.0;
                return;
            }

            let slope = i32(sample_right.remote_ts - sample_left.remote_ts) / f64(i32(sample_right.local_ts - sample_left.local_ts));

            // Validate slope calculation
            if (!isFinite(slope)) {
                slope = 1.0;
            } else if (slope > kMaxSlope) {
                slope = kMaxSlope;
            } else if (slope < kMinSlope) {
                slope = kMinSlope;
            }

            this.local_slope = slope;
            this.found_supported_slope_estimate = true;

            //consoleLog("sample_left.local_ts = " + sample_left.local_ts.toString());
            //consoleLog("sample_left.remote_ts = " + sample_left.remote_ts.toString());
            //consoleLog("sample_right.local_ts = " + sample_right.local_ts.toString());
            //consoleLog("sample_right.remote_ts = " + sample_right.remote_ts.toString());
            //consoleLog("this.local_slope = " + this.local_slope.toString());

            this.candidate_slopes.length = 0;
            this.candidate_slopes.push(slope);

            return;
        }

        slopes.sort();

        //consoleLog("slopes = " + slopes.toString());

        /*
            Score for locality using a triangle filter:

                   1
                   /\
                  /  \
                 /    \
            ____/      \____0
                |------|
                100 ppm span
        */

        let best_score: f64 = 0.0;
        let best_slope: f64 = 0.0;
        let best_slope_i: i32 = 0;
        const kSlopeRadius: f64 = 50.0 /1000_000.0; // 50 ppm

        // Check score for each candidate slope
        const slope_count: i32 = slopes.length;
        for (let i: i32 = 0; i < slope_count; ++i) {
            let score: f64 = 0.0;
            const slope: f64 = slopes[i];

            // Score forward up to 10 values until radius is hit
            for (let offset: i32 = 1; offset < 10; ++offset) {
                const j: i32 = i + offset;
                if (j >= slope_count) {
                    break; // Hit edge: done
                }

                const slope_j = slopes[j];
                const slope_delta = slope_j - slope;
                if (slope_delta >= kSlopeRadius) {
                    break; // Hit radius: Done
                }

                score += kSlopeRadius - slope_delta;
            }

            // Score backward down to 10 values until radius is hit
            for (let offset: i32 = 1; offset < 10; ++offset) {
                const j: i32 = i - offset;
                if (j < 0) {
                    break; // Hit edge: done
                }

                const slope_j = slopes[j];
                const slope_delta = slope - slope_j;
                if (slope_delta >= kSlopeRadius) {
                    break; // Hit radius: Done
                }

                score += kSlopeRadius - slope_delta;
            }

            //consoleLog("slope = " + slope.toString() + " : score = " + score.toString());

            if (score > best_score) {
                best_score = score;
                best_slope = slope;
                best_slope_i = i;
                //consoleLog("^ Best slope " + i.toString());
            }
        }

        // If none of the slopes scored any points for neighbors,
        // just pick the median.  This happens during startup when there
        // are not many data-points yet.
        if (best_score <= 0.0) {
            if (this.found_supported_slope_estimate) {
                // It's much better to just give up than to try to make do with bad data.
                // The slope doesn't change very often so there is no rush to come up with
                // a new estimate after we have found one.
                return;
            }

            best_slope_i = slope_count / 2;
            best_slope = slopes[best_slope_i];
        }

        // Refine by averaging the best slope with its closest neighbor
        let neighbor_left: f64 = best_slope;
        let neighbor_right: f64 = best_slope;
        if (best_slope_i > 0) {
            neighbor_left = slopes[best_slope_i - 1];
            if (best_slope_i + 1 < slope_count) {
                neighbor_right = slopes[best_slope_i + 1];
            } else {
                neighbor_right = neighbor_left;
            }
        } else {
            if (best_slope_i + 1 < slope_count) {
                neighbor_right = slopes[best_slope_i + 1];
            }
            neighbor_left = neighbor_right;
        }

        //consoleLog("best_slope = " + best_slope.toString());
        //consoleLog("neighbor_left = " + neighbor_left.toString());
        //consoleLog("neighbor_right = " + neighbor_right.toString());

        let closest_neighbor = neighbor_right;
        if (abs(neighbor_left - best_slope) < abs(neighbor_right - best_slope)) {
            closest_neighbor = neighbor_left;
        }
        //consoleLog("this.local_slope = " + this.local_slope.toString());

        // If closest neighbor is close enough:
        const kNeighborRadius: f64 = 50.0 / 1000_000.0; // 50 ppm
        if (abs(closest_neighbor - best_slope) < kNeighborRadius) {
            this.local_slope = (neighbor_left + best_slope) * 0.5;
        } else {
            this.local_slope = best_slope;
        }

        this.candidate_slopes = slopes;
    }

    OnTimeSample(local_ts: u64, trunc_remote_ts24: u32): void {
        //consoleLog("OnTimeSample()");

        // Expand incoming timestamps to 64-bit, though the high bits will be hallucinated.
        let remote_ts: u64 = TS24ExpandFromTruncatedWithBias(this.last_remote_ts, trunc_remote_ts24);
        // Do not roll this backwards
        if (i64(remote_ts - this.last_remote_ts) > 0) {
            this.last_remote_ts = remote_ts;
        }

        //consoleLog("local_ts = " + local_ts.toString());
        //consoleLog("remote_ts = " + remote_ts.toString());
        //consoleLog("this.last_remote_ts = " + this.last_remote_ts.toString());
        //consoleLog("sample count before = " + this.samples.length.toString());

        let sample: SampleTS24 = new SampleTS24(local_ts, remote_ts);
        this.samples.push(sample);

        this.is_dirty = true;

        //consoleLog("sample count after = " + this.samples.length.toString());
        //consoleLog("test: " + this.samples[0].local_ts.toString());
    }

    // Peer provides, for the best probe we have sent so far:
    // min_trip_send_ts24_trunc: Our 24-bit timestamp from the probe, from our clock.
    // min_trip_recv_ts24_trunc: When they received the probe, from their clock.
    OnPeerSync(local_ts: u64, min_trip_send_ts24_trunc: u32, min_trip_recv_ts24_trunc: u32, slope: f64): void {
        //consoleLog("OnPeerSync()");

        // Expand to 64 bits
        let min_trip_send_ts: u64 = TS24ExpandFromTruncatedWithBias(local_ts, min_trip_send_ts24_trunc);
        let min_trip_recv_ts: u64 = TS24ExpandFromTruncatedWithBias(this.last_remote_ts, min_trip_recv_ts24_trunc);

        // Store info
        this.l2r_min_trip.local_ts = min_trip_send_ts;
        this.l2r_min_trip.remote_ts = min_trip_recv_ts;

        if (!isFinite(slope)) {
            slope = 1.0;
        } else if (slope > kMaxSlope) {
            slope = kMaxSlope;
        } else if (slope < kMinSlope) {
            slope = kMinSlope;
        }

        this.remote_slope = slope;
        this.is_dirty = true;

        //consoleLog("peer: min_trip_send_ts = " + min_trip_send_ts.toString());
        //consoleLog("peer: min_trip_recv_ts = " + min_trip_recv_ts.toString());
        //consoleLog("peer: slope = " + slope.toString());

        // Get rid of samples that are old
        this.DiscardOld(local_ts);

        // Update time sync from latest info
        this.UpdateTimeSync();
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

    MakeTimeSync(send_msec: f64): Uint8Array {
        let buffer: Uint8Array = new Uint8Array(18);
        let ptr: usize = buffer.dataStart;

        // Convert timestamp to integer with 1/4 msec (desired) precision
        let send_ts: u64 = MsecToTime(send_msec);

        store<u8>(ptr, Netcode.UnreliableType.TimeSync, 0);
        // Send timestamp
        Netcode.Store24(ptr, 1, u32(send_ts & 0xff_ff_ff));
        // min_trip_send_ts24_trunc:
        Netcode.Store24(ptr, 4, u32(this.r2l_min_trip.remote_ts) & 0xff_ff_ff);
        // min_trip_recv_ts24_trunc:
        Netcode.Store24(ptr, 7, u32(this.r2l_min_trip.local_ts) & 0xff_ff_ff);
        // Our slope estimate
        store<f64>(ptr, this.local_slope, 10);

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

//------------------------------------------------------------------------------
// Tools

namespace Tools {


export function clamp(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
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


} // namespace Tools

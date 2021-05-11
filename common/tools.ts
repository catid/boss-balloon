//------------------------------------------------------------------------------
// Tools

export function clamp(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
}

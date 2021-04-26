import { RenderContext } from "./gl/RenderContext";
import { Box3 } from "../node_modules/as-3d-math/src/as/index";


//------------------------------------------------------------------------------
// Imports

declare function consoleLog(message: string): void
declare function sendBuffer(buffer: Uint8Array): void

export const UINT8ARRAY_ID = idof<Uint8Array>();


//------------------------------------------------------------------------------
// Initialization

export function Initialize(): void {
    new RenderContext();
}


//------------------------------------------------------------------------------
// Render

let last_msec : f64 = 0;

export function RenderFrame(now_msec: f64, finger_x: f64, finger_y: f64): void {
    let dt : f64 = now_msec - last_msec;
    if (dt > 5000) {
        dt = 0;
    }
    last_msec = now_msec;
    //consoleLog("TEST: " + dt.toString() + " at " + finger_x.toString() + ", " + finger_y.toString());

    RenderContext.I.clear();

    // Collect GC after render tasks are done
    __collect();
}


//------------------------------------------------------------------------------
// Connection

export function OnConnectionOpen(): void {
    consoleLog("Connection open");

    const data = new Uint8Array(10);
    for (let i: i32 = 0; i < 10; ++i) {
        data[i] = i as u8;
    }

    sendBuffer(data);
}

export function OnConnectionClose(): void {
    consoleLog("Connection close");
}

export function OnConnectionData(buffer: Uint8Array): void {
    consoleLog("Connection data: len=" + buffer.length.toString());
}

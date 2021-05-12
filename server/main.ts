import { Netcode } from "../common/netcode"
import { Physics } from "../common/physics"
import { jsConsoleLog } from "../common/javascript"



//------------------------------------------------------------------------------
// Initialization

export function Initialize(t_msec: f64): void {
    Physics.Initialize(t_msec);
}


//------------------------------------------------------------------------------
// Server Main Loop

export function OnTick(now_msec: f64): void {
    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = Physics.ConvertWallclock(now_msec);

    temp_clients = Clients.values();

    Physics.SimulateTo(t, t);

    // Collect GC after simulation tasks are done
    __collect();
}

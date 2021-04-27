export namespace Netcode {

/*
    Unreliable packet formats:

    All packets can be appended to eachother.

    [UnreliableType.TimeSync(1 byte)] [Local-SendTimestamp(3 bytes)] [Remote-MinDelta(3 bytes)]
    Sent once a second by both sides to establish time sync.

    [UnreliableType.ClientPosition(1 byte)] [Client-SendTimestamp(3 bytes)] [x(2 bytes)] [y(2 bytes)]
    Sent by client to request a position change.
    We use client time in the message to improve the time sync dataset.
    Finger position relative to center: ((x or y) - 32768) / 32768 = -1..1
*/

/*
    [UnreliableType.ServerPosition(1 byte)] [Server-SendTimestamp(3 bytes)] [Player Count-1(1 byte)] Repeated (LSB-first): {
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
    ClientPosition = 1,
    ServerPosition = 2,
}

/*
    Reliable packet formats:

    All packets can be appended to eachother.

    [ReliableType.SetId(1 byte)] [PlayerId(1 byte)]
    Server is assigning the client's info.


    [ReliableType.ClientRegister(1 byte)]
    [Name Length(1 byte)] [Name(NL bytes)]
    [Password Length(1 byte)] [Password(PL bytes)]
    Client is registering a name.

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

    ClientRegister = 10,
    ClientLogin = 11,
    ServerLoginGood = 15,
    ServerLoginBad = 16,

    SetPlayer = 20,
    RemovePlayer = 21,
    PlayerKill = 22,

    ChatRequest = 30,
    Chat = 31,
}


} // namespace Netcode

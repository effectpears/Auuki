//
// Race Controller Service - Zwift Click V2
//
// Protocol (Click V2, after zwiftboard):
//   - activation: write "RideOn"+02 03, then 00 08 00, then 00 08 10
//     (100ms apart) to sync-rx; an unlocked device echoes "RideOn" on
//     sync-tx, a locked one sends a 0xFF challenge
//   - keepalive: re-send the raw "RideOn" opcode frame every 3s as a
//     LIVENESS probe — a successful write proves the session is up, a
//     failed one detects the disconnect
//   - idle reset: a lone 0x18 written to sync-rx reboots a pod before its
//     ~65s idle watchdog strands it asleep for 30-40s
//   - challenge: a 0xFF 03 frame on async (the button stream) is a crypto
//     challenge; acking with ff 04 00 keeps the button stream alive on an
//     already-unlocked pod
//
import { expect, exists, wait, print, xf, } from '../../functions.js';
import { uuids, } from '../web-ble.js';
import { Service } from '../service.js';
import { Characteristic } from '../characteristic.js';
import { RaceControllerMeasurement } from './race-controller-measurement.js';

const rideOn = [0x52, 0x69, 0x64, 0x65, 0x4F, 0x6E]; // "RideOn"

// activation frame: "RideOn" + 02 03 (written once after connect)
const handshakeStart = [...rideOn, 0x02, 0x03];
// unlock ack: keeps an already-unlocked device unlocked
const ack = [0xFF, 0x04, 0x00];
// teardown / connect-failure probe (any write works)
const keep = [0x00, 0x08, 0x10];
// pod reset: reboots a Click V2 pod before its ~65s idle sleep watchdog
const resetPod = [0x18];

const keepaliveInterval = 3 * 1000;   // liveness probe every 3s
const idleResetDelay = 55 * 1000;     // reboot before the ~65s sleep watchdog

function RCS(args = {}) {

    // config
    const onData = args.onData;

    // test hooks: shorter intervals for integration tests (ms)
    const keepaliveMs = args.keepaliveMs ?? keepaliveInterval;
    const idleResetMs = args.idleResetMs ?? idleResetDelay;

    // BluetoothRemoteGATTService{
    //     device: BluetoothDevice,
    //     uuid: String,
    //     isPrimary: Bool,
    // }
    const gattService = expect(
        args.service, 'RCS needs BluetoothRemoteGATTService!'
    );
    // end config

    // state
    let keepaliveTimer = null;
    let idleTimer = null;
    let lastActivity = Date.now();
    let stopped = false;
    // sync-tx RideOn-Echo latch: der ack wird genau einmal pro Session
    // gesendet (zwiftboard acked.CompareAndSwap)
    let acked = false;
    // zwiftboard keepaliveTick: der Idle-Reset feuert genau einmal pro
    // Session (resetSent-Latch) — danach nur noch Liveness-Pings
    let resetSent = false;
    // Int, ms — Fenster, in dem eingehende Frames einen fehlgeschlagenen
    // Keepalive-Write entkoppeln (Pod lebt, Write-Handle halbtot)
    const keepaliveStaleMs = args.keepaliveStaleMs ?? 10 * 1000;
    // end state

    // measurement parser with the challenge callback wired to the ack and
    // the frame callback wired to the idle-reset activity clock
    const raceControllerMeasurementParser = RaceControllerMeasurement({
        onChallenge: () => {
            // re-arm the button stream on an already-unlocked pod
            writeControl(new Uint8Array(ack));
        },
        onFrame: () => {
            touch();
        },
        onKey: (name, down) => {
            // Diagnose: beweist, dass die Eingabe in ein Key-Event
            // übersetzt wurde (nur gedrückte Kanten dispatcht)
            print.log(`ble: rcs: action: ${name.toLowerCase()} ${down ? 'down' : 'up'}`);
            // live button feedback for the UI action tile — pressed edges
            // are deduped by the parser's shared heldCount (mirror pair)
            if (down) xf.dispatch('ble:raceController:action', name.toLowerCase());
        },
    });

    const spec = {
        measurement: {
            uuid: uuids.raceControllerMeasurement,
            notify: {callback: onData, parser: raceControllerMeasurementParser},
        },
        control: {
            uuid: uuids.raceControllerControlPoint,
            // zwiftboard writeChar: WriteWithoutResponse (Write-Command)
            // zuerst — der Click V2 SyncRX erwartet das
            writeWithoutResponse: true,
        },
        response: {
            uuid: uuids.raceControllerResponse,
            notify: {
                callback: (msg) => {
                    print.log(`ble: rcs: on-response: `, msg);
                    // jeder SyncTX-Frame zählt als Pod-Aktivität
                    // (zwiftboard activity.touch() im sync-tx callback)
                    touch();
                    // RideOn-Echo auf SyncTX beweist: Pod ist unlocked.
                    // Der ack hält einen bereits unlockeden Pod unlocked
                    // (zwiftboard SendAck) — genau einmal pro Session
                    // (acked-Latch, zwiftboard CompareAndSwap).
                    if (!acked && Array.isArray(msg) && msg.length >= rideOn.length &&
                        msg.slice(0, rideOn.length).every((b, i) => b === rideOn[i])) {
                        acked = true;
                        print.log(`ble: rcs: sync-tx: RideOn echo — pod unlocked, acking`);
                        writeControl(new Uint8Array(ack));
                    }
                },
                parser: {
                    decode: (dataview) => Array.from(
                        new Uint8Array(dataview.buffer, dataview.byteOffset, dataview.byteLength)
                    ),
                },
            },
        },
    };

    const service = Service({spec, service: gattService, protocol, charRetryDelay: args.charRetryDelay, });
    // end service

    // methods

    // Uint8Array|Number[] -> Bool
    async function writeControl(bytes) {
        const control = service.characteristics?.control;
        if (!exists(control)) return false;
        return await control.write(new Uint8Array(bytes));
    }

    // Void -> Bool
    // Click V2 activation: "RideOn"+02 03, then 00 08 00, then 00 08 10
    // (100ms apart), then start the keepalive/idle-reset loops.
    async function protocol() {
        const control = service.characteristics?.control;
        if (!exists(control)) {
            print.warn(`ble: rcs: protocol: control characteristic missing`);
            return false;
        }

        try {
            await control.write(new Uint8Array(handshakeStart));
            await wait(100);
            await control.write(new Uint8Array([0x00, 0x08, 0x00]));
            await wait(100);
            await control.write(new Uint8Array(keep));
            print.log(`ble: rcs: protocol: activation sequence sent`);
        } catch (e) {
            print.warn(`ble: rcs: protocol: activation failed`, e);
            return false;
        }

        startKeepalive();
        return true;
    }

    // Void -> Void
    // 3s liveness probe: a successful write proves the session is up, a
    // failed one detects the disconnect. It does NOT keep a pod awake —
    // an idle pod is rebooted with a lone 0x18 before its ~65s watchdog.
    function startKeepalive() {
        stopKeepalive();
        keepaliveTimer = setInterval(async () => {
            if (stopped) return;
            const res = await writeControl(rideOn);
            if (!res) {
                // zwiftboard: der Keepalive-Write ist die Liveness-Probe.
                // Kommen weiter Frames an, lebt der Pod — der Write-Fehler
                // ist dann ein Chrome-GATT-Handle-Problem (z.B. ein
                // Zombie-Write auf halbtoter Session), kein Disconnect.
                // Warnen nur, wenn auch keine Frames mehr ankommen.
                if ((Date.now() - lastActivity) < keepaliveStaleMs) {
                    print.log(`ble: rcs: keepalive: write failed — frames still arriving, session alive`);
                } else {
                    print.warn(`ble: rcs: keepalive: write failed — session down`);
                }
            }
        }, keepaliveMs);
    }

    function stopKeepalive() {
        if (exists(keepaliveTimer)) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
    }

    // Void -> Void
    // arm the idle reset: after idleResetDelay of button silence the pod is
    // rebooted with a lone 0x18 before its ~65s sleep watchdog strands it
    // asleep for 30-40s. Any inbound frame (button or status) counts as
    // pod activity and re-arms the timer.
    function startIdleReset() {
        stopIdleReset();
        idleTimer = setTimeout(async () => {
            if (stopped || resetSent) return;
            print.log(`ble: rcs: idle — sending pod reset (0x18)`);
            // zwiftboard keepaliveTick: genau einmal pro Session — danach
            // nur noch Liveness-Pings (resetSent-Latch)
            resetSent = true;
            await writeControl(resetPod);
        }, idleResetMs);
    }

    function stopIdleReset() {
        if (exists(idleTimer)) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    // called on every inbound frame: proves the pod's own radio woke
    // enough to transmit, which is what keeps the idle reset from firing
    function touch() {
        lastActivity = Date.now();
        startIdleReset();
    }

    // Void -> Void
    // teardown: stop the loops and free the held keys of the measurement
    // parser so a dropped controller leaves no stuck key
    function teardown() {
        stopped = true;
        stopKeepalive();
        stopIdleReset();
        if (exists(raceControllerMeasurementParser.teardown)) {
            raceControllerMeasurementParser.teardown();
        }
    }

    // wrap the service setup so the idle reset is armed once notifications
    // run, and teardown runs on stop
    const serviceSetup = service.setup.bind(service);
    const serviceStop = service.stop.bind(service);

    service.setup = async function () {
        const res = await serviceSetup();
        if (res) startIdleReset();
        return res;
    };

    service.stop = async function () {
        teardown();
        return await serviceStop();
    };

    // end methods

    // expose public methods and properties
    return Object.freeze({
        ...service, // RCS will have all the public methods and properties of Service
        protocol,
        teardown,
    });
}

export default RCS;

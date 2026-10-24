// Integrationstest für die RCS-Service-Implementierung (Click V2):
// Aktivierungs-Handshake, Keepalive, Idle-Reset (0x18),
// FF03-Challenge-Ack (ff 04 00), Button-Decode und Teardown.
//
// Die GATT-Objekte werden gemockt; xf.dispatch nutzt window + CustomEvent.
// Echte Timer mit kurzen Intervallen (keepaliveMs/idleResetMs als Optionen).
const listeners = {};
globalThis.window = {
    dispatchEvent: (e) => {
        (listeners[e.type] ?? []).forEach(fn => fn(e));
        return true;
    },
    addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: (type, fn) => {
        listeners[type] = (listeners[type] ?? []).filter(f => f !== fn);
    },
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
};

const { uuids, } = require('../src/ble/web-ble.js');
const RCS = require('../src/ble/rcs/rcs.js').default;

// --- Mocks -----------------------------------------------------------------

function mockCharacteristic(uuid, written) {
    let notifyHandler = null;
    const tracking = {withResponse: 0, withoutResponse: 0};
    const char = {
        uuid,
        writeValueWithResponse: async (v) => {
            tracking.withResponse++;
            written.push(Array.from(v));
            return true;
        },
        writeValueWithoutResponse: async (v) => {
            tracking.withoutResponse++;
            written.push(Array.from(v));
            return true;
        },
        writeValue: async (v) => {
            written.push(Array.from(v));
            return true;
        },
        startNotifications: async () => {},
        stopNotifications: async () => {},
        addEventListener: (type, fn) => {
            if (type === 'characteristicvaluechanged') notifyHandler = fn;
        },
        removeEventListener: () => {},
        readValue: async () => new DataView(new Uint8Array(0).buffer),
        __notify: (dv) => {
            if (notifyHandler) notifyHandler({target: {value: dv}});
        },
        __tracking: tracking,
    };
    return char;
}

function mockGattService(chars) {
    return {
        uuid: uuids.raceController,
        getCharacteristics: async () => chars,
    };
}

function dv(bytes) {
    return new DataView(new Uint8Array(bytes).buffer);
}

const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4F, 0x6E]; // "RideOn"
const HANDSHAKE_START = [...RIDE_ON, 0x02, 0x03];
const ACK = [0xFF, 0x04, 0x00];
const KEEP = [0x00, 0x08, 0x10];
const RESET_POD = [0x18];

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// protobuf field 1 varint aus einer bitmap bauen
function buttonFrame(bitmapValue) {
    const payload = [0x08];
    let x = bitmapValue;
    do {
        let b = x & 0x7f;
        x >>>= 7;
        if (x !== 0) b |= 0x80;
        payload.push(b);
    } while (x !== 0);
    return dv([0x23, ...payload]);
}

// --- Tests -----------------------------------------------------------------

describe('RCS Click V2 Service', () => {
    let written;
    let asyncChar, controlChar, responseChar;
    let rcs;

    beforeEach(() => {
        written = {async: [], control: [], response: []};
        asyncChar = mockCharacteristic(uuids.raceControllerMeasurement, written.async);
        controlChar = mockCharacteristic(uuids.raceControllerControlPoint, written.control);
        responseChar = mockCharacteristic(uuids.raceControllerResponse, written.response);
    });

    afterEach(() => {
        if (rcs) rcs.teardown();
    });

    async function setup(opts = {}) {
        const gattService = mockGattService([asyncChar, controlChar, responseChar]);
        rcs = RCS({service: gattService, onData: () => {}, charRetryDelay: 1, ...opts});
        return await rcs.setup();
    }

    test('setup aktiviert den Pod (RideOn+02 03, 00 08 00, 00 08 10)', async () => {
        const res = await setup();
        expect(res).toBe(true);
        expect(written.control[0]).toEqual(HANDSHAKE_START);
        expect(written.control[1]).toEqual([0x00, 0x08, 0x00]);
        expect(written.control[2]).toEqual(KEEP);
    });

    test('Keepalive sendet rohes RideOn auf SyncRX', async () => {
        await setup({keepaliveMs: 50});
        await sleep(160); // > 3 Intervalle
        const rideOnWrites = written.control.filter(
            w => w.length === RIDE_ON.length && w.every((b, i) => b === RIDE_ON[i])
        );
        expect(rideOnWrites.length).toBeGreaterThanOrEqual(2);
    });

    test('Idle-Reset sendet lone 0x18 nach Button-Stille', async () => {
        await setup({idleResetMs: 50});
        await sleep(120);
        const hasReset = written.control.some(
            w => w.length === 1 && w[0] === 0x18
        );
        expect(hasReset).toBe(true);
    });

    test('Button-Frame re-armed den Idle-Reset (kein 0x18 bei Aktivität)', async () => {
        await setup({idleResetMs: 80});
        const allReleased = 0xFFFFFFFF;
        const plusPressed = (allReleased & ~0x01000) >>> 0;

        // alle 30ms ein Frame -> Idle-Reset (80ms) darf nicht feuern
        for (let i = 0; i < 6; i++) {
            asyncChar.__notify(buttonFrame(plusPressed));
            await sleep(30);
        }
        const hasReset = written.control.some(
            w => w.length === 1 && w[0] === 0x18
        );
        expect(hasReset).toBe(false);
    });

    test('FF 03 Challenge auf Async wird mit ff 04 00 gequittet', async () => {
        await setup();
        const before = written.control.length;

        asyncChar.__notify(dv([0xFF, 0x03, 0x00]));
        await sleep(10);

        const ackFrame = written.control.slice(before).find(
            w => w.length === 3 && w[0] === 0xFF && w[1] === 0x04 && w[2] === 0x00
        );
        expect(ackFrame).toEqual(ACK);
    });

    test('FF 05 Status-Frame erzeugt kein Ack', async () => {
        await setup();
        const before = written.control.length;

        asyncChar.__notify(dv([0xFF, 0x05, 0x00]));
        await sleep(10);

        const ackFrame = written.control.slice(before).find(
            w => w.length === 3 && w[0] === 0xFF && w[1] === 0x04
        );
        expect(ackFrame).toBeUndefined();
    });

    test('Button-Frame (0x23) wird decodiert und als Taste weitergeleitet', async () => {
        const events = [];
        const h = () => events.push('key:space');
        window.addEventListener('key:space', h);

        await setup();

        const allReleased = 0xFFFFFFFF;
        const plusPressed = (allReleased & ~0x01000) >>> 0;
        asyncChar.__notify(buttonFrame(plusPressed));
        await sleep(10);

        expect(events).toContain('key:space');
        window.removeEventListener('key:space', h);
    });

    test('teardown stoppt Keepalive und Idle-Reset', async () => {
        await setup({keepaliveMs: 50, idleResetMs: 50});
        rcs.teardown();

        const before = written.control.length;
        await sleep(200);
        expect(written.control.length).toBe(before);
    });

    test('SyncRX-Write nutzt Write-Command (writeValueWithoutResponse)', async () => {
        await setup();

        // zwiftboard writeChar: WriteWithoutResponse zuerst
        expect(controlChar.__tracking.withoutResponse).toBeGreaterThan(0);
        expect(controlChar.__tracking.withResponse).toBe(0);
    });

    test('SyncTX RideOn-Echo erzeugt genau einmal den Ack (acked-Latch)', async () => {
        await setup();
        const before = written.control.length;

        responseChar.__notify(dv(RIDE_ON));
        await sleep(10);
        responseChar.__notify(dv(RIDE_ON));
        await sleep(10);

        const acks = written.control.slice(before).filter(
            w => w.length === 3 && w[0] === 0xFF && w[1] === 0x04 && w[2] === 0x00
        );
        expect(acks.length).toBe(1);
    });

    test('Button-Frame dispatched ble:raceController:action (UI-Feedback)', async () => {
        const actions = [];
        const h = (e) => actions.push(e.detail.data);
        window.addEventListener('ble:raceController:action', h);

        await setup();

        const allReleased = 0xFFFFFFFF;
        const plusPressed = (allReleased & ~0x01000) >>> 0;
        asyncChar.__notify(buttonFrame(plusPressed));
        await sleep(10);

        expect(actions).toContain('plus');
        window.removeEventListener('ble:raceController:action', h);
    });

    test('getCharacteristics-Retry: leeres erstes Listing wird wiederholt', async () => {
        // WinRT liefert direkt nach dem Connect oft eine leere/partial Liste
        let calls = 0;
        const flakyService = {
            uuid: uuids.raceController,
            getCharacteristics: async () => {
                calls++;
                if (calls === 1) return [];
                return [asyncChar, controlChar, responseChar];
            },
        };

        rcs = RCS({service: flakyService, onData: () => {}, charRetryDelay: 1});
        const res = await rcs.setup();

        expect(res).toBe(true);
        expect(calls).toBe(2);
        expect(written.control[0]).toEqual(HANDSHAKE_START);
    });

    test('Idle-Reset feuert genau einmal pro Session (resetSent-Latch)', async () => {
        // zwiftboard keepaliveTick: nach dem 0x18-Reset kommen nur noch
        // Liveness-Pings — kein zweiter Reset in derselben Session
        await setup({idleResetMs: 50});
        await sleep(150); // Reset hätte feuern können

        let resets = written.control.filter(
            w => w.length === 1 && w[0] === 0x18
        );
        expect(resets.length).toBe(1);

        // weitere Stille — der Latch verhindert einen zweiten Reset
        await sleep(150);
        resets = written.control.filter(
            w => w.length === 1 && w[0] === 0x18
        );
        expect(resets.length).toBe(1);
    });

    test('SyncTX-Frame re-armed den Idle-Reset (keine 0x18 bei Aktivität)', async () => {
        // zwiftboard: JEDER eingehende Frame (async UND sync-tx) zählt als
        // Pod-Aktivität und hält den Idle-Reset offen
        await setup({idleResetMs: 80});

        for (let i = 0; i < 6; i++) {
            responseChar.__notify(dv(RIDE_ON));
            await sleep(30);
        }

        const hasReset = written.control.some(
            w => w.length === 1 && w[0] === 0x18
        );
        expect(hasReset).toBe(false);
    });

    test('Keepalive läuft bei Write-Fehlern weiter (Liveness-Probe)', async () => {
        // totes GATT-Handle: die Handshake-Writes (3×) funktionieren noch,
        // danach wirft jeder Keepalive-Write — der Keepalive darf nicht
        // abstürzen und muss weiterlaufen (zwiftboard: fehlgeschlagener
        // Write = Disconnect-Signal, kein Crash)
        let writes = 0;
        let keepaliveAttempts = 0;
        const failingControl = mockCharacteristic(uuids.raceControllerControlPoint, written.control);
        failingControl.writeValueWithoutResponse = async (v) => {
            writes++;
            if (writes > 3) {
                keepaliveAttempts++;
                throw new Error('dead session');
            }
            written.control.push(Array.from(v));
            return true;
        };

        const gattService = mockGattService([asyncChar, failingControl, responseChar]);
        rcs = RCS({service: gattService, onData: () => {}, charRetryDelay: 1, keepaliveMs: 50});
        const res = await rcs.setup();
        expect(res).toBe(true);

        const before = keepaliveAttempts;
        await sleep(160); // mehrere Keepalive-Ticks, alle fehlgeschlagen
        expect(keepaliveAttempts).toBeGreaterThan(before);
    });
});

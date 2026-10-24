// Decoder-Test für den Zwift Click V2 (Race Controller Measurement).
// xf.dispatch nutzt window.dispatchEvent + CustomEvent — hier minimal stuben.
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

const { RaceControllerMeasurement, Buttons, KnownMask, bitmap, uvarint, } =
    require('../src/ble/rcs/race-controller-measurement.js');

// --- Helpers ---------------------------------------------------------------

// protobuf: field 1 (varint) = bitmap
function frame(bitmapValue) {
    // field 1, wire type 0 (varint): tag = (1 << 3) | 0 = 0x08
    const payload = [0x08, ...encodeVarint(bitmapValue)];
    return new DataView(new Uint8Array([0x23, ...payload]).buffer);
}

function encodeVarint(v) {
    const out = [];
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) b |= 0x80;
        out.push(b);
    } while (v !== 0);
    return out;
}

function dv(bytes) {
    return new DataView(new Uint8Array(bytes).buffer);
}

// --- Tests -----------------------------------------------------------------

describe('Click V2 bitmap/uvarint', () => {
    test('bitmap decodes varint field 1', () => {
        const [v, ok] = bitmap(new Uint8Array([0x08, 0x90, 0x01])); // 144
        expect(ok).toBe(true);
        expect(v).toBe(144);
    });

    test('bitmap decodes 32-bit varint', () => {
        // 0xFFFFFFFF als varint = FF FF FF FF 0F (5 Bytes)
        const [v, ok] = bitmap(new Uint8Array([0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]));
        expect(ok).toBe(true);
        expect(v).toBe(0xFFFFFFFF);
    });

    test('bitmap skips unknown fields (field 2)', () => {
        const [, ok] = bitmap(new Uint8Array([0x10, 0x05]));
        expect(ok).toBe(false);
    });

    test('uvarint decodes 300', () => {
        const [v, n] = uvarint(new Uint8Array([0xAC, 0x02]), 0);
        expect(v).toBe(300);
        expect(n).toBe(2);
    });

    test('Buttons map has 10 entries', () => {
        expect(Object.keys(Buttons).length).toBe(10);
    });

    test('KnownMask covers all defined bits', () => {
        const expected = (0x00001 | 0x00002 | 0x00004 | 0x00008 | 0x00010 |
                          0x00020 | 0x00040 | 0x00080 | 0x00100 | 0x01000);
        expect(KnownMask).toBe(expected);
    });
});

describe('Click V2 decode', () => {
    let events;
    let handlers;
    let parsers;

    beforeEach(() => {
        events = [];
        handlers = {};
        parsers = [];
    });

    afterEach(() => {
        // heldCount ist modul-global (Mirror-Dedup über alle Instanzen):
        // jeder Test räumt seine Parser auf, damit keine Bits hängen bleiben
        parsers.forEach(p => p.teardown());
        Object.keys(handlers).forEach(unlisten);
    });

    function track(parser) {
        parsers.push(parser);
        return parser;
    }

    function listen(event, fn) {
        (listeners[event] = listeners[event] ?? []).push(fn);
        handlers[event] = fn;
    }

    function unlisten(event) {
        if (handlers[event]) {
            listeners[event] = (listeners[event] ?? []).filter(f => f !== handlers[event]);
            delete handlers[event];
        }
    }

    test('PLUS pressed dispatches key:space', () => {
        listen('key:space', () => events.push('key:space'));

        const parser = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const plusPressed = (allPressed & ~0x01000) >>> 0;

        const msg = parser.decode(frame(plusPressed));
        expect(msg.type).toBe('buttons');
        expect(msg.buttons.some(b => b.name === 'PLUS' && b.pressed)).toBe(true);
        expect(events).toContain('key:space');

        unlisten('key:space');
    });

    test('release produces a release edge (pressed=false)', () => {
        const parser = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const plusPressed = (allPressed & ~0x01000) >>> 0;

        parser.decode(frame(plusPressed));
        const msg2 = parser.decode(frame(allPressed));
        // das Release ist ein Edge: PLUS mit pressed=false
        expect(msg2.buttons.length).toBe(1);
        expect(msg2.buttons[0]).toEqual({name: 'PLUS', pressed: false});
    });

    test('identical retransmit is deduped (no second event)', () => {
        listen('key:up', () => events.push('key:up'));

        const parser = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const aPressed = (allPressed & ~0x00002) >>> 0;

        parser.decode(frame(aPressed));
        parser.decode(frame(aPressed));
        expect(events.length).toBe(1);

        unlisten('key:up');
    });

    test('idle/status frames 0x15 and 0x19 are ignored', () => {
        const parser = track(RaceControllerMeasurement({}));
        expect(parser.decode(dv([0x15, 0x00])).type).toBe('idle');
        expect(parser.decode(dv([0x19, 0x00])).type).toBe('idle');
    });

    test('FF 03 crypto challenge triggers onChallenge', () => {
        let challenged = false;
        const parser = track(RaceControllerMeasurement({
            onChallenge: () => { challenged = true; },
        }));
        const msg = parser.decode(dv([0xFF, 0x03, 0x00]));
        expect(msg.type).toBe('challenge');
        expect(challenged).toBe(true);
    });

    test('FF 05 battery/status frame is ignored', () => {
        let challenged = false;
        const parser = track(RaceControllerMeasurement({
            onChallenge: () => { challenged = true; },
        }));
        const msg = parser.decode(dv([0xFF, 0x05, 0x00]));
        expect(msg.type).toBe('status');
        expect(challenged).toBe(false);
    });

    test('mirror dedup: two instances, same frame, one event', () => {
        listen('key:space', () => events.push('key:space'));

        const p1 = track(RaceControllerMeasurement({}));
        const p2 = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const plusPressed = (allPressed & ~0x01000) >>> 0;

        p1.decode(frame(plusPressed));
        p2.decode(frame(plusPressed));
        expect(events.length).toBe(1);

        unlisten('key:space');
    });

    test('teardown frees held bits so a later press lands', () => {
        listen('key:space', () => events.push('key:space'));

        const p1 = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const plusPressed = (allPressed & ~0x01000) >>> 0;

        p1.decode(frame(plusPressed));
        p1.teardown();
        p1.decode(frame(plusPressed));
        expect(events.length).toBe(2);

        unlisten('key:space');
    });

    test('unknown bits are logged but not dispatched', () => {
        listen('key:up', () => events.push('key:up'));

        const parser = track(RaceControllerMeasurement({}));
        const allPressed = 0xFFFFFFFF;
        const unknownBit = (allPressed & ~0x00040000) >>> 0; // BIT18

        const msg = parser.decode(frame(unknownBit));
        expect(msg.buttons.some(b => b.name === 'BIT18')).toBe(true);
        expect(events.length).toBe(0);

        unlisten('key:up');
    });

    test('A/B/Y/Z/LEFT/RIGHT/MIN map to their key events', () => {
        const map = [
            ['A', 0x00010, 'key:up'],
            ['B', 0x00020, 'key:down'],
            ['Y', 0x00040, 'key:e'],
            ['Z', 0x00080, 'key:l'],
            ['LEFT', 0x00001, 'key:left'],
            ['RIGHT', 0x00004, 'key:right'],
            ['MIN', 0x00100, 'key:down'],
        ];

        for (const [name, bit, event] of map) {
            listen(event, () => events.push(event));
            const parser = track(RaceControllerMeasurement({}));
            const allPressed = 0xFFFFFFFF;
            const pressed = (allPressed & ~bit) >>> 0;
            parser.decode(frame(pressed));
            expect(events).toContain(event);
            unlisten(event);
        }
    });
});

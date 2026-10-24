//
// Race Controller Measurement Characteristic - Zwift Click V2 Protocol
//
// Protocol facts (Click V2, after zwiftboard):
//   - button frames: 0x23 + protobuf; field 1 (varint) = uint32 bitmap,
//     bit == 0 means pressed
//   - 0x15 / 0x19 are idle & status frames (no buttons)
//   - 0xFF 03 on the async characteristic is a crypto challenge; the pod
//     must be acked with ff 04 00 to keep the button stream alive
//   - 0xFF 05 is a routine battery/status frame (ignored here)
//   - the Click V2 is a PAIR: both pods mirror every button frame, so one
//     physical press arrives once from each unit — the shared heldCount
//     dedups it (first reservation dispatches, last release clears)
//
import { xf, print, exists, } from '../../functions.js';

// MsgKeyPad is the frame type carrying the button bitmap
const MsgKeyPad = 0x23;

// Click V2 button bitmap bits (bit == 0 in the frame means pressed)
const Buttons = {
    0x00001: 'LEFT',   // left module, arrow left
    0x00002: 'UP',     // left module, arrow up
    0x00004: 'RIGHT',  // left module, arrow right
    0x00008: 'DOWN',   // left module, arrow down
    0x00010: 'A',
    0x00020: 'B',
    0x00040: 'Y',
    0x00080: 'Z',
    0x00100: 'MIN',    // left module, minus
    0x01000: 'PLUS',   // right module, plus
};

// KnownMask is the union of all defined button bits
const KnownMask = Object.keys(Buttons)
    .reduce((acc, k) => (acc | Number(k)), 0) >>> 0;

// button name -> auuki key event (same events the on-screen keyboard uses)
const KeyMap = {
    PLUS:  'key:space', // start / stop
    A:     'key:up',    // increase target
    B:     'key:down',  // decrease target
    Y:     'key:e',     // erg mode
    Z:     'key:l',     // lap
    UP:    'key:up',
    DOWN:  'key:down',
    LEFT:  'key:left',
    RIGHT: 'key:right',
    MIN:   'key:down',
};

// shared across ALL controller instances (the Click V2 pair mirrors every
// frame): how many live handlers currently see each bitmap bit pressed
const heldCount = new Map(); // bit -> Int

// Press reserves the bit in the shared count (deduping the mirrored
// duplicate from the pair's other unit) and returns whether this is the
// first reservation (the only instance that dispatches the key event).
function press(bit) {
    heldCount.set(bit, (heldCount.get(bit) ?? 0) + 1);
    return heldCount.get(bit) === 1;
}

// Release removes this instance's reservation and returns whether no live
// handler sees the bit pressed anymore.
function release(bit) {
    const n = heldCount.get(bit) ?? 0;
    if (n <= 0) return false;
    heldCount.set(bit, n - 1);
    return heldCount.get(bit) === 0;
}

// ReleaseAll frees every bit this instance holds (session dropped mid-hold:
// the release edge never arrived). A bit the sibling instance still sees
// pressed stays down — its own release lifts it.
function releaseAll(own) {
    for (const bit of own) {
        const n = heldCount.get(bit) ?? 0;
        if (n > 0) {
            heldCount.set(bit, n - 1);
            if (heldCount.get(bit) === 0) heldCount.delete(bit);
        }
    }
    own.clear();
}

// uvarint decode at position i; returns [value, nextIndex] or [0, 0] on error
function uvarint(b, i) {
    let x = 0, shift = 0;
    for (; i < b.length; i++) {
        const c = b[i];
        x += (c & 0x7f) * Math.pow(2, shift);
        if (c < 0x80) return [x, i + 1];
        shift += 7;
        // a 32-bit varint needs at most 5 bytes (shifts 0,7,14,21,28)
        if (shift > 28) return [0, 0];
    }
    return [0, 0];
}

// Bitmap extracts protobuf field 1 (varint) = key bitmap from frame payload,
// skipping other fields. Returns [bitmap, ok].
function bitmap(p) {
    let i = 0;
    while (i < p.length) {
        const [tag, n1] = uvarint(p, i);
        if (n1 === 0) return [0, false];
        i = n1;
        const num = Math.floor(tag / 8), wt = tag % 8;
        if (wt === 0) {
            const [v, n2] = uvarint(p, i);
            if (n2 === 0) return [0, false];
            i = n2;
            if (num === 1) return [v, true];
        } else if (wt === 1) {
            i += 8;
        } else if (wt === 2) {
            const [l, n3] = uvarint(p, i);
            if (n3 === 0) return [0, false];
            i = n3 + l;
        } else if (wt === 5) {
            i += 4;
        } else {
            return [0, false];
        }
    }
    return [0, false];
}

function RaceControllerMeasurement(args = {}) {
    // called when the pod sends the 0xFF 03 crypto challenge; the caller
    // acks with ff 04 00 to keep the button stream alive
    const onChallenge = args.onChallenge ?? (() => {});

    // called on EVERY inbound frame: any frame proves the pod's own radio
    // woke enough to transmit, which is what keeps the idle reset from
    // firing during a close session
    const onFrame = args.onFrame ?? (() => {});

    // observational callback: (buttonName, down) — mirrors every frame
    const onKey = args.onKey ?? (() => {});

    // per instance state
    let prev = 0xFFFFFFFF; // all released
    const own = new Set(); // bits THIS instance sees pressed

    function dispatch(name) {
        const event = KeyMap[name];
        if (!exists(event)) return;
        xf.dispatch(event);
    }

    // DataView -> {type, action, buttons}
    function decode(dataview) {
        const msg = {type: 'unknown', action: 'none', buttons: []};

        // leere/undefined Notification (Console: 'print.log undefined') —
        // kein Frame, nichts zu decodieren
        if (!exists(dataview)) return msg;

        const bytes = Array.from(
            new Uint8Array(dataview.buffer, dataview.byteOffset, dataview.byteLength)
        );

        if (bytes.length === 0) return msg;

        // any inbound frame counts as pod activity (re-arms the idle reset)
        onFrame();

        // crypto challenge on the async characteristic — ack it to keep the
        // button stream alive on an already-unlocked pod
        if (bytes[0] === 0xFF && bytes.length > 1 && bytes[1] === 0x03) {
            msg.type = 'challenge';
            print.log(`ble: rcs: rx: crypto challenge — acking`);
            onChallenge();
            return msg;
        }

        // 0xFF 05 routine battery/status frame — deliberately ignored
        if (bytes[0] === 0xFF) {
            msg.type = 'status';
            return msg;
        }

        // only 0x23 frames carry the button bitmap (0x15/0x19 idle & status)
        if (bytes[0] !== MsgKeyPad) {
            msg.type = 'idle';
            return msg;
        }

        const [cur, ok] = bitmap(bytes.slice(1));
        if (!ok) return msg;

        msg.type = 'buttons';

        // edge detection: ignore identical retransmits within one instance
        // (zwiftboard masks unknown bits only when debug is off; here every
        // edge is reported, unknown bits are logged but never dispatched)
        const changed = (cur ^ prev) >>> 0;

        for (let bit = 0; bit < 32; bit++) {
            const m = (1 << bit) >>> 0;
            if ((changed & m) === 0) continue;

            const name = Buttons[m] ?? `BIT${bit}`;
            const pressed = (cur & m) === 0; // bit == 0 means pressed

            msg.buttons.push({name, pressed});
            if (!exists(Buttons[m])) continue; // unknown bit: log only

            if (pressed) {
                own.add(m);
                // first reservation dispatches (absorbs the mirrored frame
                // arriving from the pair's other unit)
                if (press(m)) {
                    msg.action = name.toLowerCase();
                    dispatch(name);
                    onKey(name, true);
                }
            } else {
                if (!own.has(m)) continue; // never saw it pressed here
                own.delete(m);
                release(m);
                onKey(name, false);
            }
        }

        if (msg.buttons.length > 0) {
            print.log(`ble: rcs: rx: buttons: `, msg.buttons);
        }

        prev = cur;
        return msg;
    }

    // session dropped: free every bit this instance holds so a later press
    // can still land (mirrors zwiftboard's ReleaseAll)
    function teardown() {
        releaseAll(own);
        prev = 0xFFFFFFFF;
    }

    return Object.freeze({
        decrypt: (dv) => '',
        decode,
        teardown,
    });
}

export {
    RaceControllerMeasurement,
    Buttons,
    KnownMask,
    KeyMap,
    bitmap,
    uvarint,
};

// Terminal formatting helpers for the CLI.
//
// Pure ANSI — no chalk, no picocolors, nothing new in the bundle. The
// wrapper functions all no-op when stdout isn't a TTY or NO_COLOR is
// set, so redirected output stays plain and grep-friendly.
//
// Design intent: the CLI should feel structured without being noisy.
// We use dim for metadata (timestamps, relay URLs, pubkeys), bold for
// values the user cares about, colored markers for event types (green
// → send, blue ← receive, yellow + join, dim - leave), and consistent
// two-space indentation for multi-line blocks.

const useColor =
    !!process.stdout.isTTY &&
    process.env.NO_COLOR !== '1' &&
    process.env.TERM !== 'dumb';

function wrap(code: string): (s: string) => string {
    return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const bold = wrap('1');
export const dim = wrap('2');
export const italic = wrap('3');
export const underline = wrap('4');

export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');
export const gray = wrap('90');

// Icons. Fall back to ASCII under NO_COLOR / dumb terminals since
// some environments render the unicode variants as tofu.
const unicodeIcons = useColor;
export const ICON_OK = unicodeIcons ? '✓' : 'ok';
export const ICON_ERR = unicodeIcons ? '✗' : 'x';
export const ICON_INFO = unicodeIcons ? '●' : '*';
export const ICON_ARROW_R = unicodeIcons ? '→' : '->';
export const ICON_ARROW_L = unicodeIcons ? '←' : '<-';
export const ICON_JOIN = unicodeIcons ? '+' : '+';
export const ICON_LEAVE = unicodeIcons ? '−' : '-';
export const ICON_BULLET = unicodeIcons ? '•' : '*';

/** Two-character-wide tag used to prefix event lines. Colored by event
 *  type so the user can scan the stream. */
export function tag(type: 'ok' | 'err' | 'info' | 'recv' | 'send' | 'join' | 'leave'): string {
    switch (type) {
        case 'ok':
            return green(ICON_OK);
        case 'err':
            return red(ICON_ERR);
        case 'info':
            return cyan(ICON_INFO);
        case 'recv':
            return blue(ICON_ARROW_L);
        case 'send':
            return green(ICON_ARROW_R);
        case 'join':
            return yellow(ICON_JOIN);
        case 'leave':
            return gray(ICON_LEAVE);
    }
}

/** Section header. Used once at the top of a subcommand's output to
 *  set scope. Intentionally low-contrast — the content below it is
 *  what the user is reading. */
export function header(title: string, subtitle?: string): string {
    const main = bold(title);
    if (subtitle) return `${main}  ${dim(subtitle)}`;
    return main;
}

/** Render a list of label → value pairs with right-aligned labels and
 *  dim styling on the label column. Labels are padded to the longest
 *  label width so the values line up. */
export function keyValue(pairs: Array<[string, string]>): string {
    if (pairs.length === 0) return '';
    const width = Math.max(...pairs.map(([k]) => k.length));
    return pairs
        .map(([k, v]) => `  ${dim(k.padEnd(width))}  ${v}`)
        .join('\n');
}

/** Truncate a long base64url pubkey to a scannable short form. */
export function shortPubkey(pub: string, length = 8): string {
    if (pub.length <= length) return pub;
    return pub.slice(0, length);
}

/** Format a unix ms timestamp (or Date) as a concise clock + dim. */
export function timestamp(input: Date | number = Date.now()): string {
    const d = typeof input === 'number' ? new Date(input) : input;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return dim(`${hh}:${mm}:${ss}`);
}

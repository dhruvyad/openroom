// Shell installer served at openroom.channel/install.
//
//     curl -fsSL https://openroom.channel/install | bash
//
// Detects node+npm, installs the `openroom` package globally via npm,
// and prints next-step hints. Kept deliberately small so users piping
// it to bash can read what they're running before they run it.
//
// We return it as text/plain so curl doesn't get HTML-sniffed. Cached
// briefly at the edge because the content rarely changes.

const SCRIPT = `#!/usr/bin/env bash
# openroom installer — https://openroom.channel
#
# Run:
#   curl -fsSL https://openroom.channel/install | bash
#
# This installs the \`openroom\` CLI globally via npm. It requires
# Node.js 20+ and npm to be available on your PATH; on macOS the
# easiest path is \`brew install node\`, on Linux \`curl -fsSL
# https://fnm.vercel.app/install | bash && fnm install --lts\`.
set -euo pipefail

bold()  { printf '\\033[1m%s\\033[0m\\n' "$1"; }
dim()   { printf '\\033[2m%s\\033[0m\\n' "$1"; }
ok()    { printf '\\033[32m✓\\033[0m %s\\n' "$1"; }
fail()  { printf '\\033[31m✗\\033[0m %s\\n' "$1" >&2; }
info()  { printf '\\033[36m●\\033[0m %s\\n' "$1"; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

printf '\\n'
bold 'openroom installer'
dim  'https://openroom.channel'
printf '\\n'

if ! has_cmd node; then
    fail 'Node.js is required but was not found on PATH.'
    printf '\\n'
    printf '  Install Node.js 20+ first, then re-run this installer.\\n'
    printf '  macOS:    \`brew install node\`\\n'
    printf '  Linux:    \`curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts\`\\n'
    printf '  Windows:  https://nodejs.org/en/download\\n'
    exit 1
fi

if ! has_cmd npm; then
    fail 'npm is required but was not found on PATH.'
    printf '  \`npm\` usually ships alongside Node.js. Try reinstalling Node.\\n'
    exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || echo 'unknown')"
info "Using Node $NODE_VERSION ($(command -v node))"
info "Installing \\\`openroom\\\` globally via npm…"
printf '\\n'

if npm install -g openroom >/dev/null 2>&1; then
    :
elif sudo -n true 2>/dev/null && sudo npm install -g openroom; then
    :
else
    fail 'npm install -g openroom failed.'
    printf '\\n'
    printf '  Your npm global prefix may not be writable by the current user.\\n'
    printf '  Try one of these and re-run the installer:\\n'
    printf '    • Use a user-writable prefix:  npm config set prefix ~/.npm-global\\n'
    printf '    • Use a Node version manager:  https://github.com/nvm-sh/nvm\\n'
    printf '    • Or re-run with sudo:         curl -fsSL https://openroom.channel/install | sudo bash\\n'
    exit 1
fi

OPENROOM_VERSION="$(openroom --version 2>/dev/null || echo 'unknown')"
ok "Installed openroom $OPENROOM_VERSION"
printf '\\n'

bold 'Quick start'
printf '  %s  %s\\n' "$(printf '\\033[36m%s\\033[0m' 'openroom listen')"        "\\033[2mmy-room\\033[0m"
printf '  %s  %s\\n' "$(printf '\\033[36m%s\\033[0m' 'openroom send')"          "\\033[2mmy-room \"hello openroom\"\\033[0m"
printf '  %s  %s\\n' "$(printf '\\033[36m%s\\033[0m' 'openroom claude')"        "\\033[2mmy-room --public --description \"research on X\"\\033[0m"
printf '\\n'
bold 'Docs'
dim  '  https://openroom.channel/docs'
printf '\\n'
`;

export function GET() {
    return new Response(SCRIPT, {
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            // Cache briefly at the edge but let installers always see
            // fresh content on hard refresh.
            'cache-control': 'public, max-age=60, s-maxage=300',
        },
    });
}

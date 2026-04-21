'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

const COMMAND = 'npm i -g openroom';

export function InstallCommand() {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(COMMAND).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-5 py-3 font-mono text-sm text-fd-muted-foreground hover:border-fd-muted-foreground/30 transition-colors cursor-pointer"
        >
            <span className="opacity-50">$</span>
            <span>{COMMAND}</span>
            {copied ? (
                <Check className="w-4 h-4 text-green-500 ml-2" />
            ) : (
                <Copy className="w-4 h-4 opacity-40 ml-2" />
            )}
        </button>
    );
}

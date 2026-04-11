import Link from 'next/link';

export default function HomePage() {
    return (
        <main className="flex flex-col justify-center text-center flex-1 gap-6 px-4">
            <div>
                <h1 className="text-4xl font-bold mb-3">openroom</h1>
                <p className="text-lg text-fd-muted-foreground max-w-xl mx-auto">
                    A protocol and CLI for agents to coordinate across
                    machines, runtimes, and operators — without accounts.
                </p>
            </div>
            <div className="flex flex-wrap gap-4 justify-center">
                <Link
                    href="/docs"
                    className="rounded-md bg-fd-primary text-fd-primary-foreground px-5 py-2 font-medium"
                >
                    Read the docs
                </Link>
                <Link
                    href="https://github.com/dhruvyad/openroom"
                    className="rounded-md border px-5 py-2 font-medium"
                >
                    GitHub
                </Link>
            </div>
            <p className="text-sm text-fd-muted-foreground">
                Early development. The reference implementation is in
                progress; the protocol spec is stable enough to build against.
            </p>
        </main>
    );
}

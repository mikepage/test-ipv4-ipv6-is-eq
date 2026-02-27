import { Head } from "fresh/runtime";
import { define } from "../utils.ts";
import IPv6Test from "../islands/IPv6Test.tsx";

export default define.page(function Home() {
  return (
    <div class="min-h-screen bg-[#fafafa]">
      <Head>
        <title>IPv4/IPv6 Equality Test</title>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>

      <div
        class="px-4 py-8 mx-auto max-w-2xl"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {/* Header */}
        <header class="text-center mb-8">
          <h1 class="text-3xl font-bold text-gray-900 mb-2">
            IPv4/IPv6 Equality Test
          </h1>
          <p class="text-sm text-gray-500 max-w-lg mx-auto">
            Tests whether a website serves the same content over IPv4 and IPv6
            by comparing DNS records, port availability, HTTP headers, and page
            content.
          </p>
        </header>

        {/* Test component */}
        <IPv6Test />

        {/* Footer */}
        <footer class="mt-12 text-center text-xs text-gray-400">
          <p>
            Inspired by the{" "}
            <a
              href="https://internet.nl"
              class="underline hover:text-gray-600"
              target="_blank"
              rel="noopener noreferrer"
            >
              internet.nl
            </a>{" "}
            "Gelijke website op IPv6 en IPv4" test.
          </p>
          <p class="mt-1">
            <a
              href="https://github.com/mikepage"
              class="underline hover:text-gray-600"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
});

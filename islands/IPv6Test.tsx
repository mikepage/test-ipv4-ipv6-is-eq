import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface PortResult {
  ipv4: boolean;
  ipv6: boolean;
  equal: boolean;
}

interface HeaderDiff {
  header: string;
  ipv4Value: string | null;
  ipv6Value: string | null;
}

interface HeaderEntry {
  name: string;
  value: string;
}

interface TestResult {
  url: string;
  hostname: string;
  ipv4Address: string | null;
  ipv6Address: string | null;
  portCheck: {
    http: PortResult;
    https: PortResult;
  };
  headerComparison: {
    ipv4StatusCode: number | null;
    ipv6StatusCode: number | null;
    statusEqual: boolean;
    headerDiffs: HeaderDiff[];
    ipv4Headers: HeaderEntry[];
    ipv6Headers: HeaderEntry[];
  };
  contentComparison: {
    similarityPercent: number | null;
    pass: boolean;
  };
  followedRedirects: {
    ipv4: string[];
    ipv6: string[];
  };
  connectedAddresses: {
    ipv4: string | null;
    ipv6: string | null;
  };
  overallPass: boolean;
  error?: string;
  debug?: { ipv4Error?: string; ipv6Error?: string };
}

function isValidUrl(input: string): boolean {
  if (!input.trim()) return false;
  try {
    new URL(input.startsWith("http") ? input : `https://${input}`);
    return true;
  } catch {
    return false;
  }
}

function StatusIcon({ status }: { status: "pass" | "warn" | "fail" }) {
  if (status === "pass") {
    return (
      <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-600 text-sm font-bold">
        ✓
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 text-yellow-600 text-sm font-bold">
        !
      </span>
    );
  }
  return (
    <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-600 text-sm font-bold">
      ✕
    </span>
  );
}

function ResultCard(
  { title, status, children }: {
    title: string;
    status: "pass" | "warn" | "fail";
    children: preact.ComponentChildren;
  },
) {
  return (
    <div class="bg-white rounded-lg shadow p-6">
      <div class="flex items-center gap-3 mb-4">
        <StatusIcon status={status} />
        <h3 class="text-lg font-semibold text-gray-800">{title}</h3>
      </div>
      <div class="text-sm text-gray-600 space-y-2">{children}</div>
    </div>
  );
}

function ShimmerCard() {
  return (
    <div class="bg-white rounded-lg shadow p-6 animate-pulse">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-6 h-6 rounded-full bg-gray-200" />
        <div class="h-5 w-40 bg-gray-200 rounded" />
      </div>
      <div class="space-y-2">
        <div class="h-4 w-full bg-gray-200 rounded" />
        <div class="h-4 w-3/4 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

function HeaderTable(
  { headers, label }: { headers: HeaderEntry[]; label: string },
) {
  if (headers.length === 0) return null;
  return (
    <div>
      <div class="font-medium text-gray-700 mb-1">{label}</div>
      <div class="bg-gray-50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
        <table class="w-full text-xs">
          <tbody>
            {headers.map((h, i) => (
              <tr key={i} class="border-b border-gray-100 last:border-0">
                <td class="py-0.5 pr-2 font-mono font-medium text-gray-700 whitespace-nowrap align-top">
                  {h.name}
                </td>
                <td class="py-0.5 font-mono break-all text-gray-500">
                  {h.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function IPv6Test() {
  const url = useSignal("");
  const followRedirects = useSignal(false);
  const loading = useSignal(false);
  const result = useSignal<TestResult | null>(null);
  const error = useSignal<string | null>(null);
  const showHeaders = useSignal(false);
  const expandedDiffs = useSignal(false);

  function updateHash(value: string) {
    if (value.trim()) {
      window.history.replaceState(null, "", `#${value.trim()}`);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  // Sync hash → state on mount and hashchange
  useEffect(() => {
    let mounted = true;
    const handleHash = () => {
      const hash = window.location.hash.replace(/^#/, "").trim();
      if (hash && mounted) {
        url.value = hash;
        // Auto-run test on initial load with hash
        setTimeout(() => {
          if (mounted && url.value === hash) runTest();
        }, 0);
      }
    };
    handleHash();
    globalThis.addEventListener("hashchange", handleHash);
    return () => {
      mounted = false;
      globalThis.removeEventListener("hashchange", handleHash);
    };
  }, []);

  async function runTest() {
    const testUrl = url.value.trim();
    if (!testUrl) return;

    // Update hash when running a test
    updateHash(testUrl);

    loading.value = true;
    result.value = null;
    error.value = null;
    showHeaders.value = false;
    expandedDiffs.value = false;

    try {
      const params = new URLSearchParams({
        url: testUrl,
        followRedirects: String(followRedirects.value),
      });
      const resp = await fetch(`/api/test?${params}`);
      const data = await resp.json();

      if (!resp.ok && data.error) {
        error.value = data.error;
      } else {
        result.value = data;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Request failed";
    } finally {
      loading.value = false;
    }
  }

  const r = result.value;

  return (
    <div class="w-full max-w-2xl mx-auto">
      {/* Input form */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <div class="flex flex-col gap-4">
          <div>
            <label
              class="block text-sm font-medium text-gray-700 mb-1"
              for="url-input"
            >
              Website URL
            </label>
            <input
              id="url-input"
              type="text"
              placeholder="e.g. google.com"
              value={url.value}
              onInput={(e) =>
                url.value = (e.target as HTMLInputElement).value}
              onKeyDown={(e) => {
                if (e.key === "Enter") runTest();
              }}
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono text-sm"
            />
          </div>
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={followRedirects.value}
                onChange={(e) =>
                  followRedirects.value =
                    (e.target as HTMLInputElement).checked}
                class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Follow redirects
            </label>
            <button
              onClick={runTest}
              disabled={loading.value || !isValidUrl(url.value)}
              class="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading.value ? "Testing..." : "Run Test"}
            </button>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading.value && (
        <div class="space-y-4">
          <ShimmerCard />
          <ShimmerCard />
          <ShimmerCard />
          <ShimmerCard />
        </div>
      )}

      {/* Error state */}
      {error.value && (
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error.value}
        </div>
      )}

      {/* Results */}
      {r && (
        <div class="space-y-4">
          {/* Overall result */}
          <div
            class={`rounded-lg p-4 text-center font-semibold ${
              r.overallPass
                ? "bg-green-50 text-green-800 border border-green-200"
                : r.error
                ? "bg-yellow-50 text-yellow-800 border border-yellow-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {r.overallPass
              ? "PASS — IPv4 and IPv6 serve equivalent content"
              : r.error
              ? r.error
              : "FAIL — Differences detected between IPv4 and IPv6"}
          </div>

          {/* Debug errors */}
          {r.debug && (r.debug.ipv4Error || r.debug.ipv6Error) && (
            <div class="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono text-gray-600 space-y-1">
              {r.debug.ipv4Error && (
                <div>
                  <span class="font-semibold">IPv4:</span>{" "}
                  {r.debug.ipv4Error}
                </div>
              )}
              {r.debug.ipv6Error && (
                <div>
                  <span class="font-semibold">IPv6:</span>{" "}
                  {r.debug.ipv6Error}
                </div>
              )}
            </div>
          )}

          {/* DNS Resolution */}
          <ResultCard
            title="DNS Resolution"
            status={r.ipv4Address && r.ipv6Address
              ? "pass"
              : r.ipv4Address || r.ipv6Address
              ? "warn"
              : "fail"}
          >
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="font-medium text-gray-700">IPv4 (A)</div>
                <div class="font-mono">
                  {r.ipv4Address || "No record"}
                </div>
                {r.connectedAddresses.ipv4 && (
                  <div class="text-xs text-green-600 mt-1">
                    ✓ Connected to {r.connectedAddresses.ipv4}
                  </div>
                )}
              </div>
              <div>
                <div class="font-medium text-gray-700">IPv6 (AAAA)</div>
                <div class="font-mono">
                  {r.ipv6Address || "No record"}
                </div>
                {r.connectedAddresses.ipv6 && (
                  <div class="text-xs text-green-600 mt-1">
                    ✓ Connected to {r.connectedAddresses.ipv6}
                  </div>
                )}
              </div>
            </div>
          </ResultCard>

          {/* Port Availability */}
          {r.ipv4Address && r.ipv6Address && (
            <ResultCard
              title="Port Availability"
              status={r.portCheck.http.equal && r.portCheck.https.equal
                ? "pass"
                : "fail"}
            >
              <div class="overflow-x-auto">
                <table class="w-full text-left">
                  <thead>
                    <tr class="border-b border-gray-200">
                      <th class="py-2 pr-4">Port</th>
                      <th class="py-2 pr-4">IPv4</th>
                      <th class="py-2 pr-4">IPv6</th>
                      <th class="py-2">Equal</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr class="border-b border-gray-100">
                      <td class="py-2 pr-4 font-mono">80 (HTTP)</td>
                      <td class="py-2 pr-4">
                        {r.portCheck.http.ipv4 ? "Open" : "Closed"}
                      </td>
                      <td class="py-2 pr-4">
                        {r.portCheck.http.ipv6 ? "Open" : "Closed"}
                      </td>
                      <td class="py-2">
                        <StatusIcon
                          status={r.portCheck.http.equal ? "pass" : "fail"}
                        />
                      </td>
                    </tr>
                    <tr>
                      <td class="py-2 pr-4 font-mono">443 (HTTPS)</td>
                      <td class="py-2 pr-4">
                        {r.portCheck.https.ipv4 ? "Open" : "Closed"}
                      </td>
                      <td class="py-2 pr-4">
                        {r.portCheck.https.ipv6 ? "Open" : "Closed"}
                      </td>
                      <td class="py-2">
                        <StatusIcon
                          status={r.portCheck.https.equal ? "pass" : "fail"}
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </ResultCard>
          )}

          {/* HTTP Headers */}
          {r.headerComparison.ipv4StatusCode !== null && (
            <ResultCard
              title="HTTP Headers"
              status={r.headerComparison.statusEqual &&
                  r.headerComparison.headerDiffs.length === 0
                ? "pass"
                : r.headerComparison.statusEqual
                ? "warn"
                : "fail"}
            >
              <div class="space-y-3">
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <span class="font-medium text-gray-700">
                      IPv4 Status:
                    </span>{" "}
                    <span class="font-mono">
                      {r.headerComparison.ipv4StatusCode}
                    </span>
                  </div>
                  <div>
                    <span class="font-medium text-gray-700">
                      IPv6 Status:
                    </span>{" "}
                    <span class="font-mono">
                      {r.headerComparison.ipv6StatusCode}
                    </span>
                  </div>
                </div>

                {r.headerComparison.headerDiffs.length > 0 && (
                  <div>
                    <button
                      onClick={() =>
                        expandedDiffs.value = !expandedDiffs.value}
                      class="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    >
                      {expandedDiffs.value ? "Hide" : "Show"}{" "}
                      {r.headerComparison.headerDiffs.length} header{" "}
                      {r.headerComparison.headerDiffs.length === 1
                        ? "difference"
                        : "differences"}
                    </button>
                    {expandedDiffs.value && (
                      <div class="mt-2 overflow-x-auto">
                        <table class="w-full text-left text-xs">
                          <thead>
                            <tr class="border-b border-gray-200">
                              <th class="py-1 pr-3">Header</th>
                              <th class="py-1 pr-3">IPv4</th>
                              <th class="py-1">IPv6</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.headerComparison.headerDiffs.map((diff) => (
                              <tr
                                key={diff.header}
                                class="border-b border-gray-100"
                              >
                                <td class="py-1 pr-3 font-mono font-medium">
                                  {diff.header}
                                </td>
                                <td class="py-1 pr-3 font-mono break-all">
                                  {diff.ipv4Value || "—"}
                                </td>
                                <td class="py-1 font-mono break-all">
                                  {diff.ipv6Value || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {r.headerComparison.headerDiffs.length === 0 && (
                  <p class="text-green-600">
                    All compared headers match.
                  </p>
                )}

                {/* Full headers toggle */}
                <div>
                  <button
                    onClick={() => showHeaders.value = !showHeaders.value}
                    class="text-blue-600 hover:text-blue-800 text-sm font-medium"
                  >
                    {showHeaders.value
                      ? "Hide full headers"
                      : "Show full headers"}
                  </button>
                  {showHeaders.value && (
                    <div class="mt-3 grid grid-cols-1 gap-4">
                      <HeaderTable
                        headers={r.headerComparison.ipv4Headers}
                        label={`IPv4 (${r.headerComparison.ipv4StatusCode})`}
                      />
                      <HeaderTable
                        headers={r.headerComparison.ipv6Headers}
                        label={`IPv6 (${r.headerComparison.ipv6StatusCode})`}
                      />
                    </div>
                  )}
                </div>
              </div>
            </ResultCard>
          )}

          {/* Content Similarity */}
          {r.contentComparison.similarityPercent !== null && (
            <ResultCard
              title="Content Similarity"
              status={r.contentComparison.pass ? "pass" : "fail"}
            >
              <div class="flex items-center gap-4">
                <div class="flex-1">
                  <div class="w-full bg-gray-200 rounded-full h-3">
                    <div
                      class={`h-3 rounded-full ${
                        r.contentComparison.pass
                          ? "bg-green-500"
                          : "bg-red-500"
                      }`}
                      style={{
                        width: `${r.contentComparison.similarityPercent}%`,
                      }}
                    />
                  </div>
                </div>
                <span class="font-mono font-semibold text-lg">
                  {r.contentComparison.similarityPercent}%
                </span>
              </div>
              <p class="mt-1 text-xs text-gray-500">
                Content compared after stripping nonces and VIEWSTATE tokens
                (internet.nl method). ≤10% distance = pass.
              </p>
            </ResultCard>
          )}

          {/* Followed Redirects */}
          {(r.followedRedirects.ipv4.length > 0 ||
            r.followedRedirects.ipv6.length > 0) && (
            <ResultCard
              title="Redirect Chain"
              status={JSON.stringify(r.followedRedirects.ipv4) ===
                  JSON.stringify(r.followedRedirects.ipv6)
                ? "pass"
                : "warn"}
            >
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <div class="font-medium text-gray-700 mb-1">IPv4</div>
                  {r.followedRedirects.ipv4.map((u, i) => (
                    <div key={i} class="font-mono text-xs truncate">
                      → {u}
                    </div>
                  ))}
                  {r.followedRedirects.ipv4.length === 0 && (
                    <div class="text-gray-400">No redirects</div>
                  )}
                </div>
                <div>
                  <div class="font-medium text-gray-700 mb-1">IPv6</div>
                  {r.followedRedirects.ipv6.map((u, i) => (
                    <div key={i} class="font-mono text-xs truncate">
                      → {u}
                    </div>
                  ))}
                  {r.followedRedirects.ipv6.length === 0 && (
                    <div class="text-gray-400">No redirects</div>
                  )}
                </div>
              </div>
            </ResultCard>
          )}
        </div>
      )}
    </div>
  );
}

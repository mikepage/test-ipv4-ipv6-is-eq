import { define } from "../../utils.ts";

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
  overallPass: boolean;
  error?: string;
  debug?: { ipv4Error?: string; ipv6Error?: string };
}

async function resolveDns(
  hostname: string,
  type: "A" | "AAAA",
): Promise<string | null> {
  try {
    const records = await Deno.resolveDns(hostname, type);
    return records.length > 0 ? records[0] : null;
  } catch {
    return null;
  }
}

async function checkPort(
  address: string,
  port: number,
): Promise<boolean> {
  try {
    const conn = await Deno.connect({
      hostname: address,
      port,
      transport: "tcp",
    });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

const SIMHASH_MAX_RESPONSE_SIZE = 500_000;
const SIMHASH_MAX_DISTANCE = 10;

function stripIrrelevantHtml(html: string): string {
  let result = html.replace(
    /<(script|style)([^>]*)\s+nonce=["'][^"']*["']([^>]*)>/gi,
    "<$1$2$3>",
  );
  result = result.replace(
    /<input[^>]*name=["']__VIEWSTATE["'][^>]*>/gi,
    "",
  );
  return result;
}

function sequenceMatcherQuickRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const freqA = new Map<string, number>();
  for (const ch of a) {
    freqA.set(ch, (freqA.get(ch) || 0) + 1);
  }
  const freqB = new Map<string, number>();
  for (const ch of b) {
    freqB.set(ch, (freqB.get(ch) || 0) + 1);
  }

  let matches = 0;
  for (const [ch, countB] of freqB) {
    matches += Math.min(freqA.get(ch) || 0, countB);
  }

  return (2.0 * matches) / (a.length + b.length);
}

function headersToEntries(headers: Headers): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  headers.forEach((value, name) => {
    entries.push({ name, value });
  });
  return entries;
}

interface FetchResult {
  status: number;
  headers: Headers;
  body: string;
  redirectChain: string[];
}

// Raw HTTP/1.1 over plain TCP — works on Deno Deploy (no startTls needed)
async function rawHttpGet(
  ip: string,
  hostname: string,
  path: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const conn = await Deno.connect({
    hostname: ip,
    port: 80,
    transport: "tcp",
  });

  const request = `GET ${path} HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    `User-Agent: Mozilla/5.0 (compatible; IPv6EqualityTest/1.0)\r\n` +
    `Accept: */*\r\n` +
    `Accept-Encoding: identity\r\n` +
    `Connection: close\r\n` +
    `\r\n`;

  const writer = conn.writable.getWriter();
  await writer.write(new TextEncoder().encode(request));
  await writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  const reader = conn.readable.getReader();
  while (totalLen < SIMHASH_MAX_RESPONSE_SIZE + 65536) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  reader.releaseLock();

  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const raw = new TextDecoder("utf-8", { fatal: false }).decode(combined);
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("No header boundary in response");

  const headerSection = raw.substring(0, headerEnd);
  const bodyRaw = raw.substring(headerEnd + 4);
  const headerLines = headerSection.split("\r\n");
  const statusMatch = headerLines[0].match(/^HTTP\/[\d.]+ (\d+)/);
  if (!statusMatch) throw new Error("Bad status line: " + headerLines[0]);

  const status = parseInt(statusMatch[1]);
  const headers = new Headers();
  for (let j = 1; j < headerLines.length; j++) {
    const colonIdx = headerLines[j].indexOf(":");
    if (colonIdx > 0) {
      headers.append(
        headerLines[j].substring(0, colonIdx).trim(),
        headerLines[j].substring(colonIdx + 1).trim(),
      );
    }
  }

  let body: string;
  if (headers.get("transfer-encoding")?.includes("chunked")) {
    body = "";
    let pos = 0;
    while (pos < bodyRaw.length) {
      const lineEnd = bodyRaw.indexOf("\r\n", pos);
      if (lineEnd === -1) break;
      const size = parseInt(bodyRaw.substring(pos, lineEnd).trim(), 16);
      if (isNaN(size) || size === 0) break;
      body += bodyRaw.substring(lineEnd + 2, lineEnd + 2 + size);
      pos = lineEnd + 2 + size + 2;
    }
  } else {
    body = bodyRaw;
  }

  return { status, headers, body };
}

async function fetchViaIP(
  ip: string,
  hostname: string,
  followRedirects: boolean,
): Promise<FetchResult | string> {
  const redirectChain: string[] = [];
  let currentHostname = hostname;
  let currentPath = "/";
  let currentIp = ip;
  const maxRedirects = followRedirects ? 10 : 0;

  for (let i = 0; i <= maxRedirects; i++) {
    try {
      const resp = await rawHttpGet(currentIp, currentHostname, currentPath);

      if (
        followRedirects && resp.status >= 300 && resp.status < 400 &&
        resp.headers.has("location")
      ) {
        const location = resp.headers.get("location")!;
        redirectChain.push(location);

        if (location.startsWith("http")) {
          const u = new URL(location);
          if (u.hostname !== currentHostname) {
            currentHostname = u.hostname;
            const newIp = await resolveDns(
              currentHostname,
              ip.includes(":") ? "AAAA" : "A",
            );
            if (!newIp) {
              return `DNS re-resolve failed for ${currentHostname}`;
            }
            currentIp = newIp;
          }
          currentPath = u.pathname + u.search || "/";
        } else {
          currentPath = location;
        }
        continue;
      }

      return {
        status: resp.status,
        headers: resp.headers,
        body: resp.body,
        redirectChain,
      };
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  return "Too many redirects";
}

const COMPARE_HEADERS = [
  "content-type",
  "server",
  "x-frame-options",
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "x-xss-protection",
  "cache-control",
];

export const handler = define.handlers({
  async GET(ctx) {
    const url = ctx.url.searchParams.get("url");
    const followRedirects =
      ctx.url.searchParams.get("followRedirects") === "true";

    if (!url) {
      return Response.json({ error: "url parameter required" }, {
        status: 400,
      });
    }

    let hostname: string;
    try {
      const parsed = new URL(
        url.startsWith("http") ? url : `https://${url}`,
      );
      hostname = parsed.hostname;
    } catch {
      return Response.json({ error: "Invalid URL" }, { status: 400 });
    }

    const [ipv4, ipv6] = await Promise.all([
      resolveDns(hostname, "A"),
      resolveDns(hostname, "AAAA"),
    ]);

    const result: TestResult = {
      url,
      hostname,
      ipv4Address: ipv4,
      ipv6Address: ipv6,
      portCheck: {
        http: { ipv4: false, ipv6: false, equal: false },
        https: { ipv4: false, ipv6: false, equal: false },
      },
      headerComparison: {
        ipv4StatusCode: null,
        ipv6StatusCode: null,
        statusEqual: false,
        headerDiffs: [],
        ipv4Headers: [],
        ipv6Headers: [],
      },
      contentComparison: {
        similarityPercent: null,
        pass: false,
      },
      followedRedirects: {
        ipv4: [],
        ipv6: [],
      },
      overallPass: false,
    };

    if (!ipv4 && !ipv6) {
      result.error = "Could not resolve any DNS records for this hostname";
      return Response.json(result);
    }

    if (!ipv6) {
      result.error = "No AAAA (IPv6) record found — IPv6 not available";
      return Response.json(result);
    }

    if (!ipv4) {
      result.error = "No A (IPv4) record found — IPv4 not available";
      return Response.json(result);
    }

    // Port checks
    const [http4, http6, https4, https6] = await Promise.all([
      checkPort(ipv4, 80),
      checkPort(ipv6, 80),
      checkPort(ipv4, 443),
      checkPort(ipv6, 443),
    ]);

    result.portCheck = {
      http: { ipv4: http4, ipv6: http6, equal: http4 === http6 },
      https: { ipv4: https4, ipv6: https6, equal: https4 === https6 },
    };

    // Fetch content over HTTP (port 80) via raw TCP to specific IPs
    // This avoids Deno Deploy's startTls limitation
    const [r4, r6] = await Promise.all([
      fetchViaIP(ipv4, hostname, followRedirects),
      fetchViaIP(ipv6, hostname, followRedirects),
    ]);

    const resp4 = typeof r4 === "string" ? null : r4;
    const resp6 = typeof r6 === "string" ? null : r6;
    const err4 = typeof r4 === "string" ? r4 : null;
    const err6 = typeof r6 === "string" ? r6 : null;

    if (resp4 && resp6) {
      result.headerComparison.ipv4StatusCode = resp4.status;
      result.headerComparison.ipv6StatusCode = resp6.status;
      result.headerComparison.statusEqual = resp4.status === resp6.status;
      result.headerComparison.ipv4Headers = headersToEntries(resp4.headers);
      result.headerComparison.ipv6Headers = headersToEntries(resp6.headers);

      const headerDiffs: HeaderDiff[] = [];
      for (const header of COMPARE_HEADERS) {
        const v4 = resp4.headers.get(header);
        const v6 = resp6.headers.get(header);
        if (v4 !== v6) {
          headerDiffs.push({ header, ipv4Value: v4, ipv6Value: v6 });
        }
      }
      result.headerComparison.headerDiffs = headerDiffs;

      const html4 = stripIrrelevantHtml(
        resp4.body.substring(0, SIMHASH_MAX_RESPONSE_SIZE),
      );
      const html6 = stripIrrelevantHtml(
        resp6.body.substring(0, SIMHASH_MAX_RESPONSE_SIZE),
      );

      const ratio = sequenceMatcherQuickRatio(html4, html6);
      const distance = 100 - ratio * 100;
      const similarityPercent = Math.round(ratio * 1000) / 10;
      result.contentComparison.similarityPercent = similarityPercent;
      result.contentComparison.pass = distance <= SIMHASH_MAX_DISTANCE;

      result.followedRedirects = {
        ipv4: resp4.redirectChain,
        ipv6: resp6.redirectChain,
      };

      result.overallPass = result.portCheck.http.equal &&
        result.portCheck.https.equal &&
        result.headerComparison.statusEqual &&
        result.contentComparison.pass;
    } else {
      const parts = [];
      parts.push(`IPv4 ${resp4 ? "OK" : "failed"}`);
      parts.push(`IPv6 ${resp6 ? "OK" : "failed"}`);
      result.error = `Could not fetch content: ${parts.join(", ")}`;
      result.debug = {};
      if (err4) result.debug.ipv4Error = err4;
      if (err6) result.debug.ipv6Error = err6;
    }

    return Response.json(result);
  },
});

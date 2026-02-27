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
  _isIPv6: boolean,
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

function stripNonces(html: string): string {
  return html
    .replace(/nonce="[^"]*"/g, 'nonce=""')
    .replace(/nonce='[^']*'/g, "nonce=''")
    .replace(/\b[0-9a-f]{8,}\b/g, "HASH")
    .replace(/\d{10,}/g, "TIMESTAMP");
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) return 100;
  if (a.length === 0 && b.length === 0) return 100;
  if (a.length === 0 || b.length === 0) return 0;

  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLen = Math.max(aLines.length, bLines.length);
  if (maxLen === 0) return 100;

  let matching = 0;
  const minLen = Math.min(aLines.length, bLines.length);
  for (let i = 0; i < minLen; i++) {
    if (aLines[i] === bLines[i]) matching++;
  }

  return Math.round((matching / maxLen) * 1000) / 10;
}

interface ParsedResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

async function httpRequestOverConnection(
  conn: Deno.Conn,
  hostname: string,
  path: string,
): Promise<ParsedResponse> {
  const request = `GET ${path} HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    `User-Agent: Mozilla/5.0 (compatible; IPv6EqualityTest/1.0)\r\n` +
    `Accept: */*\r\n` +
    `Connection: close\r\n` +
    `\r\n`;

  const writer = conn.writable.getWriter();
  await writer.write(new TextEncoder().encode(request));
  await writer.close();

  const chunks: Uint8Array[] = [];
  const reader = conn.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const raw = new TextDecoder().decode(combined);
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("Invalid HTTP response");

  const headerSection = raw.substring(0, headerEnd);
  const bodyRaw = raw.substring(headerEnd + 4);

  const headerLines = headerSection.split("\r\n");
  const statusLine = headerLines[0];
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)\s*(.*)/);
  if (!statusMatch) throw new Error("Invalid status line: " + statusLine);

  const status = parseInt(statusMatch[1]);
  const statusText = statusMatch[2];
  const headers = new Headers();
  for (let i = 1; i < headerLines.length; i++) {
    const colonIdx = headerLines[i].indexOf(":");
    if (colonIdx > 0) {
      headers.append(
        headerLines[i].substring(0, colonIdx).trim(),
        headerLines[i].substring(colonIdx + 1).trim(),
      );
    }
  }

  // Handle chunked transfer encoding
  let body: string;
  if (headers.get("transfer-encoding")?.includes("chunked")) {
    body = decodeChunked(bodyRaw);
  } else {
    body = bodyRaw;
  }

  return { status, statusText, headers, body };
}

function decodeChunked(raw: string): string {
  let result = "";
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const sizeStr = raw.substring(pos, lineEnd).trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    result += raw.substring(chunkStart, chunkStart + size);
    pos = chunkStart + size + 2; // skip chunk data + trailing \r\n
  }
  return result;
}

async function connectToIP(
  ip: string,
  port: number,
  hostname: string,
  useTls: boolean,
): Promise<Deno.Conn> {
  const tcpConn = await Deno.connect({ hostname: ip, port, transport: "tcp" });
  if (!useTls) return tcpConn;
  return await Deno.startTls(tcpConn, { hostname });
}

async function fetchViaIP(
  ip: string,
  hostname: string,
  protocol: string,
  _isIPv6: boolean,
  followRedirects: boolean,
): Promise<{
  status: number;
  headers: Headers;
  body: string;
  redirectChain: string[];
} | null> {
  const redirectChain: string[] = [];
  let currentHostname = hostname;
  let currentPath = "/";
  let currentProtocol = protocol;
  let currentIp = ip;
  const maxRedirects = followRedirects ? 10 : 0;

  for (let i = 0; i <= maxRedirects; i++) {
    try {
      const useTls = currentProtocol === "https";
      const port = useTls ? 443 : 80;
      const conn = await connectToIP(currentIp, port, currentHostname, useTls);
      const resp = await httpRequestOverConnection(
        conn,
        currentHostname,
        currentPath,
      );

      if (
        followRedirects && resp.status >= 300 && resp.status < 400 &&
        resp.headers.has("location")
      ) {
        const location = resp.headers.get("location")!;
        redirectChain.push(location);

        if (location.startsWith("http")) {
          const redirectUrl = new URL(location);
          // If redirect goes to a different host, re-resolve DNS for the new host
          if (redirectUrl.hostname !== currentHostname) {
            currentHostname = redirectUrl.hostname;
            const newIp = await resolveDns(
              currentHostname,
              ip.includes(":") ? "AAAA" : "A",
            );
            if (!newIp) return null;
            currentIp = newIp;
          }
          currentProtocol = redirectUrl.protocol.replace(":", "");
          currentPath = redirectUrl.pathname + redirectUrl.search;
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
    } catch {
      return null;
    }
  }

  return null;
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
      return new Response(JSON.stringify({ error: "url parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let hostname: string;
    let protocol: string;
    try {
      const parsed = new URL(
        url.startsWith("http") ? url : `https://${url}`,
      );
      hostname = parsed.hostname;
      protocol = parsed.protocol.replace(":", "");
    } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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
      checkPort(ipv4, 80, false),
      checkPort(ipv6, 80, true),
      checkPort(ipv4, 443, false),
      checkPort(ipv6, 443, true),
    ]);

    result.portCheck = {
      http: { ipv4: http4, ipv6: http6, equal: http4 === http6 },
      https: { ipv4: https4, ipv6: https6, equal: https4 === https6 },
    };

    // Fetch content via both protocols
    const fetchProto = protocol === "http" ? "http" : "https";
    const [resp4, resp6] = await Promise.all([
      fetchViaIP(ipv4, hostname, fetchProto, false, followRedirects),
      fetchViaIP(ipv6, hostname, fetchProto, true, followRedirects),
    ]);

    if (resp4 && resp6) {
      result.headerComparison.ipv4StatusCode = resp4.status;
      result.headerComparison.ipv6StatusCode = resp6.status;
      result.headerComparison.statusEqual = resp4.status === resp6.status;

      const headerDiffs: HeaderDiff[] = [];
      for (const header of COMPARE_HEADERS) {
        const v4 = resp4.headers.get(header);
        const v6 = resp6.headers.get(header);
        if (v4 !== v6) {
          headerDiffs.push({ header, ipv4Value: v4, ipv6Value: v6 });
        }
      }
      result.headerComparison.headerDiffs = headerDiffs;

      const stripped4 = stripNonces(resp4.body);
      const stripped6 = stripNonces(resp6.body);
      const similarity = computeSimilarity(stripped4, stripped6);
      result.contentComparison.similarityPercent = similarity;
      result.contentComparison.pass = similarity >= 90;

      result.followedRedirects = {
        ipv4: resp4.redirectChain,
        ipv6: resp6.redirectChain,
      };

      result.overallPass = result.portCheck.http.equal &&
        result.portCheck.https.equal &&
        result.headerComparison.statusEqual &&
        headerDiffs.length === 0 &&
        result.contentComparison.pass;
    } else {
      result.error =
        `Could not fetch content: IPv4 ${resp4 ? "OK" : "failed"}, IPv6 ${resp6 ? "OK" : "failed"}`;
    }

    return Response.json(result);
  },
});

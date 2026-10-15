/**
 * Serve master recording MP4 with HTTP byte-range support (evidence seek).
 * Does not remux or alter the file — read-only from storage/recordings.
 */
import { stat } from "node:fs/promises";
import { open } from "node:fs/promises";

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const spec = header.slice("bytes=".length).split(",")[0]?.trim();
  if (!spec) return null;
  const [a, b] = spec.split("-");
  let start = a === "" || a == null ? NaN : Number(a);
  let end = b === "" || b == null ? NaN : Number(b);
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    // suffix: bytes=-N
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (!Number.isNaN(start) && Number.isNaN(end)) {
    end = size - 1;
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end >= size ||
    start > end
  ) {
    return null;
  }
  return { start, end };
}

export async function streamFileWithRanges(
  absPath: string,
  req: Request,
  contentType = "video/mp4",
): Promise<Response> {
  const st = await stat(absPath);
  if (!st.isFile()) {
    return new Response("Not found", { status: 404 });
  }
  const size = st.size;
  const range = parseRange(req.headers.get("range") ?? undefined, size);
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  if (!range) {
    const file = Bun.file(absPath);
    return new Response(file, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(size),
      },
    });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  const fh = await open(absPath, "r");
  try {
    const buf = Buffer.alloc(chunkSize);
    await fh.read(buf, 0, chunkSize, start);
    return new Response(buf, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  } finally {
    await fh.close();
  }
}

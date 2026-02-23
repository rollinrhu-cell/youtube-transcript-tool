import Anthropic, {
  APIError,
  RateLimitError,
  AuthenticationError,
  APIConnectionError,
  InternalServerError,
} from "@anthropic-ai/sdk";
import { Supadata, SupadataError } from "@supadata/js";

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Transcript extraction strategy
//
// Primary:  Supadata API  (set SUPADATA_API_KEY in env)
//           - Runs behind a managed proxy pool; not affected by cloud IP blocks
//           - Free tier, no card required: https://supadata.ai
//           - mode:'native' = only existing YouTube captions, no AI generation
//
// Fallback: Direct YouTube ANDROID innertube client
//           - Used when SUPADATA_API_KEY is absent or Supadata has a temp error
//           - Still blocked by YouTube on some Vercel IPs, but worth trying
// ---------------------------------------------------------------------------

interface TranscriptItem {
  text: string;
  duration: number;
  offset: number;
}

interface VideoMeta {
  title: string;
  durationSeconds: number;
}

// ── Supadata ────────────────────────────────────────────────────────────────

async function fetchViaSupadata(
  videoId: string,
  apiKey: string
): Promise<TranscriptItem[]> {
  const supadata = new Supadata({ apiKey });

  let result = await supadata.transcript({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    lang: "en",
    mode: "native", // only existing captions; never AI-generate
  });

  // Large videos are processed async and return a jobId instead of content.
  // Poll until complete (max ~90 s).
  if ("jobId" in result) {
    const { jobId } = result as { jobId: string };
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await supadata.transcript.getJobStatus(jobId);
      if (status.status === "completed" && status.result) {
        result = status.result;
        break;
      }
      if (status.status === "failed") {
        throw new TranscriptsNotAvailableError(videoId);
      }
    }
    // Still a jobId after polling — give up
    if ("jobId" in result) throw new TranscriptsNotAvailableError(videoId);
  }

  const { content } = result as { content: unknown };

  if (typeof content === "string") {
    const text = content.trim();
    if (!text) throw new TranscriptsNotAvailableError(videoId);
    return [{ text, offset: 0, duration: 0 }];
  }

  if (Array.isArray(content)) {
    const items = (
      content as Array<{ text: string; offset: number; duration: number }>
    )
      .map((c) => ({ text: c.text, offset: c.offset / 1000, duration: c.duration / 1000 }))
      .filter((c) => c.text.trim().length > 0);
    if (items.length === 0) throw new TranscriptsNotAvailableError(videoId);
    return items;
  }

  throw new TranscriptsNotAvailableError(videoId);
}

// ── Direct YouTube ANDROID client (fallback) ────────────────────────────────

// Well-known fallback key — extracted dynamically from the page at runtime
const FALLBACK_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string; // "asr" = auto-generated
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

async function fetchViaAndroid(videoId: string): Promise<{ items: TranscriptItem[]; meta?: VideoMeta }> {
  // Step 1: watch page → extract INNERTUBE_API_KEY + consent cookie
  const watchRes = await fetch(
    `https://www.youtube.com/watch?v=${videoId}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    }
  );
  if (!watchRes.ok) throw new VideoUnavailableError(videoId);

  const html = await watchRes.text();
  if (html.includes('class="g-recaptcha"')) throw new IpBlockedError();

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
  const ytApiKey = apiKeyMatch ? apiKeyMatch[1] : FALLBACK_INNERTUBE_KEY;

  let cookieHeader: Record<string, string> = {};
  if (html.includes('action="https://consent.youtube.com/s"')) {
    const m = html.match(/name="v" value="(.*?)"/);
    if (m) cookieHeader = { Cookie: `CONSENT=YES+${m[1]}` };
  }

  // Step 2: innertube player API — ANDROID client is less bot-scrutinised
  const playerRes = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${ytApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "com.google.android.youtube/20.10.38 (Linux; U; Android 12) gzip",
        "Accept-Language": "en-US,en;q=0.9",
        ...cookieHeader,
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
      }),
    }
  );
  if (!playerRes.ok) throw new VideoUnavailableError(videoId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await playerRes.json();
  const status: string | undefined = data?.playabilityStatus?.status;
  const reason: string = data?.playabilityStatus?.reason ?? "";

  if (status && status !== "OK") {
    if (reason.toLowerCase().includes("bot")) throw new IpBlockedError();
    throw new VideoUnavailableError(videoId);
  }

  // Extract metadata from the player response we already have
  const rawTitle: string = data?.videoDetails?.title ?? "";
  const meta: VideoMeta | undefined = rawTitle
    ? { title: rawTitle, durationSeconds: parseInt(data?.videoDetails?.lengthSeconds ?? "0", 10) }
    : undefined;

  const captionTracks: CaptionTrack[] | undefined =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0)
    throw new TranscriptsDisabledError(videoId);

  // Skip tracks requiring PO Token (&exp=xpe) — server-side can't satisfy them
  const usable = captionTracks.filter((t) => !t.baseUrl?.includes("&exp=xpe"));
  if (usable.length === 0) throw new PoTokenRequiredError(videoId);

  const track =
    usable.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
    usable.find((t) => t.languageCode === "en") ??
    usable.find((t) => t.kind !== "asr") ??
    usable[0];

  // Step 3: fetch and parse transcript XML
  const transcriptUrl = track.baseUrl.replace("&fmt=srv3", "");
  const xmlRes = await fetch(transcriptUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
  });
  if (!xmlRes.ok) throw new TranscriptsNotAvailableError(videoId);

  const xml = await xmlRes.text();
  const RE = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  const items = [...xml.matchAll(RE)]
    .map((m) => ({
      text: decodeHtmlEntities(m[3]),
      duration: parseFloat(m[2]),
      offset: parseFloat(m[1]),
    }))
    .filter((item) => item.text.trim().length > 0);

  if (items.length === 0) throw new TranscriptsNotAvailableError(videoId);
  return { items, meta };
}

// ── Video metadata (title + duration) ────────────────────────────────────────
// Runs concurrently with fetchTranscript. Returns null on any error so a
// metadata failure never blocks the transcript.

async function fetchVideoMeta(videoId: string): Promise<VideoMeta | null> {
  // Primary: innertube ANDROID client (returns title + duration)
  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${FALLBACK_INNERTUBE_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "com.google.android.youtube/20.10.38 (Linux; U; Android 12) gzip",
          "Accept-Language": "en-US,en;q=0.9",
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: { clientName: "ANDROID", clientVersion: "20.10.38" },
          },
        }),
      }
    );
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const title: string = data?.videoDetails?.title ?? "";
      if (title) {
        const durationSeconds = parseInt(data?.videoDetails?.lengthSeconds ?? "0", 10);
        return { title, durationSeconds };
      }
    }
  } catch {
    // fall through to oEmbed
  }

  // Fallback: oEmbed — a simple public endpoint, never blocked by cloud IPs.
  // Returns title only (no duration), but good enough to populate the heading.
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const title: string = data?.title ?? "";
      if (title) return { title, durationSeconds: 0 };
    }
  } catch {
    // give up
  }

  return null;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function fetchTranscript(videoId: string): Promise<{ items: TranscriptItem[]; meta?: VideoMeta }> {
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (supadataKey) {
    try {
      const items = await fetchViaSupadata(videoId, supadataKey);
      return { items };
    } catch (err) {
      if (err instanceof SupadataError) {
        // Definitive errors — no point falling through to direct approach
        if (err.error === "transcript-unavailable")
          throw new TranscriptsDisabledError(videoId);
        if (err.error === "not-found")
          throw new VideoUnavailableError(videoId);
        // upgrade-required / limit-exceeded / auth errors → fall through
      } else if (
        // Re-throw our own error types from polling — they're already final
        err instanceof TranscriptsDisabledError ||
        err instanceof VideoUnavailableError
      ) {
        throw err;
      }
      // For auth, quota, or transient errors, fall through to direct approach
      console.error("[transcript] Supadata failed, trying direct:", err);
    }
  }

  return await fetchViaAndroid(videoId);
}

// ── Error types ───────────────────────────────────────────────────────────────

class VideoUnavailableError extends Error {
  constructor(videoId: string) {
    super(`Video unavailable: ${videoId}`);
  }
}
class TranscriptsDisabledError extends Error {
  constructor(videoId: string) {
    super(`Transcripts disabled: ${videoId}`);
  }
}
class TranscriptsNotAvailableError extends Error {
  constructor(videoId: string) {
    super(`No transcripts available: ${videoId}`);
  }
}
class IpBlockedError extends Error {
  constructor() {
    super("IP blocked by YouTube");
  }
}
class PoTokenRequiredError extends Error {
  constructor(videoId: string) {
    super(`PO Token required: ${videoId}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

function chunkWords(text: string, wordsPerChunk: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
  }
  return chunks;
}

function sendEvent(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  data: Record<string, unknown>
) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

// Format an offset in seconds as a human-readable timecode marker.
// Under 1 hour:  [M:SS]     e.g. [0:00], [2:15], [12:34]
// 1 hour+:       [H:MM:SS]  e.g. [1:00:00], [1:30:45], [2:15:30]
function formatTimecodeMarker(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `[${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
  }
  return `[${m}:${String(sec).padStart(2, "0")}]`;
}

// Returns raw text with timecode markers embedded at each minute boundary.
// If items lack real timing data (e.g. Supadata returned a plain-text string with
// all offsets at 0), skips markers and returns hasTimecodes: false.
function buildRawText(items: TranscriptItem[]): {
  text: string;
  hasTimecodes: boolean;
} {
  const hasTimingData = items.length > 1 && items.some((i) => i.offset > 0);

  if (!hasTimingData) {
    return {
      text: items.map((i) => i.text.replace(/\n/g, " ")).join(" "),
      hasTimecodes: false,
    };
  }

  // Insert a timecode at the very start, then every ~60 s of real content.
  // Using the item's exact offset so the marker shows true M:SS / H:MM:SS time.
  let lastMarkerAt = -61;
  const parts: string[] = [];

  for (const item of items) {
    if (item.offset - lastMarkerAt >= 60) {
      parts.push(formatTimecodeMarker(item.offset));
      lastMarkerAt = item.offset;
    }
    const text = item.text.replace(/\n/g, " ").trim();
    if (text) parts.push(text);
  }

  return { text: parts.join(" "), hasTimecodes: true };
}

async function cleanChunk(
  client: Anthropic,
  chunk: string,
  isFirst: boolean,
  isLast: boolean,
  hasTimecodes: boolean
): Promise<string> {
  const contextNote =
    !isFirst && !isLast
      ? "This is a middle section of a longer transcript. "
      : isFirst
        ? "This is the beginning of a transcript. "
        : "This is the final section of a transcript. ";

  const timecodeInstruction = hasTimecodes
    ? `5. Preserve every timecode marker exactly as-is — e.g. [0:00], [2:15], [12:34], [1:00:00], [1:30:45]. Timecodes are in [M:SS] format (under 1 hour) or [H:MM:SS] format (1 hour or more). Do not remove, reformat, or recalculate them; keep each one exactly where it appears.
6.`
    : "5.";

  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${contextNote}Clean up the following YouTube video transcript excerpt. Your task:
1. Fix punctuation and capitalization so it reads like natural prose
2. Remove filler words: um, uh, like (when used as filler), you know, basically, literally, right (when used as filler), so (when used as sentence starter filler), okay (when used as filler)
3. Break the text into logical paragraphs based on topic shifts or natural pauses
4. Preserve all the original meaning and content — do not summarize, skip information, or add anything new
${timecodeInstruction} Attempt to identify distinct speakers. When you detect a speaker change, start that speaker's paragraph with "Speaker 1:", "Speaker 2:", etc. Only do this if you can confidently detect two or more distinct voices from the conversational back-and-forth, topic changes, or named references. If the transcript has a single speaker or speakers cannot be distinguished, omit all speaker labels.
${hasTimecodes ? "7." : "6."} Return ONLY the cleaned transcript text, with no explanations, preamble, or commentary

Transcript to clean:
${chunk}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") return chunk;
  return content.text.trim();
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let url: string;
  try {
    const body = await request.json();
    url = body.url;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!url) {
    return Response.json({ error: "URL is required" }, { status: 400 });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return Response.json(
      {
        error:
          "Invalid YouTube URL. Please use a URL like https://www.youtube.com/watch?v=... or https://youtu.be/...",
      },
      { status: 400 }
    );
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return Response.json(
      { error: "Server configuration error: missing API key" },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        sendEvent(controller, encoder, {
          type: "status",
          message: "Fetching transcript...",
        });

        // Run meta fetch concurrently — a failure there never blocks the transcript
        const [transcriptResult, metaResult] = await Promise.allSettled([
          fetchTranscript(videoId),
          fetchVideoMeta(videoId),
        ]);

        // Use fetchVideoMeta result when available; fall back to meta embedded in
        // the transcript result (Android path already fetched player data).
        const meta =
          (metaResult.status === "fulfilled" && metaResult.value)
            ? metaResult.value
            : (transcriptResult.status === "fulfilled" ? transcriptResult.value.meta : undefined);

        if (meta) {
          sendEvent(controller, encoder, { type: "meta", ...meta });
        }

        let transcriptItems: TranscriptItem[];
        if (transcriptResult.status === "rejected") {
          const err = transcriptResult.reason;
          let userMessage: string;
          if (err instanceof IpBlockedError) {
            userMessage =
              "YouTube is blocking this server's requests. This is a known issue with cloud-hosted services — set SUPADATA_API_KEY to route around it.";
          } else if (err instanceof PoTokenRequiredError) {
            userMessage =
              "YouTube requires a verification token for this video's transcript. Set SUPADATA_API_KEY to work around this.";
          } else if (err instanceof VideoUnavailableError) {
            userMessage =
              "This video is unavailable (it may be private, deleted, or region-locked).";
          } else if (err instanceof TranscriptsDisabledError) {
            userMessage =
              "Transcripts are disabled for this video. The creator has turned off captions.";
          } else if (err instanceof TranscriptsNotAvailableError) {
            userMessage =
              "No transcript is available for this video. It may not have auto-generated captions yet.";
          } else {
            const msg = err instanceof Error ? err.message : "Unknown error";
            userMessage = `Could not fetch transcript: ${msg}`;
          }
          sendEvent(controller, encoder, { type: "error", message: userMessage });
          controller.close();
          return;
        }
        transcriptItems = transcriptResult.value.items;

        if (!transcriptItems || transcriptItems.length === 0) {
          sendEvent(controller, encoder, {
            type: "error",
            message: "This video does not have a transcript available.",
          });
          controller.close();
          return;
        }

        const { text: rawText, hasTimecodes } = buildRawText(transcriptItems);

        const WORDS_PER_CHUNK = 3000;
        const chunks = chunkWords(rawText, WORDS_PER_CHUNK);
        const totalChunks = chunks.length;

        sendEvent(controller, encoder, {
          type: "info",
          totalChunks,
          wordCount: rawText.split(/\s+/).length,
          hasTimecodes,
        });

        const client = new Anthropic({ apiKey: anthropicKey });

        for (let i = 0; i < chunks.length; i++) {
          sendEvent(controller, encoder, {
            type: "progress",
            current: i + 1,
            total: totalChunks,
          });

          const cleaned = await cleanChunk(
            client,
            chunks[i],
            i === 0,
            i === chunks.length - 1,
            hasTimecodes
          );

          sendEvent(controller, encoder, {
            type: "chunk",
            index: i,
            text: cleaned,
          });
        }

        sendEvent(controller, encoder, { type: "done" });
        controller.close();
      } catch (err) {
        let userMessage: string;
        if (err instanceof RateLimitError) {
          userMessage =
            "The AI service is temporarily busy due to high demand. Please wait a moment and try again.";
        } else if (err instanceof AuthenticationError) {
          userMessage =
            "Server configuration error: the AI API key is invalid. Please contact the site owner.";
        } else if (err instanceof InternalServerError) {
          userMessage =
            "The AI service encountered an internal error. Please try again in a moment.";
        } else if (err instanceof APIError && (err as APIError).status === 402) {
          userMessage =
            "The AI service is temporarily unavailable (credit limit reached). Please try again later.";
        } else if (err instanceof APIConnectionError) {
          // Also catches APIConnectionTimeoutError (a subclass)
          userMessage =
            "Lost connection to the AI service. Please check your network and try again.";
        } else {
          userMessage = err instanceof Error ? err.message : "Unknown server error";
        }
        sendEvent(controller, encoder, { type: "error", message: userMessage });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// YouTube innertube API – much more reliable than page-scraping
// ---------------------------------------------------------------------------

interface TranscriptItem {
  text: string;
  duration: number;
  offset: number;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
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

async function fetchYouTubeTranscript(
  videoId: string
): Promise<TranscriptItem[]> {
  // Step 1: Ask the innertube player API for video metadata (includes caption tracks)
  const playerRes = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Modern Chrome UA – YouTube serves different responses to old UAs
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.youtube.com",
      Referer: `https://www.youtube.com/watch?v=${videoId}`,
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20240110.09.00",
          hl: "en",
          gl: "US",
        },
      },
    }),
  });

  if (!playerRes.ok) {
    throw new VideoUnavailableError(videoId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await playerRes.json();

  const status = data?.playabilityStatus?.status as string | undefined;
  if (status && status !== "OK") {
    if (status === "UNPLAYABLE") throw new TranscriptsDisabledError(videoId);
    throw new VideoUnavailableError(videoId);
  }

  const captionTracks: CaptionTrack[] | undefined =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new TranscriptsDisabledError(videoId);
  }

  // Prefer English; otherwise use the first available track
  const track =
    captionTracks.find((t) => t.languageCode === "en") ?? captionTracks[0];

  if (!track?.baseUrl) {
    throw new TranscriptsDisabledError(videoId);
  }

  // Step 2: Fetch the caption XML
  const captionRes = await fetch(track.baseUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
  });

  if (!captionRes.ok) {
    throw new TranscriptsNotAvailableError(videoId);
  }

  const xml = await captionRes.text();
  const RE = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  const items = [...xml.matchAll(RE)].map((m) => ({
    text: decodeHtmlEntities(m[3]),
    duration: parseFloat(m[2]),
    offset: parseFloat(m[1]),
  }));

  if (items.length === 0) {
    throw new TranscriptsNotAvailableError(videoId);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Custom error classes (mirrors what was exported from youtube-transcript)
// ---------------------------------------------------------------------------

class VideoUnavailableError extends Error {
  constructor(videoId: string) {
    super(`The video is no longer available (${videoId})`);
  }
}
class TranscriptsDisabledError extends Error {
  constructor(videoId: string) {
    super(`Transcript is disabled on this video (${videoId})`);
  }
}
class TranscriptsNotAvailableError extends Error {
  constructor(videoId: string) {
    super(`No transcripts are available for this video (${videoId})`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const match = u.pathname.match(/\/embed\/([^/?]+)/);
      if (match) return match[1];
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

async function cleanChunk(
  client: Anthropic,
  chunk: string,
  isFirst: boolean,
  isLast: boolean
): Promise<string> {
  const contextNote =
    !isFirst && !isLast
      ? "This is a middle section of a longer transcript. "
      : isFirst
      ? "This is the beginning of a transcript. "
      : "This is the final section of a transcript. ";

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
5. Return ONLY the cleaned transcript text, with no explanations, labels, or commentary

Transcript to clean:
${chunk}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") return chunk;
  return content.text.trim();
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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

        let transcriptItems: TranscriptItem[];
        try {
          transcriptItems = await fetchYouTubeTranscript(videoId);
        } catch (err) {
          let userMessage: string;
          if (err instanceof VideoUnavailableError) {
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

        if (!transcriptItems || transcriptItems.length === 0) {
          sendEvent(controller, encoder, {
            type: "error",
            message: "This video does not have a transcript available.",
          });
          controller.close();
          return;
        }

        const rawText = transcriptItems
          .map((item) => item.text.replace(/\n/g, " "))
          .join(" ");

        const WORDS_PER_CHUNK = 3000;
        const chunks = chunkWords(rawText, WORDS_PER_CHUNK);
        const totalChunks = chunks.length;

        sendEvent(controller, encoder, {
          type: "info",
          totalChunks,
          wordCount: rawText.split(/\s+/).length,
        });

        const client = new Anthropic({ apiKey });

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
            i === chunks.length - 1
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
        const msg = err instanceof Error ? err.message : "Unknown server error";
        sendEvent(controller, encoder, { type: "error", message: msg });
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

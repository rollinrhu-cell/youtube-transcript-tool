import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptTooManyRequestError,
} from "youtube-transcript";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

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

        let transcriptItems;
        try {
          transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
        } catch (err) {
          let userMessage: string;
          if (err instanceof YoutubeTranscriptDisabledError) {
            userMessage =
              "Transcripts are disabled for this video. The creator has turned off captions.";
          } else if (err instanceof YoutubeTranscriptNotAvailableError) {
            userMessage =
              "No transcript is available for this video. It may not have auto-generated captions yet.";
          } else if (err instanceof YoutubeTranscriptVideoUnavailableError) {
            userMessage =
              "This video is unavailable (it may be private, deleted, or region-locked).";
          } else if (err instanceof YoutubeTranscriptTooManyRequestError) {
            userMessage =
              "Too many requests to YouTube. Please wait a moment and try again.";
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
            message:
              "This video does not have a transcript available.",
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

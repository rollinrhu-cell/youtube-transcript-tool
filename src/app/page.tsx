"use client";

import { useState, useRef, useCallback } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "processing"; current: number; total: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export default function TranscriptPage() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [transcript, setTranscript] = useState("");
  const [hasTimecodes, setHasTimecodes] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.trim()) return;

      // Cancel any in-progress request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setTranscript("");
      setHasTimecodes(false);
      setStatus({ kind: "loading", message: "Fetching transcript..." });

      try {
        const response = await fetch("/api/transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          setStatus({
            kind: "error",
            message: err.error || `Server error (${response.status})`,
          });
          return;
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const collectedChunks: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }

            switch (event.type) {
              case "status":
                setStatus({
                  kind: "loading",
                  message: event.message as string,
                });
                break;

              case "info":
                setHasTimecodes(!!(event.hasTimecodes as boolean));
                setStatus({
                  kind: "processing",
                  current: 0,
                  total: event.totalChunks as number,
                });
                break;

              case "progress":
                setStatus({
                  kind: "processing",
                  current: event.current as number,
                  total: event.total as number,
                });
                break;

              case "chunk":
                collectedChunks[event.index as number] = event.text as string;
                setTranscript(collectedChunks.filter(Boolean).join("\n\n"));
                break;

              case "done":
                setStatus({ kind: "done" });
                break;

              case "error":
                setStatus({
                  kind: "error",
                  message: event.message as string,
                });
                break;
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setStatus({
          kind: "error",
          message: "Network error. Please check your connection and try again.",
        });
      }
    },
    [url]
  );

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [transcript]);

  const isRunning =
    status.kind === "loading" || status.kind === "processing";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6 text-white"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                YouTube Transcript Extractor
              </h1>
              <p className="text-sm text-gray-500">
                Paste a YouTube URL to get a clean, readable transcript
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Info notes */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
            <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Good to know</span>
          </div>
          <ul className="divide-y divide-gray-100">
            <li className="px-5 py-3.5 flex gap-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide w-24 flex-shrink-0 pt-px">Accuracy</span>
              <p className="text-sm text-gray-600 leading-relaxed">Transcripts are cleaned up by AI and should not be treated as verbatim quotes. If quoting for publication, refer back to the original video.</p>
            </li>
            <li className="px-5 py-3.5 flex gap-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide w-24 flex-shrink-0 pt-px">Check first</span>
              <p className="text-sm text-gray-600 leading-relaxed">To confirm a video has a transcript before submitting, open it on YouTube, click the three dots <span className="font-medium text-gray-700">⋯</span> below the player, and select <span className="font-medium text-gray-700">Open transcript</span>. If that option doesn&apos;t appear, the transcript won&apos;t be available here.</p>
            </li>
            <li className="px-5 py-3.5 flex gap-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide w-24 flex-shrink-0 pt-px">Usage</span>
              <p className="text-sm text-gray-600 leading-relaxed">This tool has a monthly limit of about 100 transcripts, so please be mindful of usage.</p>
            </li>
          </ul>
        </div>

        {/* URL form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <label
            htmlFor="yt-url"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            YouTube URL
          </label>
          <div className="flex gap-3">
            <input
              id="yt-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              disabled={isRunning}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={isRunning || !url.trim()}
              className="px-5 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              {isRunning ? "Processing..." : "Extract"}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Supports youtube.com and youtu.be links. Works best with videos that have captions enabled.
          </p>
        </form>

        {/* Status / progress */}
        {status.kind === "loading" && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center gap-4">
            <Spinner />
            <p className="text-sm text-gray-600">{status.message}</p>
          </div>
        )}

        {status.kind === "processing" && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-3">
            <div className="flex items-center gap-4">
              <Spinner />
              <p className="text-sm text-gray-600">
                Cleaning up transcript — chunk{" "}
                <span className="font-medium">{status.current}</span> of{" "}
                <span className="font-medium">{status.total}</span>
              </p>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-red-500 rounded-full transition-all duration-500"
                style={{
                  width:
                    status.total > 0
                      ? `${Math.round((status.current / status.total) * 100)}%`
                      : "0%",
                }}
              />
            </div>
          </div>
        )}

        {status.kind === "error" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex gap-3">
            <svg
              className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm text-red-700">{status.message}</p>
          </div>
        )}

        {/* Transcript output */}
        {transcript && (() => {
          const isDone = status.kind === "done";
          const hasSpeakers = isDone && /^Speaker \d+:/m.test(transcript);
          return (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-700">
                  Cleaned Transcript
                  {status.kind === "processing" && (
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      (updating live…)
                    </span>
                  )}
                </h2>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors border border-gray-200"
                >
                  {copied ? (
                    <>
                      <svg
                        className="w-3.5 h-3.5 text-green-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
              <div className="px-6 py-5">
                <TranscriptRenderer text={transcript} />
              </div>
              {/* Speaker / timecode footer — only after processing is complete */}
              {isDone && (
                <div className="px-6 pb-5 space-y-2">
                  {hasSpeakers ? (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                      <span className="font-medium">Note:</span> Speaker labels are AI-inferred and may not be accurate — YouTube transcripts contain no speaker data. Verify against the original video before publishing.
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Speaker identification was not possible for this video.
                    </p>
                  )}
                  {hasTimecodes && (
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Timecodes are approximate and reflect the original video timestamps.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </main>
    </div>
  );
}

// Renders the cleaned transcript with timecodes styled as muted gray badges
// and speaker labels styled as bold text, while preserving all whitespace/newlines.
function TranscriptRenderer({ text }: { text: string }) {
  // Split into lines first so \n is respected, then handle timecodes and speaker
  // labels within each line.
  const lines = text.split("\n");
  return (
    <div className="font-sans text-sm text-gray-800 leading-relaxed space-y-1 whitespace-pre-wrap">
      {lines.map((line, li) => {
        // Each line may contain zero or more [M:00] markers and/or start with "Speaker N:"
        const parts = line.split(/(\[\d+:\d{2}\])/g);
        return (
          <span key={li}>
            {parts.map((part, pi) => {
              if (/^\[\d+:\d{2}\]$/.test(part)) {
                return (
                  <span
                    key={pi}
                    className="inline-block text-[11px] text-gray-400 font-mono bg-gray-100 rounded px-1 py-px mx-0.5 align-middle leading-none select-none"
                  >
                    {part}
                  </span>
                );
              }
              // Bold the "Speaker N:" label at the start of a segment
              const speakerMatch = part.match(/^(Speaker \d+:)([\s\S]*)$/);
              if (speakerMatch) {
                return (
                  <span key={pi}>
                    <span className="font-semibold text-gray-900">
                      {speakerMatch[1]}
                    </span>
                    {speakerMatch[2]}
                  </span>
                );
              }
              return <span key={pi}>{part}</span>;
            })}
            {li < lines.length - 1 && "\n"}
          </span>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-5 h-5 text-red-500 animate-spin flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

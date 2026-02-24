"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ── Speaker rename helpers ────────────────────────────────────────────────────

function applyRenames(text: string, names: Record<string, string>): string {
  if (Object.keys(names).length === 0) return text;
  return text.replace(/Speaker (\d+):/g, (match, n) => {
    const custom = names[`Speaker ${n}`];
    return custom ? `${custom}:` : match;
  });
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "processing"; current: number; total: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

type VideoMeta = { title: string; durationSeconds: number };

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export default function TranscriptPage() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [transcript, setTranscript] = useState("");
  const [hasTimecodes, setHasTimecodes] = useState(false);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [copied, setCopied] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [downloadPending, setDownloadPending] = useState<null | { type: "txt" | "docx"; suggestedName: string }>(null);
  const [supadataKey, setSupadataKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Restore persisted preferences on mount (runs client-side only)
  useEffect(() => {
    const storedKey = localStorage.getItem("supadataKey");
    if (storedKey) { setSupadataKey(storedKey); setKeyOpen(true); }

    const storedDark = localStorage.getItem("darkMode");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = storedDark !== null ? storedDark === "true" : prefersDark;
    setDarkMode(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggleDark = useCallback(() => {
    setDarkMode((v) => {
      const next = !v;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("darkMode", String(next));
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.trim()) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setTranscript("");
      setHasTimecodes(false);
      setVideoMeta(null);
      setSpeakerNames({});
      setStatus({ kind: "loading", message: "Fetching transcript…" });

      try {
        const response = await fetch("/api/transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url.trim(),
            supadataKey: supadataKey.trim() || undefined,
          }),
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
        let receivedCompletion = false;

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

              case "meta":
                setVideoMeta({
                  title: event.title as string,
                  durationSeconds: event.durationSeconds as number,
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
                receivedCompletion = true;
                break;

              case "error":
                setStatus({
                  kind: "error",
                  message: event.message as string,
                });
                receivedCompletion = true;
                break;
            }
          }
        }
        // Stream ended without a done or error event — Vercel timeout or network cut
        if (!receivedCompletion) {
          setStatus({
            kind: "error",
            message:
              "The request was cut off before finishing — the video may be too long for the server's time limit. Try a shorter video, or try again.",
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setStatus({
          kind: "error",
          message: "Network error. Please check your connection and try again.",
        });
      }
    },
    [url, supadataKey]
  );

  // Extract unique speaker labels actually present in the transcript (e.g. ["Speaker 1", "Speaker 2"])
  const detectedSpeakers = useMemo(() => {
    if (!transcript) return [];
    const matches = [...transcript.matchAll(/Speaker (\d+):/g)];
    const nums = [...new Set(matches.map((m) => parseInt(m[1])))].sort((a, b) => a - b);
    return nums.map((n) => `Speaker ${n}`);
  }, [transcript]);

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    await navigator.clipboard.writeText(applyRenames(transcript, speakerNames));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [transcript, speakerNames]);

  const suggestedFileName = useMemo(() => {
    return videoMeta?.title
      ? videoMeta.title.slice(0, 60).replace(/[^\w\s-]/g, "_").trim() || "transcript"
      : "transcript";
  }, [videoMeta]);

  const handleDownloadTxt = useCallback(() => {
    if (!transcript) return;
    setDownloadPending({ type: "txt", suggestedName: suggestedFileName });
  }, [transcript, suggestedFileName]);

  const handleDownloadDocx = useCallback(() => {
    if (!transcript) return;
    setDownloadPending({ type: "docx", suggestedName: suggestedFileName });
  }, [transcript, suggestedFileName]);

  const executeTxtDownload = useCallback((name: string) => {
    if (!transcript) return;
    const blob = new Blob([applyRenames(transcript, speakerNames)], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${name}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
    setDownloadPending(null);
  }, [transcript, speakerNames]);

  const executeDocxDownload = useCallback(async (name: string) => {
    if (!transcript) return;
    const { Document, Packer, Paragraph, TextRun } = await import("docx");

    const paragraphs = [];

    // Optional header: title + duration
    if (videoMeta) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: videoMeta.title, bold: true, size: 28 })],
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: formatDuration(videoMeta.durationSeconds),
              color: "666666",
              size: 20,
            }),
          ],
        }),
        new Paragraph({})
      );
    }

    const effectiveText = applyRenames(transcript, speakerNames);

    // Build a regex that matches all speaker label prefixes (original or renamed)
    const speakerLabelRe = detectedSpeakers.length > 0
      ? new RegExp(
          `^((?:${detectedSpeakers
            .map((s) => (speakerNames[s] || s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")}):)([\\s\\S]*)$`
        )
      : /^(Speaker \d+:)([\s\S]*)$/;

    for (const line of effectiveText.split("\n")) {
      if (!line.trim()) {
        paragraphs.push(new Paragraph({}));
        continue;
      }
      const parts = line.split(/(\[\d+:\d{2}(?::\d{2})?\])/g);
      const runs = [];
      for (const part of parts) {
        if (/^\[\d+:\d{2}(?::\d{2})?\]$/.test(part)) {
          runs.push(new TextRun({ text: part + " ", color: "888888", size: 20 }));
        } else {
          const sm = part.match(speakerLabelRe);
          if (sm) {
            runs.push(new TextRun({ text: sm[1], bold: true }));
            runs.push(new TextRun({ text: sm[2] }));
          } else {
            runs.push(new TextRun({ text: part }));
          }
        }
      }
      paragraphs.push(new Paragraph({ children: runs }));
    }

    const doc = new Document({
      sections: [{ properties: {}, children: paragraphs }],
    });

    const blob = await Packer.toBlob(doc);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${name}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
    setDownloadPending(null);
  }, [transcript, videoMeta, speakerNames, detectedSpeakers]);

  const isRunning = status.kind === "loading" || status.kind === "processing";
  const isDone = status.kind === "done";
  const hasSpeakers = isDone && /^Speaker \d+:/m.test(transcript);

  const wordCount = useMemo(() => {
    if (!transcript) return 0;
    return transcript
      .replace(/\[\d+:\d{2}(?::\d{2})?\]/g, "")
      .split(/\s+/)
      .filter(Boolean).length;
  }, [transcript]);

  // Friendly progress label that evolves as cleaning advances
  const progressLabel = useMemo(() => {
    if (status.kind === "loading") return status.message;
    if (status.kind !== "processing") return "";
    const pct =
      status.total > 0
        ? Math.round((status.current / status.total) * 100)
        : 0;
    if (pct < 40) return "Cleaning up text…";
    if (pct < 80) return "Working through it…";
    return "Almost done…";
  }, [status]);

  // Combined progress percentage for a unified progress bar
  const progressPct = useMemo(() => {
    if (status.kind === "processing" && status.total > 0) {
      return Math.round((status.current / status.total) * 100);
    }
    return null;
  }, [status]);

  return (
    <div className="min-h-screen bg-[#FAFAF8] dark:bg-[#0F1117] transition-colors duration-200">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="bg-white dark:bg-[#161B22] border-b border-gray-200 dark:border-white/[0.08] shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
                YouTube Transcript Extractor
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Paste a YouTube URL to get a clean, readable transcript
              </p>
            </div>
            {/* Dark mode toggle */}
            <button
              onClick={toggleDark}
              aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
            >
              {darkMode ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* ── Info chips ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Accuracy */}
          <div className="flex gap-3 bg-white dark:bg-[#161B22] rounded-xl border border-gray-200 dark:border-white/[0.08] px-4 py-3.5">
            <div className="w-7 h-7 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-700/30 flex items-center justify-center flex-shrink-0 mt-px">
              <svg className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Accuracy</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">AI-cleaned — not verbatim. Verify against the original video before quoting.</p>
            </div>
          </div>
          {/* Check first */}
          <div className="flex gap-3 bg-white dark:bg-[#161B22] rounded-xl border border-gray-200 dark:border-white/[0.08] px-4 py-3.5">
            <div className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200/70 dark:border-blue-700/30 flex items-center justify-center flex-shrink-0 mt-px">
              <svg className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Check first</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">On YouTube, click <span className="font-medium text-gray-600 dark:text-gray-300">⋯</span> below the player and choose <span className="font-medium text-gray-600 dark:text-gray-300">Open transcript</span>. No option = no transcript here.</p>
            </div>
          </div>
          {/* Usage */}
          <div className="flex gap-3 bg-white dark:bg-[#161B22] rounded-xl border border-gray-200 dark:border-white/[0.08] px-4 py-3.5">
            <div className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-white/[0.05] border border-gray-200/70 dark:border-white/[0.08] flex items-center justify-center flex-shrink-0 mt-px">
              <svg className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Usage limit</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">~100 transcripts per month. Please be mindful of usage.</p>
            </div>
          </div>
        </div>

        {/* ── URL form ─────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="bg-white dark:bg-[#161B22] rounded-xl shadow-sm border border-gray-200 dark:border-white/[0.08] p-6">
          <label htmlFor="yt-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            YouTube URL
          </label>
          <div className="flex gap-3">
            <input
              id="yt-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              disabled={isRunning}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={isRunning || !url.trim()}
              className="px-5 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              {isRunning ? "Processing…" : "Extract"}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Supports youtube.com and youtu.be links. Works best with videos that have captions enabled.
            </p>
            <button
              type="button"
              onClick={() => setKeyOpen((v) => !v)}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex-shrink-0 ml-3"
            >
              {keyOpen ? "Hide API key" : (supadataKey ? "API key set ✓" : "API key")}
            </button>
          </div>
          {keyOpen && (
            <div className="mt-3 space-y-1.5">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Supadata API key
                <span className="font-normal text-gray-400 dark:text-gray-500 ml-1">— optional, fixes YouTube IP blocks</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={supadataKey}
                  onChange={(e) => {
                    setSupadataKey(e.target.value);
                    localStorage.setItem("supadataKey", e.target.value);
                  }}
                  placeholder="Paste your key here…"
                  autoComplete="off"
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent font-mono"
                />
                {supadataKey && (
                  <button
                    type="button"
                    onClick={() => { setSupadataKey(""); localStorage.removeItem("supadataKey"); }}
                    className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 border border-gray-300 dark:border-gray-600 rounded-lg transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Free keys at{" "}
                <a
                  href="https://supadata.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  supadata.ai
                </a>
                . Stored locally in your browser only.
              </p>
            </div>
          )}
        </form>

        {/* ── Progress indicator (loading + processing share one card) ── */}
        {(status.kind === "loading" || status.kind === "processing") && (
          <div className="bg-white dark:bg-[#161B22] rounded-xl shadow-sm border border-gray-200 dark:border-white/[0.08] p-6 space-y-3">
            <div className="flex items-center gap-4">
              <Spinner />
              <p className="text-sm text-gray-600 dark:text-gray-400 font-medium">
                {progressLabel}
              </p>
            </div>
            {progressPct !== null && (
              <div className="space-y-1">
                <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 text-right">
                  {progressPct}%
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────────── */}
        {status.kind === "error" && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-5 flex gap-3">
            <svg className="w-5 h-5 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-red-700 dark:text-red-400">{status.message}</p>
          </div>
        )}

        {/* ── Video meta: title + duration ─────────────────────────────── */}
        {videoMeta && (
          <div className="bg-white dark:bg-[#161B22] rounded-xl shadow-sm border border-gray-200 dark:border-white/[0.08] px-5 py-4 flex items-start gap-3">
            <div className="w-8 h-8 bg-red-100 dark:bg-red-900/30 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg className="w-4 h-4 text-red-600 dark:text-red-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
                {videoMeta.title}
              </p>
              {videoMeta.durationSeconds > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {formatDuration(videoMeta.durationSeconds)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Transcript output ────────────────────────────────────────── */}
        {transcript && (
          <div className="bg-white dark:bg-[#161B22] rounded-xl shadow-sm border border-gray-200 dark:border-white/[0.08] overflow-hidden">
            {/* Card header: title, word count, action buttons */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 dark:border-white/[0.06] gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2 flex-wrap">
                  {videoMeta?.title ?? "Cleaned Transcript"}
                  {status.kind === "processing" && (
                    <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
                      (updating live…)
                    </span>
                  )}
                </h2>
                {isDone && wordCount > 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    Word count: {wordCount.toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {isDone && (
                  <>
                    <button
                      onClick={handleDownloadTxt}
                      title="Download as plain text"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors border border-gray-200 dark:border-gray-600"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      .txt
                    </button>
                    <button
                      onClick={handleDownloadDocx}
                      title="Download as Word document"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors border border-gray-200 dark:border-gray-600"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      .docx
                    </button>
                  </>
                )}
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors border border-gray-200 dark:border-gray-600"
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Speaker rename panel — only visible when speakers are present and done */}
            {isDone && detectedSpeakers.length > 0 && (
              <SpeakerRenamePanel
                speakers={detectedSpeakers}
                names={speakerNames}
                onChange={(speaker, name) =>
                  setSpeakerNames((prev) => ({ ...prev, [speaker]: name }))
                }
              />
            )}

            {/* Speaker caveat — shown before the transcript so users see it first */}
            {isDone && hasSpeakers && (
              <div className="px-6 pt-4 pb-1">
                <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 leading-relaxed">
                  <span className="font-medium">Note:</span> Speaker labels are AI-inferred and may not be accurate — YouTube transcripts contain no speaker data. Verify against the original video before publishing.
                </p>
              </div>
            )}

            {/* Transcript body */}
            <div className="px-6 py-5">
              <TranscriptRenderer text={transcript} speakerNames={speakerNames} />
            </div>

            {/* Timecode footnote */}
            {isDone && hasTimecodes && (
              <div className="px-6 pb-5">
                <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                  Timecodes are approximate and reflect the original video timestamps.
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Filename dialog ──────────────────────────────────────────────── */}
      {downloadPending && (
        <FileNameDialog
          suggestedName={downloadPending.suggestedName}
          extension={downloadPending.type}
          onConfirm={(name) => {
            if (downloadPending.type === "txt") executeTxtDownload(name);
            else executeDocxDownload(name);
          }}
          onCancel={() => setDownloadPending(null)}
        />
      )}
    </div>
  );
}

// ── TranscriptRenderer ────────────────────────────────────────────────────────
// Renders timecodes as muted gray badges and speaker labels as bold text,
// while preserving all whitespace and newlines. Applies speakerNames substitutions live.
function TranscriptRenderer({
  text,
  speakerNames = {},
}: {
  text: string;
  speakerNames?: Record<string, string>;
}) {
  const lines = text.split("\n");
  return (
    <div className="font-sans text-[15px] text-gray-800 dark:text-gray-200 leading-7 space-y-1 whitespace-pre-wrap">
      {lines.map((line, li) => {
        const parts = line.split(/(\[\d+:\d{2}(?::\d{2})?\])/g);
        return (
          <span key={li}>
            {parts.map((part, pi) => {
              if (/^\[\d+:\d{2}(?::\d{2})?\]$/.test(part)) {
                return (
                  <span
                    key={pi}
                    className="inline-block text-[11px] text-gray-400 dark:text-gray-500 font-mono bg-gray-100 dark:bg-gray-800 rounded px-1 py-px mx-0.5 align-middle leading-none select-none"
                  >
                    {part}
                  </span>
                );
              }
              const sm = part.match(/^(Speaker (\d+):)([\s\S]*)$/);
              if (sm) {
                const speakerKey = `Speaker ${sm[2]}`;
                const displayLabel = speakerNames[speakerKey]
                  ? `${speakerNames[speakerKey]}:`
                  : sm[1];
                return (
                  <span key={pi}>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {displayLabel}
                    </span>
                    {sm[3]}
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

// ── SpeakerRenamePanel ────────────────────────────────────────────────────────
// Shows one editable chip per detected speaker. Clicking a chip opens an inline
// text field; confirming (Enter / blur) or cancelling (Escape) closes it.
function SpeakerRenamePanel({
  speakers,
  names,
  onChange,
}: {
  speakers: string[];
  names: Record<string, string>;
  onChange: (speaker: string, name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (speaker: string) => {
    setEditing(speaker);
    setDraft(names[speaker] ?? "");
  };

  const confirm = (speaker: string) => {
    onChange(speaker, draft.trim());
    setEditing(null);
  };

  const cancel = () => setEditing(null);

  if (speakers.length === 0) return null;

  return (
    <div className="px-6 py-3 border-b border-gray-100 dark:border-white/[0.06] bg-gray-50/80 dark:bg-white/[0.03]">
      <p className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-2">
        Rename speakers
      </p>
      <div className="flex flex-wrap gap-2">
        {speakers.map((speaker) => {
          const displayName = names[speaker] || speaker;
          const isEditing = editing === speaker;

          if (isEditing) {
            return (
              <div key={speaker} className="flex items-center gap-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirm(speaker);
                    if (e.key === "Escape") cancel();
                  }}
                  onBlur={() => confirm(speaker)}
                  placeholder={speaker}
                  className="text-xs border border-blue-400 dark:border-blue-500 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
                />
              </div>
            );
          }

          const isRenamed = !!names[speaker];
          return (
            <button
              key={speaker}
              onClick={() => startEdit(speaker)}
              title={`Click to rename ${speaker}`}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                isRenamed
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              <span>{displayName}</span>
              <svg
                className="w-3 h-3 opacity-60 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── FileNameDialog ────────────────────────────────────────────────────────────
// Modal that lets the user edit the filename before downloading.
function FileNameDialog({
  suggestedName,
  extension,
  onConfirm,
  onCancel,
}: {
  suggestedName: string;
  extension: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(suggestedName);
  const trimmed = value.trim();

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Save as
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Edit the file name before downloading.
        </p>
        <div className="flex items-center gap-1.5 mb-5">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmed) onConfirm(trimmed);
              if (e.key === "Escape") onCancel();
            }}
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent min-w-0"
          />
          <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap flex-shrink-0">
            .{extension}
          </span>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (trimmed) onConfirm(trimmed); }}
            disabled={!trimmed}
            className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
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

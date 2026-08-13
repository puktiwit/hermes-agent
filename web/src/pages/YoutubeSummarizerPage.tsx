import { useCallback, useEffect, useRef, useState } from "react";
import { Youtube, Sparkles, Trash2, FileDown, Send, Loader2, AlertCircle } from "lucide-react";
import { api, type YoutubeSummary } from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";

function exportPdf(item: YoutubeSummary) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>YouTube Summary</title>
<style>
  body { font-family: "Leelawadee UI", "Tahoma", sans-serif; padding: 32px; line-height: 1.7; color: #111; }
  h1 { font-size: 20px; border-bottom: 2px solid #0053fd; padding-bottom: 8px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  .summary { white-space: pre-wrap; font-size: 14px; }
  a { color: #0053fd; }
</style></head>
<body>
  <h1>YouTube Summary</h1>
  <div class="meta">${item.url}<br/>Video ID: ${item.video_id} · สรุปเมื่อ ${new Date(item.created_at * 1000).toLocaleString("th-TH")}</div>
  <div class="summary">${item.summary.replace(/</g, "&lt;")}</div>
</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) {
    w.focus();
    setTimeout(() => w.print(), 400);
  }
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export default function YoutubeSummarizerPage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<YoutubeSummary | null>(null);
  const [history, setHistory] = useState<YoutubeSummary[]>([]);
  const printRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const h = await api.getYoutubeSummaries();
      setHistory(Array.isArray(h) ? h : []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const summarize = useCallback(async () => {
    const v = url.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.youtubeSummarize(v);
      setCurrent(res);
      await loadHistory();
      setUrl("");
    } catch (e: any) {
      setError(String(e?.detail ?? e));
    } finally {
      setBusy(false);
    }
  }, [url, busy, loadHistory]);

  const del = useCallback(
    async (id: string) => {
      try {
        await api.deleteYoutubeSummary(id);
        if (current?.id === id) setCurrent(null);
        await loadHistory();
      } catch (e) {
        setError(String(e));
      }
    },
    [current, loadHistory],
  );

  const [sending, setSending] = useState(false);

  const sendToTelegram = useCallback(
    async (id: string) => {
      setSending(true);
      setError(null);
      try {
        const res = await api.sendYoutubeSummaryToTelegram(id);
        if (res.status !== "sent") throw new Error("ไม่ได้ส่ง");
      } catch (e: any) {
        setError(String(e?.detail ?? e));
      } finally {
        setSending(false);
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4 p-4" ref={printRef}>
      <div className="flex items-center gap-2">
        <Youtube className="h-5 w-5 text-red-500" />
        <h1 className="text-xl font-semibold">YouTube Summarizer</h1>
        {busy && <Spinner />}
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="วางลิงก์ YouTube ที่นี่…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void summarize()}
        />
        <Button size="sm" onClick={() => void summarize()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          สรุป
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* Current summary */}
      {current && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> สรุปล่าสุด
            </CardTitle>
            <div className="flex gap-1">
              <Button
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => exportPdf(current)}
                title="Export PDF (opens print dialog)"
              >
                <FileDown className="h-4 w-4" /> PDF
              </Button>
              <Button
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void sendToTelegram(current.id)}
                disabled={sending}
                title="ส่ง PDF เข้า Telegram"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} PDF→TG
              </Button>
              <Button
                size="icon"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void del(current.id)}
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground break-all">
              <a href={current.url} className="text-primary hover:underline" target="_blank" rel="noreferrer">
                {current.url}
              </a>{" "}
              · {current.transcript_len} ตัวอักษร
            </p>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{current.summary}</div>
          </CardContent>
        </Card>
      )}

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Youtube className="h-4 w-4 text-red-400" /> ประวัติ ({history.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 max-h-96 overflow-auto">
          {history.length === 0 && (
            <p className="text-sm text-muted-foreground">ยังไม่มีสรุป</p>
          )}
          {history.map((h) => (
            <div key={h.id} className="flex items-start justify-between gap-3 rounded border px-3 py-2">
              <div className="min-w-0 flex-1">
                <button
                  className="block w-full text-left"
                  onClick={() => setCurrent(h)}
                  title="คลิกเพื่อแสดง"
                >
                  <p className="truncate text-sm font-medium hover:text-primary">
                    {h.url}
                  </p>
                </button>
                <p className="truncate text-xs text-muted-foreground">
                  {new Date(h.created_at * 1000).toLocaleString("th-TH")}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => exportPdf(h)}
                  title="Export PDF"
                >
                  <FileDown className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void sendToTelegram(h.id)}
                  disabled={sending}
                  title="ส่ง PDF เข้า Telegram"
                >
                  <Send className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void del(h.id)}
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    if (window.confirm("ลบประวัตินี้ใช่ไหม?")) void del(h.id);
                  }}
                  title="ลบประวัติ"
                >
                  <Trash2 className="h-4 w-4" /> ลบ
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

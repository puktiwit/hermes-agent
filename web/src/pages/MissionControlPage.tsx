import { useCallback, useEffect, useState } from "react";
import {
  Radar,
  RefreshCw,
  Play,
  Pause,
  Trash2,
  Zap,
  Cpu,
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  Palette,
} from "lucide-react";
import { api, type CronJob, type Todo, type TodoStatus } from "@/lib/api";
import { BUILTIN_THEMES, useTheme } from "@/themes";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { usePageHeader } from "@/contexts/usePageHeader";

interface SessionLite {
  id: string;
  title: string | null;
  model: string | null;
  is_active: boolean;
  message_count: number;
  last_active: number;
}

interface StatusLite {
  version?: string;
  gateway_running?: boolean;
  active_sessions?: number;
  hermes_home?: string;
  disk?: { total: number; used: number; free: number; percent: number };
}

const TODO_COLORS: Record<TodoStatus, string> = {
  pending: "bg-muted text-foreground",
  in_progress: "bg-blue-500/20 text-blue-300",
  completed: "bg-green-500/20 text-green-300",
  cancelled: "bg-red-500/20 text-red-300",
};

function fmtBytes(n?: number): string {
  if (!n) return "—";
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(n / 1e6).toFixed(0)} MB`;
}

function fmtAgo(ts?: number): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function MissionControlPage() {
  const { setEnd } = usePageHeader();
  const [cron, setCron] = useState<CronJob[]>([]);
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [status, setStatus] = useState<StatusLite | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);

  const { themeName, setTheme } = useTheme();
  const themeList = Object.values(BUILTIN_THEMES);
  const cycleTheme = useCallback(() => {
    const idx = themeList.findIndex((t) => t.name === themeName);
    const next = themeList[(idx + 1) % themeList.length];
    void setTheme(next.name);
  }, [themeList, themeName, setTheme]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [newTodo, setNewTodo] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s, st, t] = await Promise.all([
        api.getCronJobs("all").catch(() => [] as CronJob[]),
        api.getSessions(50).catch(() => ({ sessions: [] as SessionLite[] })),
        api.getStatus().catch(() => null),
        api.getTodos().catch(() => [] as Todo[]),
      ]);
      setCron(Array.isArray(c) ? c : []);
      setSessions((s?.sessions ?? []).filter((x) => x.is_active));
      setStatus(st);
      setTodos(Array.isArray(t) ? t : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    setEnd(
      <Button
        size="sm"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => void loadAll()}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Refresh
      </Button>,
    );
    return () => setEnd(null);
  }, [setEnd, loadAll, loading]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void loadAll(), 15000);
    return () => clearInterval(id);
  }, [auto, loadAll]);

  const cronAction = useCallback(
    async (id: string, kind: "pause" | "resume" | "trigger" | "delete") => {
      try {
        if (kind === "pause") await api.pauseCronJob(id);
        else if (kind === "resume") await api.resumeCronJob(id);
        else if (kind === "trigger") await api.triggerCronJob(id);
        else if (kind === "delete") await api.deleteCronJob(id);
        await loadAll();
      } catch (e) {
        setError(String(e));
      }
    },
    [loadAll],
  );

  const addTodo = useCallback(async () => {
    const v = newTodo.trim();
    if (!v) return;
    try {
      await api.createTodo(v);
      setNewTodo("");
      await loadAll();
    } catch (e) {
      setError(String(e));
    }
  }, [newTodo, loadAll]);

  const todoAction = useCallback(
    async (id: string, patch: Partial<{ status: TodoStatus }> | "delete") => {
      try {
        if (patch === "delete") await api.deleteTodo(id);
        else await api.updateTodo(id, patch);
        await loadAll();
      } catch (e) {
        setError(String(e));
      }
    },
    [loadAll],
  );

  const cycleStatus = (cur: TodoStatus): TodoStatus => {
    const order: TodoStatus[] = ["pending", "in_progress", "completed"];
    const i = order.indexOf(cur);
    return order[(i + 1) % order.length];
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Mission Control</h1>
          {loading && <Spinner />}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          Auto-refresh (15s)
        </label>
        <Button
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={cycleTheme}
          title="Click to cycle theme"
        >
          <Palette className="h-4 w-4" />
          {themeName}
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── Cron ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-400" /> Cron Jobs ({cron.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 max-h-80 overflow-auto">
            {cron.length === 0 && (
              <p className="text-sm text-muted-foreground">No cron jobs.</p>
            )}
            {cron.map((j) => (
              <div
                key={j.id}
                className="flex items-center justify-between rounded border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{j.name || j.prompt || j.id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {j.schedule_display || j.schedule?.display || ""} ·{" "}
                    {j.enabled ? "active" : "paused"}
                  </p>
                </div>
                <div className="flex gap-1">
                  {j.enabled ? (
                    <Button
                      size="icon"
                      className="text-muted-foreground hover:text-foreground"
                      title="Pause"
                      onClick={() => cronAction(j.id, "pause")}
                    >
                      <Pause className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      className="text-muted-foreground hover:text-foreground"
                      title="Resume"
                      onClick={() => cronAction(j.id, "resume")}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    title="Run now"
                    onClick={() => cronAction(j.id, "trigger")}
                  >
                    <Zap className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    title="Delete"
                    onClick={() => cronAction(j.id, "delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Running Agents ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-blue-400" /> Running Agents ({sessions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 max-h-80 overflow-auto">
            {sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">No active agents.</p>
            )}
            {sessions.map((s) => (
              <div key={s.id} className="rounded border px-3 py-2">
                <div className="flex items-center justify-between">
                  <p className="truncate font-medium">{s.title || s.id}</p>
                  <Badge className="bg-green-500/20 text-green-300">active</Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {s.model} · {s.message_count} msgs · {fmtAgo(s.last_active)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── System Status ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-purple-400" /> System Status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Row label="Hermes version" value={status?.version ?? "—"} />
            <Row
              label="Gateway"
              value={status?.gateway_running ? "running" : "stopped"}
              ok={!!status?.gateway_running}
            />
            <Row label="Active sessions" value={String(status?.active_sessions ?? "—")} />
            <Row label="Hermes home" value={status?.hermes_home ?? "—"} mono />
            {status?.disk && (
              <div className="mt-1">
                <Row
                  label="Disk"
                  value={`${fmtBytes(status.disk.used)} / ${fmtBytes(status.disk.total)} (${status.disk.percent}%)`}
                />
                <div className="mt-1 h-2 w-full rounded bg-muted">
                  <div
                    className="h-2 rounded bg-primary"
                    style={{ width: `${status.disk.percent ?? 0}%` }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Todos ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-400" /> Todos ({todos.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 max-h-80 overflow-auto">
            <div className="flex gap-2">
              <Input
                placeholder="Add a task…"
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addTodo()}
              />
              <Button size="sm" onClick={() => void addTodo()}>
                Add
              </Button>
            </div>
            {todos.length === 0 && (
              <p className="text-sm text-muted-foreground">No todos yet.</p>
            )}
            {todos.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded border px-3 py-2">
                <button
                  className="flex min-w-0 items-center gap-2 text-left"
                  onClick={() => todoAction(t.id, { status: cycleStatus(t.status) })}
                  title="Click to cycle status"
                >
                  {t.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  ) : t.status === "in_progress" ? (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className={t.status === "completed" ? "line-through opacity-60" : ""}>
                    {t.content}
                  </span>
                </button>
                <div className="flex items-center gap-2">
                  <Badge className={TODO_COLORS[t.status]}>{t.status}</Badge>
                  <Button
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    title="Delete"
                    onClick={() => todoAction(t.id, "delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, ok, mono }: { label: string; value: string; ok?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`${mono ? "font-mono text-xs" : ""} ${ok === false ? "text-destructive" : ""}`}>
        {value}
      </span>
    </div>
  );
}

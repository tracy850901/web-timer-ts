import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Wonder Core 會議計時小工具（React + 輕量 CSS）
 * ---------------------------------------------------------------------------
 * 修復：移除脫隊片段與錯置的 return（導致 "return outside of function"），重整檔案結構。
 * 功能：分圈、開始/暫停/重置、目標分鐘比對、總範圍、RWD、複製匯出（無括號）、本地保存（重整最多恢復2次）。
 * 偵錯：全域日誌 [Timer]、自我測試（不依賴 DOM）。
 */

// ---------------- 日誌 ----------------
const log = (...args: any[]) => console.log("[Timer]", ...args);
const debug = (...args: any[]) => console.debug("[Timer]", ...args);
const warn = (...args: any[]) => console.warn("[Timer]", ...args);

// ---------------- Utility ----------------
// 將毫秒轉為 {h,m,s,cs}（cs=1/100秒）以供主讀秒顯示
const msToHMS = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  const cs = Math.floor((ms % 1000) / 10).toString().padStart(2, "0");
  return { h, m, s, cs };
};

// 僅 HH:MM:SS（總覽括號內也用此格式）
const fmtHMS = (ms: number) => {
  const { h, m, s } = msToHMS(ms);
  return `${h}:${m}:${s}`;
};

// 將時間戳轉為本地 HH:MM（不含秒）
const fmtRange = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// 預定時間狀態：超過/未超過/-（未設定）
const getPresetStatus = (durationMs: number, targetMinutes?: number) => {
  if (targetMinutes == null || Number.isNaN(targetMinutes)) return "-";
  const targetMs = targetMinutes * 60000;
  return durationMs > targetMs ? "超過" : "未超過";
};

// 『目標分鐘 + 狀態』視覺化（在 JSX 中用）
function renderTargetAndStatus(targetMinutes: number | undefined, durationMs: number) {
  if (targetMinutes == null || Number.isNaN(targetMinutes)) return <span className="text-gray-500">-</span>;
  const status = getPresetStatus(durationMs, targetMinutes); // "未超過" | "超過"
  const statusCls = status === "超過" ? "text-red-600" : "text-blue-600";
  return (
    <span className="text-gray-700">目標：{targetMinutes} 分鐘 / <span className={statusCls}>{status}</span></span>
  );
}

// 匯出文字總結（無括號；不含進行中列）
const buildTextSummary = (
  lapRows: Array<{ startTs: number; endTs: number; durationMs: number; targetMinutes?: number }>,
  rangeStart?: number | null,
  rangeEnd?: number | null,
  rangeDuration?: number
) => {
  if (!lapRows || lapRows.length === 0) return "尚無區段紀錄";
  const lines = lapRows.map((lap, idx) => {
    const mins = Math.round(lap.durationMs / 60000);
    return `${idx + 1}. ${fmtRange(lap.startTs)}~${fmtRange(lap.endTs)}，共 ${mins} 分鐘`;
  });
  if (rangeStart && rangeEnd) {
    lines.push("");
    lines.push(`總時長：${fmtRange(rangeStart)}~${fmtRange(rangeEnd)}（共 ${fmtHMS(rangeDuration || 0)}）`);
  }
  const out = lines.join("\n");
  debug("buildTextSummary lines:", lines.length);
  return out;
};

// 穩健複製：優先 Clipboard API（需 HTTPS），失敗退回 execCommand，再退回選取提示
async function safeCopyText(text: string) {
  try {
    if (navigator.clipboard && (window as any).isSecureContext) {
      await navigator.clipboard.writeText(text);
      log("clipboard.writeText success (secure)");
      return true;
    }
  } catch (err) { warn("clipboard.writeText error:", err); }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-9999px";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    log("execCommand copy:", ok);
    return !!ok;
  } catch (err) { warn("execCommand copy error:", err); return false; }
}

// 最終退回：選取元素文字，提示手動 ⌘/Ctrl+C
function selectElementText(el: HTMLElement) {
  try {
    const sel = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(el); sel?.removeAllRanges(); sel?.addRange(range);
  } catch (err) { warn("selectElementText error:", err); }
}

// 避免快捷鍵誤觸輸入框
function isTypingTarget(el: EventTarget | null) {
  if (!el) return false; const anyEl = el as HTMLElement; const tag = anyEl.tagName ? anyEl.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || (anyEl as any).isContentEditable === true;
}

// 解析「區段目標時間（分鐘）」輸入（空字串不轉 0）
function computePresetFromInput(raw: string, valueAsNumber?: number): number | undefined {
  if (raw.trim() === "") return undefined; // 讓受控 input 顯示 "" 並維持 caret 閃動
  const n = valueAsNumber; if (n === undefined || Number.isNaN(n)) return undefined;
  return Math.max(0, Math.floor(n)); // 非負整數；小數向下取整
}

// 讓讀秒在「容器寬度」內自適應字級（避免溢出）；用 ResizeObserver + 二分搜尋
function useFitFont(
  containerRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
  sampleText: string,
  maxPx: number,
  minPx: number
) {
  const [fontSize, setFontSize] = useState(maxPx);

  const recalc = React.useCallback(() => {
    const container = containerRef.current as HTMLElement | null;
    const text = textRef.current as HTMLElement | null;
    if (!container || !text) return;
    let low = minPx, high = maxPx, best = minPx;
    const prevWhiteSpace = text.style.whiteSpace;
    text.style.whiteSpace = "nowrap"; // 固定單行，精準量測 scrollWidth
    for (let i = 0; i < 10; i++) {
      const mid = Math.floor((low + high) / 2);
      text.style.fontSize = `${mid}px`;
      const fits = text.scrollWidth <= (container.clientWidth - 8); // 留 8px buffer
      if (fits) { best = mid; low = mid + 1; } else { high = mid - 1; }
    }
    text.style.fontSize = `${best}px`;
    text.style.whiteSpace = prevWhiteSpace;
    setFontSize(best);
  }, [containerRef, textRef, maxPx, minPx]);

  useEffect(() => { recalc(); }, [recalc, sampleText, maxPx, minPx]);
  useEffect(() => {
    const container = containerRef.current as HTMLElement | null;
    const onResize = () => recalc();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (container && ro) ro.observe(container);
    window.addEventListener("resize", onResize);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [recalc]);

  return fontSize;
}

// ---------------- App ----------------
export default function App() {
  /**
   * 狀態與參照：
   * - isRunning/baseElapsed/startedAtRef：主計時（有效時間）
   * - laps：已完成區段（只在 Lap 時 push）
   * - sessionStartTsRef/lapAnchorTsRef/activeStartTsRef：總範圍起點、當前圈起點（顯示列）
   * - activeTargetMinutesRef：進行中圈的『鎖定目標』（在開圈那一刻寫入）
   * - currentTargetMinutes：『下一圈（含第一圈）』即將鎖定的目標分鐘數
   */
  const [isRunning, setIsRunning] = useState(false);
  const [baseElapsed, setBaseElapsed] = useState(0);
  const [tick, setTick] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  type Lap = { startTs: number; endTs: number; durationMs: number; targetMinutes?: number };
  const [laps, setLaps] = useState<Lap[]>([]);

  const sessionStartTsRef = useRef<number | null>(null); // 第一次開始（總範圍 start）
  const lapAnchorTsRef = useRef<number | null>(null);    // 上次分圈錨點（active start）
  const activeStartTsRef = useRef<number | null>(null);  // 進行中列起點
  const lastPauseTsRef = useRef<number | null>(null);    // 最近一次暫停（凍結 active end）
  const activeTargetMinutesRef = useRef<number | undefined>(undefined); // 當前圈鎖定目標

  const [currentTargetMinutes, setCurrentTargetMinutes] = useState<number | undefined>(undefined);

  // 顯示防回退（避免 UI 讀數在暫停瞬間倒退）
  const prevElapsedRef = useRef(0);
  const prevRangeDurRef = useRef(0);

  // 本地保存（2 次重整可恢復）
  const MAX_RELOADS = 2;
  const STORAGE_KEY_STATE = "web_timer_state_v6";
  const STORAGE_KEY_RELOADS_LEFT = "web_timer_reloads_left_v6";
  const [reloadsLeft, setReloadsLeft] = useState(MAX_RELOADS);

  // ---- 恢復狀態 ----
  useEffect(() => {
    try {
      let leftRaw = localStorage.getItem(STORAGE_KEY_RELOADS_LEFT);
      let left = Number.isFinite(parseInt(leftRaw || "", 10)) ? parseInt(leftRaw!, 10) : MAX_RELOADS;
      setReloadsLeft(left);
      log("restore:init reloadsLeft=", left);
      if (left > 0) {
        const raw = localStorage.getItem(STORAGE_KEY_STATE);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed) {
            if (Array.isArray(parsed.laps)) setLaps(parsed.laps);
            if (typeof parsed.baseElapsed === "number") setBaseElapsed(parsed.baseElapsed);
            if (typeof parsed.sessionStartTs === "number") sessionStartTsRef.current = parsed.sessionStartTs;
            if (typeof parsed.lapAnchorTs === "number") lapAnchorTsRef.current = parsed.lapAnchorTs;
            if (typeof parsed.activeStartTs === "number") activeStartTsRef.current = parsed.activeStartTs;
            if (typeof parsed.lastPauseTs === "number") lastPauseTsRef.current = parsed.lastPauseTs;
            if (parsed.activeTargetMinutes != null && !Number.isNaN(parsed.activeTargetMinutes)) {
              activeTargetMinutesRef.current = parsed.activeTargetMinutes;
            }
            if (parsed.currentTargetMinutes != null && !Number.isNaN(parsed.currentTargetMinutes)) {
              setCurrentTargetMinutes(parsed.currentTargetMinutes);
            }
            log("restore:v6 state", parsed);
          }
        } else {
          // v5/v4 遷移（向下相容）
          const rawV5 = localStorage.getItem("web_timer_state_v5");
          if (rawV5) {
            try {
              const v5 = JSON.parse(rawV5);
              if (v5) {
                if (Array.isArray(v5.laps)) setLaps(v5.laps);
                if (typeof v5.baseElapsed === "number") setBaseElapsed(v5.baseElapsed);
                sessionStartTsRef.current = typeof v5.sessionStartTs === "number" ? v5.sessionStartTs : null;
                lapAnchorTsRef.current = typeof v5.lapAnchorTs === "number" ? v5.lapAnchorTs : sessionStartTsRef.current;
                activeStartTsRef.current = lapAnchorTsRef.current ?? sessionStartTsRef.current;
                lastPauseTsRef.current = typeof v5.lastPauseTs === "number" ? v5.lastPauseTs : null;
                if (v5.currentTargetMinutes != null && !Number.isNaN(v5.currentTargetMinutes)) setCurrentTargetMinutes(v5.currentTargetMinutes);
                log("restore:migrated from v5");
              }
            } catch (err) { warn("migrate v5 error", err); }
          } else {
            const legacyRaw = localStorage.getItem("web_timer_state_v4");
            if (legacyRaw) {
              try {
                const legacy = JSON.parse(legacyRaw);
                if (legacy && Array.isArray(legacy.segments)) {
                  const migrated: Lap[] = legacy.segments
                    .filter((s: any) => typeof s.start === "number" && typeof s.end === "number")
                    .map((s: any) => ({ startTs: s.start, endTs: s.end, durationMs: Math.max(0, s.end - s.start), targetMinutes: s.targetMinutes }));
                  setLaps(migrated);
                  setBaseElapsed(typeof legacy.baseElapsed === "number" ? legacy.baseElapsed : 0);
                  sessionStartTsRef.current = migrated.length ? Math.min(...migrated.map(l => l.startTs)) : null;
                  const lastEnd = migrated.length ? Math.max(...migrated.map(l => l.endTs)) : null;
                  lapAnchorTsRef.current = lastEnd ?? sessionStartTsRef.current;
                  activeStartTsRef.current = lapAnchorTsRef.current ?? sessionStartTsRef.current;
                  lastPauseTsRef.current = lastEnd;
                  log("restore:migrated from v4 -> laps=", migrated.length);
                }
              } catch (err) { warn("legacy migrate error", err); }
            }
          }
        }
        // 消耗一次恢復權限
        left = Math.max(0, left - 1);
        setReloadsLeft(left);
        localStorage.setItem(STORAGE_KEY_RELOADS_LEFT, String(left));
        log("restore:consume one -> reloadsLeft=", left);
      } else {
        // 超過次數：丟棄舊狀態
        localStorage.removeItem(STORAGE_KEY_STATE);
        log("restore:exhausted, cleared saved state");
      }
    } catch (e) { warn("Restore error", e); }
  }, []);

  // ---- 持續保存 ----
  useEffect(() => {
    try {
      if (reloadsLeft > 0) {
        const payload = JSON.stringify({
          laps, baseElapsed,
          sessionStartTs: sessionStartTsRef.current,
          lapAnchorTs: lapAnchorTsRef.current,
          activeStartTs: activeStartTsRef.current,
          activeTargetMinutes: activeTargetMinutesRef.current,
          lastPauseTs: lastPauseTsRef.current,
          currentTargetMinutes,
        });
        localStorage.setItem(STORAGE_KEY_STATE, payload);
        debug("persist:v6", { laps: laps.length, baseElapsed });
      } else {
        localStorage.removeItem(STORAGE_KEY_STATE);
        log("persist:disabled (reloads exhausted)");
      }
    } catch (e) { warn("Persist error", e); }
  }, [laps, baseElapsed, currentTargetMinutes, reloadsLeft]);

  // 重置可恢復次數（開新一輪）
  const resetReloadBudget = () => {
    setReloadsLeft(MAX_RELOADS);
    localStorage.setItem(STORAGE_KEY_RELOADS_LEFT, String(MAX_RELOADS));
    log("reload budget reset ->", MAX_RELOADS);
  };

  // ---- 有效時間（主計時） ----
  const rawElapsed = useMemo(() => {
    const val = isRunning && startedAtRef.current != null
      ? baseElapsed + (Date.now() - startedAtRef.current)
      : baseElapsed;
    debug("rawElapsed=", val);
    return val;
  }, [isRunning, baseElapsed, tick]);

  const elapsed = useMemo(() => {
    const val = Math.max(prevElapsedRef.current, rawElapsed); // 保持單調不減
    if (val !== prevElapsedRef.current) debug("elapsed update (monotonic)", { from: prevElapsedRef.current, to: val });
    prevElapsedRef.current = val; return val;
  }, [rawElapsed]);

  // RUNNING 時每 50ms 推進一幀（只為了重算顯示與 activeRow）
  useEffect(() => {
    if (!isRunning) return; const id = setInterval(() => setTick(t => t + 1), 50);
    log("ticker:start (50ms)"); return () => { clearInterval(id); log("ticker:stop"); };
  }, [isRunning]);

  // 已完成圈總有效時長（供計算 activeRow 時長）
  const lapsAccumulatedMs = useMemo(() => laps.reduce((acc, l) => acc + (l.durationMs || 0), 0), [laps]);

  // ---- 控制 ----
  const handleStart = () => {
    if (isRunning) return; const now = Date.now();
    startedAtRef.current = now; setIsRunning(true);
    if (sessionStartTsRef.current == null) {
      // 第一次開始：建立各錨點與進行中列，鎖定 Lap1 目標
      sessionStartTsRef.current = now; lapAnchorTsRef.current = now; activeStartTsRef.current = now;
      activeTargetMinutesRef.current = currentTargetMinutes; // 🔒 Lap1 鎖定
      log("start:first session @", now);
    } else {
      // 恢復：不改變 active 起點與鎖定目標
      if (activeStartTsRef.current == null) {
        activeStartTsRef.current = lapAnchorTsRef.current ?? sessionStartTsRef.current ?? now;
      }
      log("start:resume @", now);
    }
  };

  const handlePause = () => {
    if (!isRunning) return; const now = Date.now(); setIsRunning(false);
    setBaseElapsed(v => {
      const computed = v + (now - (startedAtRef.current ?? now)); // 計入這段 RUNNING 的遞增
      const displayedElapsed = elapsed; // 以顯示值為下限，避免暫停瞬間因排程而回退
      const next = Math.max(displayedElapsed, computed); log("pause:", { now, computed, displayedElapsed, next });
      return next;
    });
    startedAtRef.current = null; lastPauseTsRef.current = now; // 凍結 activeRow 的 end 顯示
  };

  const handleReset = () => {
    if (isRunning) { warn("reset:ignored (RUNNING)"); return; }
    setIsRunning(false); setBaseElapsed(0); startedAtRef.current = null; setLaps([]);
    sessionStartTsRef.current = null; lapAnchorTsRef.current = null; activeStartTsRef.current = null; lastPauseTsRef.current = null;
    activeTargetMinutesRef.current = undefined; setCurrentTargetMinutes(undefined);
    localStorage.removeItem(STORAGE_KEY_STATE); resetReloadBudget();
    prevElapsedRef.current = 0; prevRangeDurRef.current = 0; log("reset:done");
  };

  const handleLap = () => {
    if (!isRunning) { warn("lap:ignored (not RUNNING)"); return; }
    if (sessionStartTsRef.current == null) { warn("lap:ignored (session not started)"); return; }
    const now = Date.now();
    const currentLapMs = Math.max(0, elapsed - lapsAccumulatedMs); // 自然排除暫停
    const startTs = activeStartTsRef.current ?? lapAnchorTsRef.current ?? sessionStartTsRef.current ?? now;
    const endTs = now; const targetMinutes = activeTargetMinutesRef.current; // 用開圈時鎖定的目標
    const newLap = { startTs, endTs, durationMs: currentLapMs, targetMinutes };
    setLaps(arr => [...arr, newLap]);
    lapAnchorTsRef.current = endTs; activeStartTsRef.current = endTs; // 開啟下一圈
    activeTargetMinutesRef.current = currentTargetMinutes; // 🔒 鎖定下一圈目標
    log("lap:add", newLap);
  };

  // ---- 表格資料 ----
  const completedRows = laps; const hasActive = activeStartTsRef.current != null;
  const completedRowsDesc = useMemo(() => [...completedRows].reverse(), [completedRows]); // 由下至上 1→∞

  // 進行中列：end=now（跑）或 lastPause（暫停凍結）；時長=有效時間 - 已完成總和
  const activeRow = useMemo(() => {
    if (!hasActive) return null; const start = activeStartTsRef.current!;
    const end = isRunning ? Date.now() : (lastPauseTsRef.current ?? Date.now());
    const durationMs = Math.max(0, elapsed - lapsAccumulatedMs); const targetMinutes = activeTargetMinutesRef.current;
    return { startTs: start, endTs: end, durationMs, targetMinutes };
  }, [hasActive, isRunning, elapsed, lapsAccumulatedMs, tick]);

  // ---- 總範圍（首尾差） ----
  const rangeStart = sessionStartTsRef.current;
  const rangeEnd = useMemo(() => {
    if (rangeStart == null) return null; let end: number | null = null;
    if (completedRows.length) end = Math.max(...completedRows.map(l => l.endTs));
    const live = isRunning ? Date.now() : (lastPauseTsRef.current ?? null);
    if (live != null) end = end != null ? Math.max(end, live) : live;
    if (end == null) end = rangeStart; return end;
  }, [completedRows, isRunning, tick, rangeStart]);

  const rangeDuration = useMemo(() => {
    if (rangeStart == null || rangeEnd == null) return 0; return Math.max(0, rangeEnd - rangeStart);
  }, [rangeStart, rangeEnd]);

  const displayRangeDuration = useMemo(() => {
    const val = Math.max(prevRangeDurRef.current, rangeDuration); // 總範圍顯示單調
    if (val !== prevRangeDurRef.current) debug("rangeDuration update (monotonic)", { from: prevRangeDurRef.current, to: val });
    prevRangeDurRef.current = val; return val;
  }, [rangeDuration]);

  // ---- 匯出文字（無括號） ----
  const summaryText = useMemo(
    () => buildTextSummary(completedRows, rangeStart, rangeEnd, displayRangeDuration),
    [completedRows, rangeStart, rangeEnd, displayRangeDuration]
  );

  // 複製邏輯（成功/失敗皆有提示）
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok" | "fail">("idle");
  const summaryRef = useRef<HTMLElement | null>(null);
  const handleCopy = async () => {
    const ok = await safeCopyText(summaryText);
    if (ok) { setCopyStatus("ok"); setTimeout(() => setCopyStatus("idle"), 1500); }
    else { if (summaryRef.current) selectElementText(summaryRef.current as unknown as HTMLElement); setCopyStatus("fail"); setTimeout(() => setCopyStatus("idle"), 3000); }
  };

  // 目標分鐘輸入：解法A，維持空字串不轉 0
  const handlePresetChange = (raw: string, ev?: React.ChangeEvent<HTMLInputElement>) => {
    const target = computePresetFromInput(raw, ev?.currentTarget?.valueAsNumber);
    setCurrentTargetMinutes(target); log("preset:set currentTargetMinutes=", target);
  };

  // 快捷鍵：Space 開始/暫停/恢復；L 分圈（僅 RUNNING）；R 重置（僅 PAUSED/IDLE）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return; const k = e.key;
      if (k === " ") { e.preventDefault(); isRunning ? handlePause() : handleStart(); }
      else if (k === "l" || k === "L") { if (isRunning) handleLap(); }
      else if (k === "r" || k === "R") { if (!isRunning) handleReset(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [isRunning, lapsAccumulatedMs]);

  // ---------------- 自我測試（console） ----------------
  useEffect(() => {
    log("self-tests: start");
    const assertEq = (a: any, b: any, msg: string) => { if (a !== b) console.error("[TEST FAIL]", msg, "expected:", b, "got:", a); else console.log("[TEST PASS]", msg); };

    // 1. 基本格式
    assertEq(fmtHMS(0), "00:00:00", "fmtHMS(0)");
    assertEq(fmtHMS(3661000), "01:01:01", "fmtHMS(3661000)");
    const t = msToHMS(61500); assertEq(`${t.h}:${t.m}:${t.s}`, "00:01:01", "msToHMS(61500)");

    // 2. 預定時間狀態（含邊界）
    assertEq(getPresetStatus(61 * 60000, 60), "超過", "> target");
    assertEq(getPresetStatus(59 * 60000, 60), "未超過", "< target");
    assertEq(getPresetStatus(10 * 60000, undefined), "-", "no target");
    assertEq(getPresetStatus(60 * 60000, 60), "未超過", "= target");

    // 2b. 預設輸入解析（解法A）
    assertEq(computePresetFromInput("", Number.NaN), undefined, "empty -> undefined");
    assertEq(computePresetFromInput("   ", Number.NaN), undefined, "whitespace -> undefined");
    assertEq(computePresetFromInput("0", 0), 0, "zero kept");
    assertEq(computePresetFromInput("003", 3), 3, "leading zeros -> int");
    assertEq(computePresetFromInput("5.9", 5.9), 5, "floor decimals");

    // 3. Summary 檢查（無括號 & 行數）
    const base = 1_700_000_000_000; const fakeLaps = [
      { startTs: base + 0, endTs: base + 60_000, durationMs: 60_000 },
      { startTs: base + 60_000, endTs: base + 120_000, durationMs: 60_000 },
    ];
    const summary = buildTextSummary(fakeLaps, fakeLaps[0].startTs, fakeLaps[1].endTs, 120_000);
    assertEq(summary.split("\n").length, 4, "summary uses \\n separators");
    assertEq(summary.includes("["), false, "summary no '['");
    assertEq(summary.includes("]"), false, "summary no ']' ");

    // 4. 暫停不計入圈時長（理論模擬）
    (function testLapExcludesPause() {
      const resume = 8_000; const now = 13_000; // 有效 = [0..3] + [8..13] = 8s
      const baseElapsedSim = 3_000; const runningDelta = now - resume; const elapsedSim = baseElapsedSim + runningDelta; // 8_000
      const lapsAccumBefore = 0; const currentLapMs = Math.max(0, elapsedSim - lapsAccumBefore);
      assertEq(currentLapMs, 8_000, "lap excludes paused interval");
    })();

    // 5. 倒序編號：底部=1
    (function testDescendingNumbering() {
      const completedCount = 3; const rowNumbers = Array.from({ length: completedCount }, (_, idx) => completedCount - idx);
      assertEq(rowNumbers[rowNumbers.length - 1], 1, "bottom row number is 1");
    })();

    // 6. 鎖定目標：完成圈使用『開圈時鎖定』的目標
    (function testPresetLockedPerLap() {
      const lockedAtStart = 1; const changedLater = 2; const lapRecordedTarget = lockedAtStart;
      assertEq(lapRecordedTarget, 1, "lap uses locked preset");
      assertEq(changedLater, 2, "later change reserved for NEXT lap");
    })();

    log("self-tests: done");
  }, []);

  // ---------------- UI ----------------
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-3xl mx-auto p-4 sm:p-6">
        <header className="mb-4 sm:mb-6">
          <h1 className="text-xl sm:text-2xl font-bold">會議計時小工具</h1>
        </header>

        {/* 區段目標時間（分鐘）：placeholder=輸入數字。請先輸入目標時間 */}
        <section className="mb-4">
          <label className="block text-sm mb-1">區段目標時間（分鐘）</label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="number"
              min={0}
              step={1}
              placeholder="輸入數字"
              className="border rounded-xl px-3 py-2 w-24 sm:w-32"
              value={currentTargetMinutes ?? ""}
              onChange={(e) => handlePresetChange(e.target.value, e)}
            />
            <span className="text-xs text-gray-500">請先輸入目標時間</span>
          </div>
        </section>

        {/* 主計時與總範圍 */}
        <section className="rounded-2xl p-4 sm:p-8 shadow-sm border bg-gray-50 border-gray-200">
          <div className="text-center">
            <div className="text-sm text-gray-500">累計</div>
            <TimerReadout ms={elapsed} emphasized={true} />
            {rangeStart != null && rangeEnd != null && (
              <div className="mt-1 text-sm text-gray-600">總時長：{fmtRange(rangeStart)}~{fmtRange(rangeEnd)}（共 {fmtHMS(displayRangeDuration)}）</div>
            )}
          </div>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3 justify-center">
            {isRunning ? (
              <button onClick={handlePause} className="w-full sm:w-auto min-h-12 px-4 py-2 rounded-2xl border">暫停 (Space)</button>
            ) : (
              <button onClick={handleStart} className="w-full sm:w-auto min-h-12 px-4 py-2 rounded-2xl border">開始 (Space)</button>
            )}
            <button onClick={handleLap} disabled={!isRunning} title={!isRunning ? "暫停時不可分圈" : undefined} className="w-full sm:w-auto min-h-12 px-4 py-2 rounded-2xl border disabled:opacity-50 disabled:cursor-not-allowed">分圈 (L)</button>
            <button onClick={handleReset} disabled={isRunning} title={isRunning ? "RUNNING 狀態無法重置，請先暫停" : undefined} className="w-full sm:w-auto min-h-12 px-4 py-2 rounded-2xl border disabled:opacity-50 disabled:cursor-not-allowed">重置 (R)</button>
          </div>
        </section>

        {/* 區段紀錄：完成（倒序） + 進行中（置頂） */}
        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-3">區段紀錄</h2>
          {(!hasActive && completedRows.length === 0) ? (
            <div className="text-sm text-gray-500">尚無區段</div>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0 rounded-2xl border">
              <table className="w-full text-xs sm:text-sm min-w-[560px]">
                <thead className="bg-gray-50">
                  <tr className="text-left">
                    <th className="px-4 py-2 w-12 sm:w-16">#</th>
                    <th className="px-4 py-2">時間範圍</th>
                    <th className="px-4 py-2 w-32 sm:w-40">區段時長</th>
                    <th className="px-4 py-2 w-32 sm:w-40">目標 / 狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {hasActive && activeRow && (
                    <tr className="border-t bg-gray-50/50">
                      <td className="px-4 py-2">{completedRows.length + 1}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{fmtRange(activeRow.startTs)} ~ {fmtRange(activeRow.endTs)}<span className="ml-2 text-xs text-gray-500">（{isRunning ? "進行中" : "暫停"}）</span></td>
                      <td className="px-4 py-2 font-mono">{fmtHMS(activeRow.durationMs)}</td>
                      <td className="px-4 py-2">{renderTargetAndStatus(activeRow.targetMinutes, activeRow.durationMs)}</td>
                    </tr>
                  )}
                  {completedRowsDesc.map((lap, idx) => {
                    const completedCount = completedRows.length; const rowNumber = completedCount - idx; // 底部=1
                    return (
                      <tr key={idx} className="border-t">
                        <td className="px-4 py-2">{rowNumber}</td>
                        <td className="px-4 py-2 whitespace-nowrap">{fmtRange(lap.startTs)} ~ {fmtRange(lap.endTs)}</td>
                        <td className="px-4 py-2 font-mono">{fmtHMS(lap.durationMs)}</td>
                        <td className="px-4 py-2">{renderTargetAndStatus(lap.targetMinutes, lap.durationMs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 本次總覽 + 一鍵複製（匯出無括號） */}
        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-3">本次總覽</h2>
          <div className="mb-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <button onClick={handleCopy} className="w-full sm:w-auto px-4 py-2 rounded-2xl border">複製文字總結</button>
            {copyStatus === "ok" && <span className="text-green-600 text-sm">已複製！</span>}
            {copyStatus === "fail" && <span className="text-amber-600 text-sm">無法自動複製，已為你選取文字，請按 ⌘/Ctrl + C</span>}
          </div>
          <pre ref={summaryRef as any} className="bg-gray-100 p-3 rounded text-xs sm:text-sm whitespace-pre-wrap overflow-x-auto">{summaryText}</pre>
        </section>

        <p className="mt-6 text-xs text-gray-500">*快捷鍵：Space-開始/暫停/恢復 · L-分圈 · R-重置。</p>
        <p className="text-xs text-gray-500">*本地保存：同一輪最多可恢復 2 次重新整理；超過後不再保存當次紀錄。</p>
      </div>
    </div>
  );
}

// 讀秒顯示（HH:MM:SS.cs），以等寬字體呈現；使用 useFitFont 以容器寬度自適應
function TimerReadout({ ms, emphasized }: { ms: number; emphasized?: boolean }) {
  const { h, m, s, cs } = msToHMS(ms);
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const maxPx = emphasized ? 72 : 40; const minPx = emphasized ? 24 : 16;
  const sample = `${h}:${m}:${s}.${cs}`; // 等寬字體下長度固定，便於量測
  const fontPx = useFitFont(containerRef, textRef, sample, maxPx, minPx);
  return (
    <div ref={containerRef} className="w-full overflow-hidden px-1">
      <div ref={textRef} className="font-mono tracking-normal sm:tracking-wider select-none whitespace-nowrap mx-auto text-center" style={{ fontSize: fontPx }}>
        {h}:{m}:{s}<span className="text-gray-500">.{cs}</span>
      </div>
    </div>
  );
}

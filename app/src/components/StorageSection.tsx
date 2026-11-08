import { CatalogTransition } from "./CatalogTransition";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Block, Btn, Group, ListItem } from "./ui";
import { askConfirm } from "../lib/webDialog";
import { t } from "../i18n/t";
import { Ring, Pager, useDir } from "../trm";
import { listText } from "../lib/text";

type Usage = {
  items: { name: string; bytes: number }[];
  total_bytes: number;
  free_bytes: number | null;
};

type Row = {
  exp: string;
  total_bytes: number;
  kinds: Record<string, { files: number; bytes: number }>;
};

/** 类别 → 文案与后果。后果必须写在勾选框旁边，不能只在确认框里说一次。 */
const KINDS = [
  { id: "snapshots", labelKey: "s.cleanupSnapshots", effectKey: "s.cleanupEffectNone" },
  { id: "checkpoints", labelKey: "s.cleanupCheckpoints", effectKey: "s.cleanupEffectNoResume" },
  { id: "dataset", labelKey: "s.cleanupDataset", effectKey: "s.cleanupEffectRestart" },
] as const;

const USAGE_LABEL: Record<string, string> = {
  characters: "storage.characters", training: "storage.training",
  outputs: "storage.outputs", runtime: "storage.runtime",
  pretrained: "storage.pretrained", separation: "storage.separation",
  cache: "storage.cache", other: "storage.other",
};

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 各实验分别勾选清理类别，由列表底部统一执行。 */
export function StorageSection() {
  const request = useRef(0);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  // 实验一多（每个三四个 GB 的主儿），一整列铺下去「其他」页就成了账本。
  // 每页五个，按占用从大到小排 —— 最该处理的永远在第一页。
  const PAGE_SIZE = 5;
  const [page, setPage] = useState(1);

  const sorted = useMemo(
    () =>
      (rows ?? [])
        .slice()
        .sort((a, b) => b.total_bytes - a.total_bytes),
    [rows],
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageDir = useDir(pageClamped);
  const pageRows = sorted.slice(
    (pageClamped - 1) * PAGE_SIZE,
    pageClamped * PAGE_SIZE,
  );

  const scan = async (resetSelection = true) => {
    const current = ++request.current;
    setBusy(true);
    setMsg("");
    const [u, r] = await Promise.allSettled([
      invoke<Usage>("storage_usage"), invoke<Row[]>("train_cleanup_scan"),
    ]);
    if (current !== request.current) return "";
    if (u.status === "fulfilled") setUsage(u.value);
    if (r.status === "fulfilled") {
      setRows(Array.isArray(r.value) ? r.value : []);
      if (resetSelection) setPicked({});
      setPage(1);
    }
    const failure = [u, r].find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setMsg(String(failure.reason));
    setBusy(false);
    return failure?.status === "rejected" ? String(failure.reason) : "";
  };

  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) void scan();
    const counter = request;
    return () => { counter.current++; };
  }, []);

  const toggle = (exp: string, kind: string) => {
    setPicked((prev) => {
      const next = { ...prev };
      const set = new Set(next[exp] ?? []);
      if (set.has(kind)) set.delete(kind);
      else set.add(kind);
      next[exp] = set;
      return next;
    });
  };

  const selected = sorted.map(row => ({
    exp: row.exp,
    kinds: KINDS.filter(kind => picked[row.exp]?.has(kind.id) && (row.kinds[kind.id]?.bytes ?? 0) > 0).map(kind => kind.id),
  })).filter(row => row.kinds.length > 0);
  const pickedCount = selected.reduce((count, row) => count + row.kinds.length, 0);
  const pickedBytes = selected.reduce((bytes, row) => bytes + row.kinds.reduce(
    (sum, kind) => sum + (rows?.find(item => item.exp === row.exp)?.kinds[kind]?.bytes ?? 0), 0), 0);

  const apply = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    const names = selected.map(row => row.exp + "（" + listText(row.kinds.map(kind => t(KINDS.find(item => item.id === kind)!.labelKey))) + "）");
    try {
      if (!(await askConfirm(t("s.cleanConfirm", { list: listText(names) })))) return;
      let freed = 0;
      let error = "";
      try {
        for (const row of selected) {
          const result = await invoke<{ freed_bytes?: number }>("train_cleanup_apply", row);
          freed += result?.freed_bytes ?? 0;
          setPicked(prev => ({ ...prev, [row.exp]: new Set() }));
        }
      } catch (e) { error = String(e); }
      const scanError = await scan(false);
      setMsg([
        !error || freed > 0 ? t("s.cleanupDone", { v0: human(freed) }) : "",
        error,
        scanError,
      ].filter(Boolean).join("\n"));
    } finally { setBusy(false); }
  };

  return (
    <Block title={t("s.storageTitle")} action={
      <Btn onClick={() => void scan()} busy={busy}>{t("s.storageScan")}</Btn>
    }>
      <Group>
        {msg ? <p role="status" className="px-4 pt-3 m-0 text-[12.5px] text-[var(--help)]">{msg}</p> : null}
        {usage ? (
          <div className="px-4 py-4">
            <Ring center={human(usage.total_bytes)}
              segments={usage.items.map((item, index) => ({
                id: item.name, label: t(USAGE_LABEL[item.name] ?? "storage.other"),
                value: item.bytes, note: human(item.bytes),
                color: `var(--storage-${index + 1}, var(--accent))`,
              })).filter((item) => item.value > 0)} />
            <p className="m-0 mt-3 text-[12px] text-[var(--meta)]">
              {t("storage.free", { size: usage.free_bytes == null ? t("s.valueUnknown") : human(usage.free_bytes) })}
            </p>
          </div>
        ) : <p className="m-0 px-4 py-3 text-[12.5px] text-[var(--help)]">{busy ? t("s.valueLoading") : t("s.cleanupDesc")}</p>}
        {rows && rows.length === 0 ? (
          <ListItem title={t("s.cleanupTitle")} desc={t("s.cleanupNothing")} />
        ) : null}
        {rows && rows.length ? (
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <p className="m-0 text-[12.5px] text-[var(--ink-muted)]">
                {t("s.cleanupTitle")}
              </p>
              <span className="font-mono text-[11.5px] text-[var(--meta)] tabular-nums">
                {t("s.pageOf", { cur: pageClamped, total: totalPages })}
              </span>
            </div>
            <p className="m-0 mb-3 text-[12px] text-[var(--meta)] leading-relaxed">
              {t("s.cleanupDesc")}
            </p>
            <CatalogTransition scope="storage" page={pageClamped} dir={pageDir || 1}>
            <ul className="m-0 list-none p-0">
              {pageRows.map((row, i) => (
                <li key={row.exp} className="relative py-3 first:pt-0">
                  {i > 0 ? (
                    <div
                      aria-hidden
                      className="absolute top-0 left-0 right-0 h-px bg-[var(--hairline)]"
                    />
                  ) : null}
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-semibold">{row.exp}</span>
                    <span className="font-mono text-[11.5px] text-[var(--meta)] tabular-nums">
                      {human(row.total_bytes)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {KINDS.map((k) => {
                      const info = row.kinds[k.id];
                      const empty = !info || info.bytes === 0;
                      return (
                        <label
                          key={k.id}
                          className={
                            "flex items-center gap-2 text-[12.5px] " +
                            (empty ? "opacity-45" : "cursor-pointer")
                          }
                        >
                          <input
                            type="checkbox"
                            disabled={empty || busy}
                            checked={picked[row.exp]?.has(k.id) ?? false}
                            onChange={() => toggle(row.exp, k.id)}
                            className="accent-[var(--accent)]"
                          />
                          <span>{t(k.labelKey)}</span>
                          <span className="font-mono text-[11px] text-[var(--meta)] tabular-nums">
                            {human(info?.bytes ?? 0)}
                          </span>
                          {/* 后果写在勾选框旁边，不是只在确认框里说一次。 */}
                          <span className="text-[11.5px] text-[var(--meta)]">
                            {t(k.effectKey)}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                </li>
              ))}
            </ul>
            </CatalogTransition>
            <Pager page={pageClamped} pages={totalPages} onChange={setPage} />
            <div className="mt-3 pt-3 flex flex-wrap items-center gap-3 shadow-[0_-1px_0_var(--hairline)]">
              <span className="text-[12.5px] text-[var(--meta)]" role="status">
                {pickedCount ? t("s.cleanPicked", { n: pickedCount, size: human(pickedBytes) }) : t("s.cleanNonePicked")}
              </span>
              <span className="ml-auto">
                <Btn primary onClick={() => void apply()} busy={busy} disabled={busy || pickedCount === 0}>
                  {t("s.cleanupApply")}
                </Btn>
              </span>
            </div>
          </div>
        ) : null}
      </Group>
    </Block>
  );
}

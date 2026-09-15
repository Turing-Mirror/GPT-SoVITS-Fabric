/**
 * 错误码 → 一个能动手的按钮。
 *
 * 报错说清楚了「哪里不对」还不够。「缺少底模」这句话对着一个不知道底模在哪的
 * 用户，和「加载模型失败」没有本质区别 —— 他仍然只能来群里问一句「怎么办」。
 *
 * 这张表只登记**当前进程就能完成、且有明确成功反馈**的动作。做不到的宁可不
 * 登记：一个点下去什么都没发生的按钮，比没有按钮更伤。
 */
import { invoke } from "@tauri-apps/api/core";
import { openDownloadModels } from "./downloadModels";
import type { ExtrasFilter } from "../components/ExtrasDialog";
import { t } from "../i18n/t";

type Action = {
  /** 按钮文案的语言包 key。 */
  labelKey: string;
  run: () => void;
};

/** 去主窗口广场的下载区，带上分组筛选。工具窗里也管用（会把主窗口叫到前面）。 */
function toDownloads(reason: string, filter: ExtrasFilter): () => void {
  return () => openDownloadModels({ reason, filter });
}

/** 跳到说明页对应段。 */
function toHelp(section: string): () => void {
  return () => {
    void invoke("tools_open_help", { section }).catch(() => {});
  };
}

const CODE_ACTIONS: Record<string, Action> = {
  // 引擎底模缺件：都住在广场的「下载模型」区，引擎资源那组就在最上面，
  // 不带筛选词。
  "train.bert_missing": {
    labelKey: "s.errActDownload",
    run: toDownloads("train.bert_missing", "all"),
  },
  "train.hubert_missing": {
    labelKey: "s.errActDownload",
    run: toDownloads("train.hubert_missing", "all"),
  },
  "train.pretrained_missing": {
    labelKey: "s.errActDownload",
    run: toDownloads("train.pretrained_missing", "all"),
  },
  "train.sv_missing": {
    labelKey: "s.errActDownload",
    run: toDownloads("train.sv_missing", "all"),
  },
  // 数据集与转写类问题：答案在说明页「训练音色」段，跳过去直接展开。
  "train.no_asr": {
    labelKey: "s.errActHelp",
    run: toHelp("train"),
  },
  "train.dataset_missing": {
    labelKey: "s.errActHelp",
    run: toHelp("train"),
  },
  "train.list_empty": {
    labelKey: "s.errActHelp",
    run: toHelp("train"),
  },
  "train.wav_missing": {
    labelKey: "s.errActHelp",
    run: toHelp("train"),
  },
  "train.no_transcript": {
    labelKey: "s.errActHelp",
    run: toHelp("train"),
  },
  // 显存不足的答案在说明页常见情况里，深链直接展开那一条。
  "train.oom": {
    labelKey: "s.errActHelp",
    run: toHelp("faq#s.faqVramQ"),
  },
};

/** 这个错误码有没有配一个能按的按钮。 */
export function actionFor(code: string | undefined | null): { label: string; run: () => void } | null {
  if (!code) return null;
  const a = CODE_ACTIONS[code];
  if (!a) return null;
  return { label: t(a.labelKey), run: a.run };
}

/** 测试用：表里登记了哪些码。 */
export function actionCodes(): string[] {
  return Object.keys(CODE_ACTIONS);
}

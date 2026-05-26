/**
 * Default routine templates — the cold-start fix for the new-tab page.
 *
 * A fresh install has no cron jobs, so the new-tab page is empty. These
 * templates give the user one-click starting points: install one and
 * Hermes starts producing scheduled runs whose markdown lands on the
 * new-tab page. Meant to be edited afterwards (Settings → Cron), not
 * treated as fixed.
 *
 * Every template delivers ``local`` — output stays on disk; no external
 * delivery.
 */

import {
  createHermesCronJob,
  getHermesCronJobs,
  type HermesCronJob,
} from "../hermes-cron";

export interface RoutineTemplate {
  /** Stable slug — also used (via `name`) to detect "already installed". */
  id: string;
  /** Becomes the cron job name; the installed-check matches on it. */
  name: string;
  emoji: string;
  /** One-line "what this does" for the launcher UI. */
  description: string;
  /** Hermes schedule string. */
  schedule: string;
  /** Human-readable cadence for the UI. */
  scheduleLabel: string;
  /** The cron prompt. The bridge appends the Hermes Card protocol. */
  prompt: string;
  enabledToolsets: string[];
}

export const DEFAULT_ROUTINES: RoutineTemplate[] = [
  {
    id: "daily-briefing",
    name: "Daily briefing",
    emoji: "☀️",
    description: "Every morning — today's calendar, tasks, and follow-ups",
    schedule: "0 8 * * *",
    scheduleLabel: "Every day at 8:00 AM",
    enabledToolsets: ["terminal", "search"],
    prompt: [
      "你是用户的私人助理,这是每天早上的例行简报任务。",
      "",
      "基于你能访问到的信息,为用户整理一份简短的「今日提要」:",
      "- 如果能访问飞书日历:今天有哪些会议/日程,按时间列出,标出需要提前准备的",
      "- 如果能访问飞书任务:有哪些待办、哪些今天到期、哪些已逾期",
      "- 如果能拿到最近的会议纪要:有没有指派给用户、需要今天跟进的事项",
      "",
      "如果上述都拿不到,就基于近期上下文给一句务实的当天聚焦建议。",
      "保持简短、具体。今天确实很轻松的话,如实说即可,不要硬凑内容。",
    ].join("\n"),
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    emoji: "📋",
    description: "Mondays — last week's progress and this week's priorities",
    schedule: "0 9 * * 1",
    scheduleLabel: "Mondays at 9:00 AM",
    enabledToolsets: ["terminal", "search"],
    prompt: [
      "你是用户的私人助理,这是每周一早上的回顾任务。",
      "",
      "回顾过去一周(从飞书任务、会议纪要、近期对话能看到的范围):",
      "- 完成了哪些重要的事",
      "- 有哪些还悬而未决、需要这周推进的",
      "- 给用户一到两条这周值得优先关注的建议",
      "",
      "要有洞察,不要写成流水账。没有明显进展时,如实说即可。",
    ].join("\n"),
  },
  {
    id: "mail-triage",
    name: "Mail triage",
    emoji: "📨",
    description: "Weekday evenings — scan Feishu mail for things to reply to",
    schedule: "0 18 * * 1-5",
    scheduleLabel: "Weekdays at 6:00 PM",
    enabledToolsets: ["terminal", "search"],
    prompt: [
      "你是用户的私人助理,这是工作日傍晚的邮件速览任务。",
      "",
      "如果能访问飞书邮箱:扫一遍今天的邮件,挑出真正需要用户回复或处理的",
      "(忽略通知类、订阅类的噪音)。每封简述一句:谁发的、要什么、紧不紧急。",
      "",
      "如果邮箱访问不可用,直接说明无法访问即可,不要编造。",
      "今天没有需要处理的邮件时,如实说一句「今天邮箱没有要紧的」即可。",
    ].join("\n"),
  },
];

/**
 * Match installed cron jobs against the templates by name. Returns the
 * set of template ids that already have a job — the launcher uses this
 * to render those as "enabled" instead of installable.
 */
export async function getInstalledRoutineIds(): Promise<Set<string>> {
  const installed = new Set<string>();
  try {
    const res = await getHermesCronJobs();
    if (!res.ok) return installed;
    const byName = new Map<string, HermesCronJob>();
    for (const job of res.jobs) byName.set(job.name, job);
    for (const t of DEFAULT_ROUTINES) {
      if (byName.has(t.name)) installed.add(t.id);
    }
  } catch {
    // Bridge offline — treat everything as not-installed; the launcher
    // will surface the create error if the user actually clicks.
  }
  return installed;
}

export interface InstallRoutineResult {
  ok: boolean;
  error?: string;
}

/** Create a cron job from a template. Delivers `local` so the output
 *  stays on disk for the new-tab page to read. */
export async function installRoutine(
  template: RoutineTemplate,
): Promise<InstallRoutineResult> {
  const res = await createHermesCronJob({
    name: template.name,
    prompt: template.prompt,
    schedule: template.schedule,
    deliver: "local",
    enabled_toolsets: template.enabledToolsets,
  });
  if (!res.ok) {
    return { ok: false, error: res.error || "Failed to create cron job" };
  }
  return { ok: true };
}

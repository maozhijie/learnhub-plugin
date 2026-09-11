/**
 * 命令注册表·实验室域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'

export const 实验室域 = {
  'experiment-apply': command({
    id: "experiment-apply",
    summary: "Confirm and start a pending N-of-1 experiment proposal (D-1, proposal-confirmation flow, step 2): re-validates the artifact against the template whitelist, builds the assignment (batch templates alternate arms by learning day starting today; card-level templates get a seeded deterministic split), writes the experiment definition, and reports today's arm. Fails loud if another experiment is already running or the artifact fails re-validation.",
    args: {
      id: { type: "number", description: "Proposal id; omit for the newest pending experiment proposal" }
    },
    engine: "lab.experimentApply",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_experiment_apply",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/experiments/apply" }
      }
    ]
  }),
  'experiment-propose': command({
    id: "experiment-propose",
    summary: "Propose an N-of-1 experiment from a preset template (D-1, proposal-confirmation flow, step 1): validates the template is unlocked and no experiment is running (v1 runs one at a time), previews the eligible card pool (scheduled, non-archived bank questions), and files a pending experiment proposal for the learner to confirm. Whitelist enforcement is structural: only template ids resolve; unknown ids and non-whitelist parameters fail loud. Never starts anything by itself.",
    args: {
      template: { type: "string", description: "Template id from learnhub_experiment_templates", required: true },
      course: { type: "string", description: "Scope the experiment to one course; omit for all enabled courses" }
    },
    engine: "lab.experimentPropose",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_experiment_propose",
        bind: ["template", "course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/experiments/propose" },
        bind: ["template", "course"]
      }
    ]
  }),
  'experiment-report': command({
    id: "experiment-report",
    summary: "Get the plain-language N-of-1 report (D-1, ADR-0023): arm-by-arm true retention, arm difference, 95% bootstrap interval, and a permutation test — phrased as an individual effect, never a population claim. Below the minimum observation window (per-arm real-advance minimum) it reports progress only and refuses to judge. running = interim reading; stopped = final.",
    args: {
      id: { type: "number", description: "Experiment id; omit for the running (or latest) one" }
    },
    engine: "lab.experimentReport",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_experiment_report",
        bind: ["id"]
      }
    ]
  }),
  'experiment-stop': command({
    id: "experiment-stop",
    summary: "Stop a running N-of-1 experiment (start/stop is always manual, ADR-0023): annotations cease, the report becomes final. Omit id to stop the currently running experiment.",
    args: {
      id: { type: "number", description: "Experiment id; omit for the running one" }
    },
    engine: "lab.experimentStop",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_experiment_stop",
        bind: ["id"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/experiments/stop" }
      }
    ]
  }),
  'experiment-templates': command({
    id: "experiment-templates",
    summary: "List the N-of-1 experiment template library (D-1, ADR-0023): preset self-experiments on engine-controlled content/design parameters only (scheduling core is NEVER an experiment variable). Each template carries id/title/question/arms/unit/description and an unlocked flag — unlocked=false templates are visible but cannot be started yet. Zero XP, never touches Mastery; arm labels go into the review log for attribution. Propose with learnhub_experiment_propose, the learner confirms, then learnhub_experiment_apply.",
    args: {},
    engine: "lab.experimentTemplates",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_experiment_templates",
      }
    ]
  }),
  'experiments': command({
    id: "experiments",
    args: {},
    domain: "实验室",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/experiments" }
      }
    ]
  }),
  'probation-settle': command({
    id: "probation-settle",
    args: {},
    engine: "growth2.settleRechecks",
    domain: "实验室",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/probation/settle" },
        bind: []
      }
    ]
  }),
  'sandbox': command({
    id: "sandbox",
    summary: "Run the plan sandbox (D-3, ADR-0025): Monte-Carlo projection of the learner's study plan using the SAME FSRS+mastery models as the scheduler (~200 seeded runs). Input = daily minutes goal x horizon in weeks (default 6) x intended course/nodes. Output = end-of-horizon mastery map (per node p50/p80) + total-mastery curve with 50/80 percentile bands + the honest assumption list (1 min per review, practice evidence frozen, new nodes introduced in course order). READ-ONLY: zero canonical writes, no gating, no scheduling side effects. The wording is locked to「模型推演，非承诺」— present the distribution as a distribution, never as a promise, and never as a feasibility verdict; the learner negotiates their own plan with it.",
    args: {
      minutes_per_day: { type: "number", description: "Daily learning-minutes goal of the plan", required: true },
      weeks: { type: "number", description: "Horizon in weeks (default 6, max 26)" },
      course: { type: "string", description: "Scope to one course; omit for all enabled courses" },
      nodes: {
        type: "array",
        description: "Intended node subset; omit for whole course(s)",
        items: { type: "string" }
      }
    },
    engine: "lab.sandboxRun",
    domain: "实验室",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_sandbox" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/sandbox/run" }
      }
    ]
  }),
  'thermostat': command({
    id: "thermostat",
    summary: "Get the challenge-point thermostat dashboard (D-2, ADR-0024): cross-region observation aggregate + READ-ONLY suggestions — the thermostat is NOT an auto-controller. Course region: true-retention band + long-term difficulty-band choice distribution. Unbounded region: execution-event rating distribution (empty until the U-area execution channel lands). Project region: deferred to P-7, tier list only. Three knobs max (A1 target difficulty-band default, retrieval-point density [not yet available], fading-tier move aggregation); at most three suggestions, low-data-silent. To ACT on a suggestion, show it to the learner and after their explicit confirmation call learnhub_thermostat_apply with the suggestion id — never apply without confirmation; there is no engine-side auto adjustment.",
    args: {},
    engine: "lab.thermostatView",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_thermostat",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/thermostat" },
        bind: []
      }
    ]
  }),
  'thermostat-apply': command({
    id: "thermostat-apply",
    summary: "Apply ONE thermostat suggestion AFTER the learner explicitly confirms it (D-2, ADR-0024): only ids currently offered by learnhub_thermostat are accepted (stale or invented ids fail loud) — this is the single confirmation gate. Confirmed band-default suggestions write the A1 default difficulty band via the existing config entry; the learner's explicit per-session band choice still overrides it.",
    args: {
      suggestion: { type: "string", description: "Suggestion id exactly as offered by learnhub_thermostat (e.g. band_default:standard)", required: true }
    },
    engine: "lab.thermostatApply",
    domain: "实验室",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_thermostat_apply",
        bind: ["suggestion"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/thermostat/apply" },
        bind: ["suggestion"]
      }
    ]
  }),
}

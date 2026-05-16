/**
 * pi-bar TLDR backtest harness.
 *
 * Replays past pi session JSONL transcripts through the same fact-collection
 * + prompt-construction logic the production engine uses (see
 * ./tldr-logic.ts — vendored copy of extensions/status-footer.ts internals).
 *
 * For each "checkpoint moment" (immediate / final / debounced normal) the
 * harness builds the exact user+system prompt the engine would send and
 * (in --live mode) calls a real model to produce the TLDR text. Output is a
 * markdown trace per session under ./out/.
 *
 * Usage:
 *   tsx backtest/run.ts [--live] [--limit N] [<session.jsonl>...]
 *
 * Without explicit paths, all sessions under
 *   ~/.pi/agent/sessions/--Users-tianrendong-pi-pi-bar--
 * are replayed.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildCheckpointUserPrompt,
	checkpointSystemPrompt,
	isNearDuplicateTldr,
	MAX_CONTEXT_CHECKPOINTS,
	NORMAL_CHECKPOINT_MAX_WAIT_MS,
	NORMAL_CHECKPOINT_QUIET_MS,
	sanitizeTldrText,
	TldrFactCollector,
	type TldrCheckpoint,
	type TldrDisplayPriority,
} from "./tldr-logic.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const DEFAULT_SESSIONS_DIR = join(
	homedir(),
	".pi/agent/sessions/--Users-tianrendong-pi-pi-bar--",
);
const LIVE_MODEL = process.env.PI_BAR_BACKTEST_MODEL ?? "gpt-4o-mini";
const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");

type JsonlEvent = {
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: readonly unknown[];
		stopReason?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		timestamp?: number;
		errorMessage?: string;
	};
};

type CheckpointTrace = {
	t: number; // event index
	priority: TldrDisplayPriority;
	trigger: string;
	rawCount: number;
	userPrompt: string;
	systemPrompt: string;
	tldr?: string;
	model?: string;
	latencyMs?: number;
	error?: string;
};

function readOpenAIKey(): string | undefined {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	try {
		const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		return auth.openai?.key;
	} catch {
		return undefined;
	}
}

async function callOpenAI(
	apiKey: string,
	systemPrompt: string,
	userPrompt: string,
	model: string,
): Promise<string> {
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			max_tokens: 120,
			temperature: 0.2,
		}),
	});
	if (!res.ok) {
		throw new Error(`openai ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return body.choices?.[0]?.message?.content?.trim() ?? "";
}

function parseEvents(jsonlPath: string): JsonlEvent[] {
	return readFileSync(jsonlPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JsonlEvent);
}

type ReplayPlan = {
	op:
		| { kind: "userMessage"; prompt: string }
		| { kind: "assistantUpdate"; message: unknown }
		| { kind: "toolCall"; toolName: string; input: Record<string, unknown>; toolCallId: string }
		| { kind: "toolResult"; toolName: string; input: Record<string, unknown>; isError: boolean; content: readonly unknown[]; toolCallId: string }
		| { kind: "messageEnd"; message: unknown };
	ts: number; // ms
	// "fact" = record but do not trigger a checkpoint (matches engine >=0.3.27
	// behavior for tool_call).
	priority: TldrDisplayPriority | "fact";
	trigger: string;
};

function planFromEvents(events: JsonlEvent[]): ReplayPlan[] {
	const plan: ReplayPlan[] = [];
	// Map assistant message.content[*] toolCall id → its arguments so when
	// the next toolResult arrives we can recover `input`.
	const callArgs = new Map<string, { toolName: string; input: Record<string, unknown> }>();

	for (const event of events) {
		if (event.type !== "message" || !event.message) continue;
		const ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();
		const msg = event.message;

		if (msg.role === "user") {
			const text = (msg.content ?? [])
				.map((p) => (p && typeof p === "object" && (p as any).type === "text" ? String((p as any).text) : ""))
				.join("\n")
				.trim();
			plan.push({
				op: { kind: "userMessage", prompt: text },
				ts,
				priority: "immediate",
				trigger: "user message",
			});
			continue;
		}

		if (msg.role === "assistant") {
			// Capture toolCalls so toolResults can be reconstructed. tool_call is
			// recorded as a fact (priority "fact" = no checkpoint fired). Production
			// engine (>=0.3.27) only fires on tool_result.
			for (const part of (msg.content ?? []) as any[]) {
				if (part?.type === "toolCall" && part.id) {
					callArgs.set(part.id, {
						toolName: part.name,
						input: (part.arguments ?? {}) as Record<string, unknown>,
					});
					plan.push({
						op: {
							kind: "toolCall",
							toolName: part.name,
							input: (part.arguments ?? {}) as Record<string, unknown>,
							toolCallId: part.id,
						},
						ts,
						priority: "fact",
						trigger: `tool_call ${part.name}`,
					});
				}
			}

			// Also record an assistant_update if there is any text content.
			const hasText = ((msg.content ?? []) as any[]).some(
				(p) => p?.type === "text" && typeof p.text === "string",
			);
			if (hasText) {
				plan.push({
					op: { kind: "assistantUpdate", message: msg },
					ts,
					priority: "normal",
					trigger: "assistant text",
				});
			}

			// message_end semantics: in the live engine message_end fires for every
			// assistant message, including stopReason === "toolUse". The engine's
			// recordMessageEnd ignores toolUse, so we still push it but it will be a
			// no-op other than asserting the path. For stopReason==="stop" it is a
			// final-priority checkpoint.
			// Engine: recordMessageEnd ignores toolUse, treats every other terminal
			// stopReason (stop, aborted, error, …) as a final-priority activity.
			plan.push({
				op: { kind: "messageEnd", message: msg },
				ts: ts + 1,
				priority: msg.stopReason === "toolUse" ? "normal" : "final",
				trigger: `message_end ${msg.stopReason ?? "?"}`,
			});
			continue;
		}

		if (msg.role === "toolResult") {
			const id = msg.toolCallId ?? "";
			const meta = callArgs.get(id) ?? { toolName: msg.toolName ?? "unknown", input: {} };
			plan.push({
				op: {
					kind: "toolResult",
					toolName: meta.toolName,
					input: meta.input,
					isError: Boolean(msg.isError),
					content: msg.content ?? [],
					toolCallId: id,
				},
				ts,
				priority: "normal",
				trigger: `tool_result ${meta.toolName}${msg.isError ? " ✗" : ""}`,
			});
		}
	}

	plan.sort((a, b) => a.ts - b.ts);
	return plan;
}

/**
 * Simulated checkpoint scheduler that mirrors FooterTldrEngine's enqueue logic
 * using historical event timestamps as the clock.
 *
 *  - immediate: cancels normal/in-flight, fires now
 *  - final: cancels pending normal, fires now
 *  - normal: debounced — fires after a NORMAL_CHECKPOINT_QUIET_MS quiet window
 *    or NORMAL_CHECKPOINT_MAX_WAIT_MS since the burst started, whichever first
 *
 * For simplicity (and because LLM calls are sequential in this harness), we do
 * NOT simulate in-flight aborting: a model call always completes before we
 * advance to the next event.
 */
async function replay(
	plan: ReplayPlan[],
	options: {
		live: boolean;
		apiKey?: string;
		model: string;
		onCheckpoint?: (t: CheckpointTrace) => void;
	},
): Promise<CheckpointTrace[]> {
	const facts = new TldrFactCollector();
	const accepted: TldrCheckpoint[] = [];
	const traces: CheckpointTrace[] = [];
	let latestAcceptedIndex = 0;

	let pendingNormal:
		| { activityIndex: number; burstStartedAt: number; trigger: string }
		| undefined;

	const fireCheckpoint = async (
		priority: TldrDisplayPriority,
		activityIndex: number,
		trigger: string,
	) => {
		const raw = facts.activitiesAfter(latestAcceptedIndex, activityIndex);
		if (raw.length === 0) return;
		const userPrompt = buildCheckpointUserPrompt(accepted, raw);
		const systemPrompt = checkpointSystemPrompt(priority);
		const trace: CheckpointTrace = {
			t: activityIndex,
			priority,
			trigger,
			rawCount: raw.length,
			userPrompt,
			systemPrompt,
		};

		if (options.live && options.apiKey) {
			const start = Date.now();
			try {
				const raw = await callOpenAI(
					options.apiKey,
					systemPrompt,
					userPrompt,
					options.model,
				);
				trace.model = options.model;
				trace.latencyMs = Date.now() - start;
				trace.tldr = sanitizeTldrText(raw);
			} catch (err) {
				trace.error = String((err as Error).message ?? err);
				trace.latencyMs = Date.now() - start;
			}
		}

		traces.push(trace);
		options.onCheckpoint?.(trace);

		if (trace.tldr) {
			// Mirror engine: don't "render" near-duplicates; mark them to surface
			// debouncing wins in the trace.
			const prev = accepted[accepted.length - 1]?.text ?? "";
			if (isNearDuplicateTldr(trace.tldr, prev)) {
				trace.error = "(skipped: near-duplicate of previous TLDR)";
			}
			accepted.push({
				activityIndex,
				displayPriority: priority,
				text: trace.tldr,
			});
			if (accepted.length > MAX_CONTEXT_CHECKPOINTS) {
				accepted.splice(0, accepted.length - MAX_CONTEXT_CHECKPOINTS);
			}
			latestAcceptedIndex = activityIndex;
			facts.discardActivitiesThrough(activityIndex);
		} else if (!options.live) {
			// Dry-run: still advance accepted index so we don't keep re-sending the
			// same activity in every subsequent prompt.
			latestAcceptedIndex = activityIndex;
			facts.discardActivitiesThrough(activityIndex);
			accepted.push({
				activityIndex,
				displayPriority: priority,
				text: `<dry-run TLDR @${activityIndex}>`,
			});
			if (accepted.length > MAX_CONTEXT_CHECKPOINTS) {
				accepted.splice(0, accepted.length - MAX_CONTEXT_CHECKPOINTS);
			}
		}
	};

	const flushPendingNormal = async (now: number) => {
		if (!pendingNormal) return;
		const job = pendingNormal;
		pendingNormal = undefined;
		// If the latest activity grew since we scheduled, fire on the latest.
		const latest = facts.latestActivityIndex();
		if (latest <= latestAcceptedIndex) return;
		await fireCheckpoint("normal", latest, `${job.trigger} (debounced)`);
		void now;
	};

	const maybeFlushOnEvent = async (now: number) => {
		if (!pendingNormal) return;
		const burstAge = now - pendingNormal.burstStartedAt;
		if (burstAge >= NORMAL_CHECKPOINT_MAX_WAIT_MS) {
			await flushPendingNormal(now);
		}
	};

	for (let i = 0; i < plan.length; i++) {
		const step = plan[i];
		const now = step.ts;

		// Before recording, see if a pending normal job is now stale enough that
		// the engine's max-wait timer would have fired.
		await maybeFlushOnEvent(now);

		// Check the quiet-window: if previous event was >= QUIET ago, fire.
		if (pendingNormal && i > 0) {
			const gapSincePrev = now - plan[i - 1].ts;
			if (gapSincePrev >= NORMAL_CHECKPOINT_QUIET_MS) {
				await flushPendingNormal(now);
			}
		}

		// Apply the op.
		let activity: { index: number } | undefined;
		switch (step.op.kind) {
			case "userMessage":
				// Engine >=0.3.27: recordUserMessage clears acceptedCheckpoints +
				// latestAcceptedActivityIndex so prior-turn TLDRs no longer bias the
				// next turn's prompt. Facts are NOT reset (the new user fact appends).
				accepted.splice(0);
				latestAcceptedIndex = 0;
				pendingNormal = undefined;
				activity = facts.recordUserMessage(step.op.prompt);
				break;
			case "assistantUpdate":
				activity = facts.recordAssistantUpdate(step.op.message) ?? undefined;
				break;
			case "toolCall":
				activity = facts.recordToolCall(step.op);
				break;
			case "toolResult":
				activity = facts.recordToolResult(step.op);
				break;
			case "messageEnd": {
				const r = facts.recordMessageEnd(step.op.message);
				if (r === "emptyFinalStop") {
					// Engine resets on empty final stop.
					facts.resetConversation();
					accepted.splice(0);
					latestAcceptedIndex = 0;
					pendingNormal = undefined;
					activity = undefined;
				} else if (r !== "ignored") {
					activity = r;
				}
				break;
			}
		}
		if (!activity) continue;

		if (step.priority === "fact") {
			// Recorded but not enqueued. Mirrors recordToolCall in engine >=0.3.27.
			continue;
		}
		if (step.priority === "immediate") {
			pendingNormal = undefined;
			await fireCheckpoint("immediate", activity.index, step.trigger);
		} else if (step.priority === "final") {
			pendingNormal = undefined;
			// Engine renders a literal ("Aborted." / "Stopped: <reason>.") for
			// failure finals; bypass the LLM here too.
			const msg = (step.op.kind === "messageEnd" ? step.op.message : undefined) as
				| { stopReason?: string }
				| undefined;
			const stopReason = msg?.stopReason;
			if (stopReason && stopReason !== "stop") {
				const literal = stopReason === "aborted" ? "Aborted." : `Stopped: ${stopReason}.`;
				traces.push({
					t: activity.index,
					priority: "final",
					trigger: `${step.trigger} (literal)`,
					rawCount: 0,
					userPrompt: "(bypassed: literal final)",
					systemPrompt: "(bypassed)",
					tldr: literal,
				});
				options.onCheckpoint?.(traces[traces.length - 1]);
				// Engine resets after literal final.
				facts.resetConversation();
				accepted.splice(0);
				latestAcceptedIndex = 0;
				pendingNormal = undefined;
			} else {
				await fireCheckpoint("final", activity.index, step.trigger);
			}
		} else {
			pendingNormal = pendingNormal ?? {
				activityIndex: activity.index,
				burstStartedAt: now,
				trigger: step.trigger,
			};
			pendingNormal.activityIndex = activity.index;
			pendingNormal.trigger = step.trigger;
		}
	}

	// Final flush.
	if (pendingNormal) await flushPendingNormal(plan[plan.length - 1]?.ts ?? 0);

	return traces;
}

function renderMarkdown(
	sessionPath: string,
	plan: ReplayPlan[],
	traces: CheckpointTrace[],
	live: boolean,
): string {
	const lines: string[] = [];
	lines.push(`# TLDR backtest: ${basename(sessionPath)}`);
	lines.push("");
	lines.push(`- events: ${plan.length}`);
	lines.push(`- checkpoints fired: ${traces.length}`);
	lines.push(`- mode: ${live ? "live" : "dry-run"}`);
	if (live) {
		const lats = traces.map((t) => t.latencyMs ?? 0).filter(Boolean);
		if (lats.length) {
			const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
			lines.push(`- avg latency: ${avg} ms (min ${Math.min(...lats)}, max ${Math.max(...lats)})`);
		}
	}
	lines.push("");

	for (const trace of traces) {
		lines.push(`## #${trace.t} [${trace.priority}] — ${trace.trigger}`);
		lines.push("");
		if (trace.tldr) lines.push(`**TLDR:** \`${trace.tldr}\``);
		if (trace.error) lines.push(`**Error:** ${trace.error}`);
		lines.push(`raw activities: ${trace.rawCount}${trace.latencyMs ? `, latency ${trace.latencyMs} ms` : ""}`);
		lines.push("");
		lines.push("<details><summary>prompt</summary>");
		lines.push("");
		lines.push("```");
		lines.push(trace.userPrompt);
		lines.push("```");
		lines.push("");
		lines.push("</details>");
		lines.push("");
	}
	return lines.join("\n");
}

function listDefaultSessions(): string[] {
	try {
		return readdirSync(DEFAULT_SESSIONS_DIR)
			.filter((n) => n.endsWith(".jsonl"))
			.sort()
			.map((n) => join(DEFAULT_SESSIONS_DIR, n));
	} catch {
		return [];
	}
}

async function main() {
	const args = process.argv.slice(2);
	const live = args.includes("--live");
	const limitArgIdx = args.indexOf("--limit");
	const limit = limitArgIdx !== -1 ? Number.parseInt(args[limitArgIdx + 1] ?? "0", 10) : 0;
	const sessions = args.filter(
		(a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--limit")),
	);

	const paths = sessions.length > 0 ? sessions : listDefaultSessions();
	if (paths.length === 0) {
		console.error("no sessions found");
		process.exit(1);
	}

	mkdirSync(OUT_DIR, { recursive: true });
	const apiKey = live ? readOpenAIKey() : undefined;
	if (live && !apiKey) {
		console.error("--live requires OPENAI_API_KEY (or ~/.pi/agent/auth.json)");
		process.exit(1);
	}

	const summary: { session: string; checkpoints: number; outFile: string }[] = [];
	for (const sessionPath of paths) {
		const events = parseEvents(sessionPath);
		const plan = planFromEvents(events);
		const cappedPlan = limit > 0 ? plan.slice(0, limit) : plan;
		console.error(`replay ${basename(sessionPath)} (${cappedPlan.length}/${plan.length} steps, live=${live})`);
		const traces = await replay(cappedPlan, {
			live,
			apiKey,
			model: LIVE_MODEL,
			onCheckpoint: (t) => {
				const head = `[${t.priority}] ${t.trigger}`.padEnd(50);
				console.error(`  ${head} → ${t.tldr ?? t.error ?? "(dry-run)"}`);
			},
		});
		const md = renderMarkdown(sessionPath, cappedPlan, traces, live);
		const outFile = join(
			OUT_DIR,
			`${basename(sessionPath, ".jsonl")}${live ? ".live" : ".dry"}.md`,
		);
		writeFileSync(outFile, md, "utf8");
		summary.push({ session: basename(sessionPath), checkpoints: traces.length, outFile });
	}

	const summaryPath = join(OUT_DIR, `summary${live ? ".live" : ".dry"}.json`);
	writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
	console.error(`\nsummary → ${summaryPath}`);
}

void main().catch((err) => {
	console.error(err);
	process.exit(1);
});

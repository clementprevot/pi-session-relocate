import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

const ACK_TIMEOUT_MS = 500;

/**
 * Ask @clementprevot/pi-session-search for its picker over the event bus,
 * limited to sessions of other directories. Resolves undefined when nothing
 * acknowledges the request in time, null when the user cancels, and the picked
 * session file otherwise.
 */
export function pickWithSearch(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string): Promise<string | null | undefined> {
	const requestId = randomUUID();
	return new Promise((resolvePick) => {
		let acknowledged = false;
		const offAck = pi.events.on(`session-search:rpc:v1:ack:${requestId}`, () => {
			acknowledged = true;
		});
		const offResult = pi.events.on(`session-search:rpc:v1:result:${requestId}`, (data: unknown) => {
			clearTimeout(timer);
			offAck();
			offResult();
			const path = (data as { path?: string | null })?.path;
			resolvePick(typeof path === "string" ? path : null);
		});
		const timer = setTimeout(() => {
			if (acknowledged) return;
			offAck();
			offResult();
			resolvePick(undefined);
		}, ACK_TIMEOUT_MS);
		pi.events.emit("session-search:rpc:v1:pick", { version: 1, requestId, ui: ctx.ui, cwd: ctx.cwd, excludeCwd: ctx.cwd, title });
	});
}

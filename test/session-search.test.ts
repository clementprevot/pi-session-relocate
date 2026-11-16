import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { pickWithSearch } from "../session-search.ts";

function fakePi(responder?: (request: { requestId: string }, emit: (channel: string, data: unknown) => void) => void) {
	const bus = new EventEmitter();
	const emit = (channel: string, data: unknown) => bus.emit(channel, data);
	if (responder) bus.on("session-search:rpc:v1:pick", (request) => responder(request, emit));
	const events = {
		emit,
		on: (channel: string, handler: (data: unknown) => void) => {
			bus.on(channel, handler);
			return () => bus.off(channel, handler);
		},
	};
	return { events } as unknown as ExtensionAPI;
}

const ctx = { ui: {}, cwd: "/work/app-feature" } as unknown as ExtensionCommandContext;

test("no ack means the search picker is not installed", async () => {
	assert.equal(await pickWithSearch(fakePi(), ctx, "title"), undefined);
});

test("an acknowledged request waits for the picked path", async () => {
	const pi = fakePi((request, emit) => {
		emit(`session-search:rpc:v1:ack:${request.requestId}`, {});
		setTimeout(() => emit(`session-search:rpc:v1:result:${request.requestId}`, { path: "/s/main.jsonl" }), 700);
	});
	assert.equal(await pickWithSearch(pi, ctx, "title"), "/s/main.jsonl");
});

test("a cancelled pick resolves null", async () => {
	const pi = fakePi((request, emit) => {
		emit(`session-search:rpc:v1:ack:${request.requestId}`, {});
		emit(`session-search:rpc:v1:result:${request.requestId}`, { path: null });
	});
	assert.equal(await pickWithSearch(pi, ctx, "title"), null);
});

test("the request excludes the current directory", async () => {
	let seen: Record<string, unknown> | undefined;
	const pi = fakePi((request, emit) => {
		seen = request as unknown as Record<string, unknown>;
		emit(`session-search:rpc:v1:ack:${request.requestId}`, {});
		emit(`session-search:rpc:v1:result:${request.requestId}`, { path: null });
	});
	await pickWithSearch(pi, ctx, "Bring a session here");
	assert.equal(seen?.excludeCwd, "/work/app-feature");
	assert.equal(seen?.title, "Bring a session here");
	assert.equal(seen?.version, 1);
});

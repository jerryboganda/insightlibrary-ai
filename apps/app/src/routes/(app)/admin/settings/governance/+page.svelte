<script lang="ts">
	import {
		ShieldAlert,
		GitMerge,
		FileWarning,
		Save,
		Scale,
		GripVertical,
		CheckCircle2,
		Loader2,
		AlertTriangle,
		Workflow,
		SearchCode
	} from '@lucide/svelte';
	import { fly, fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';
	import type { OrgSettingsResponse, OrgSettingsUpdate } from '@insightlibrary/api-client';

	// Real persistence via GET/PUT /api/org/settings. The refinery (dedup,
	// conflict detection, correlation), the parser router, the reranker and the
	// search engine all read these values at runtime (short-TTL cache), so saves
	// apply within seconds — no server restart.
	const settingsQ = createQuery({ queryKey: ['org-settings'], queryFn: () => api.getOrgSettings() });
	const queryClient = useQueryClient();

	// ── Governance / merge rules ─────────────────────────────────────────────
	let ssotConfidence = $state(0); // autoMergeConfidence, 0–100
	let requireReview = $state(true);

	// ── Refinery thresholds ──────────────────────────────────────────────────
	let dedupCosine = $state(0.9);
	let dedupUseNli = $state(true);
	let conflictEnabled = $state(true);
	let conflictSubjectCosine = $state(0.55);
	let maxCorrelateClaims = $state(120);

	// ── Pipeline ─────────────────────────────────────────────────────────────
	let parseMode = $state<'heuristic' | 'document-ai' | 'external'>('heuristic');
	let rerank = $state<'off' | 'llm' | 'cohere' | 'jina'>('off');

	// ── Search & copilot (C11) ───────────────────────────────────────────────
	let searchTopK = $state(20);
	let searchCandidates = $state(30);
	let searchRrfK = $state(60);
	let searchSnippetLength = $state(240);
	let promptMode = $state('ask');
	let promptOverrides = $state<Record<string, string>>({});

	// ── Source priority (stored workspace policy) ────────────────────────────
	const SOURCE_TIERS = [
		{ id: 's1', name: 'Official Guidelines & Standards', desc: 'e.g., WHO, NIST, IEEE' },
		{ id: 's2', name: 'Latest Edition Textbooks', desc: 'Published within 5 years' },
		{ id: 's3', name: 'Peer-Reviewed Journals', desc: 'Primary research papers' },
		{ id: 's4', name: 'Internal SOPs / Organization Policy', desc: 'Tenant specific' },
		{ id: 's5', name: 'Lecture Notes / Unverified PDFs', desc: 'Lowest priority fallback' }
	];
	let sources = $state([...SOURCE_TIERS]);

	// Seed the form once per page load from the fetched settings.
	let seeded = $state(false);
	$effect(() => {
		const d = $settingsQ.data;
		if (!d || seeded) return;
		seeded = true;
		const s = d.settings;
		ssotConfidence = Math.round(s.autoMergeConfidence);
		requireReview = s.requireReview;
		dedupCosine = s.dedupCosine;
		dedupUseNli = s.dedupUseNli;
		conflictEnabled = s.conflictEnabled;
		conflictSubjectCosine = s.conflictSubjectCosine;
		maxCorrelateClaims = s.maxCorrelateClaims;
		parseMode = s.parseMode;
		rerank = s.rerank;
		searchTopK = s.searchTopK;
		searchCandidates = s.searchCandidates;
		searchRrfK = s.searchRrfK;
		searchSnippetLength = s.searchSnippetLength;
		promptOverrides = { ...s.copilotPromptOverrides };
		if (s.sourcePriorityOrder.length) {
			const byId = new Map(SOURCE_TIERS.map((t) => [t.id, t]));
			const ordered = s.sourcePriorityOrder.map((id) => byId.get(id)).filter((t) => t !== undefined);
			const rest = SOURCE_TIERS.filter((t) => !s.sourcePriorityOrder.includes(t.id));
			sources = [...ordered, ...rest];
		}
	});

	const promptModes = $derived(Object.keys($settingsQ.data?.copilotPromptDefaults ?? { ask: '' }));
	const defaults = $derived($settingsQ.data?.defaults);

	function setPromptOverride(mode: string, text: string) {
		const next = { ...promptOverrides };
		if (text.trim()) next[mode] = text;
		else delete next[mode];
		promptOverrides = next;
	}

	// ── Save ─────────────────────────────────────────────────────────────────
	let showSaved = $state(false);
	let saveError = $state('');
	const saveMut = createMutation({
		mutationFn: (input: OrgSettingsUpdate) => api.updateOrgSettings(input),
		onSuccess: (data: OrgSettingsResponse) => {
			queryClient.setQueryData(['org-settings'], data);
			showSaved = true;
			setTimeout(() => (showSaved = false), 3000);
		},
		onError: (e: unknown) => {
			saveError = e instanceof Error ? e.message : 'Failed to save governance policies';
		}
	});

	const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

	function handleSave() {
		saveError = '';
		const overrides: Record<string, string> = {};
		for (const [k, v] of Object.entries(promptOverrides)) if (v.trim()) overrides[k] = v.trim();
		$saveMut.mutate({
			settings: {
				autoMergeConfidence: int(ssotConfidence, 0, 100),
				requireReview,
				dedupCosine: Math.min(1, Math.max(0, Number(dedupCosine) || 0.9)),
				dedupUseNli,
				conflictEnabled,
				conflictSubjectCosine: Math.min(1, Math.max(0, Number(conflictSubjectCosine) || 0.55)),
				maxCorrelateClaims: int(maxCorrelateClaims, 1, 5000),
				parseMode,
				rerank,
				searchTopK: int(searchTopK, 1, 100),
				searchCandidates: int(searchCandidates, 5, 200),
				searchRrfK: int(searchRrfK, 1, 500),
				searchSnippetLength: int(searchSnippetLength, 80, 2000),
				copilotPromptOverrides: Object.keys(overrides).length ? overrides : null,
				sourcePriorityOrder: sources.map((s) => s.id)
			}
		});
	}

	// Native HTML5 drag-and-drop reordering (replaces framer Reorder).
	let dragIndex = $state<number | null>(null);
	let overIndex = $state<number | null>(null);

	function onDrop(target: number) {
		if (dragIndex === null || dragIndex === target) {
			dragIndex = null;
			overIndex = null;
			return;
		}
		const next = [...sources];
		const [moved] = next.splice(dragIndex, 1);
		next.splice(target, 0, moved);
		sources = next;
		dragIndex = null;
		overIndex = null;
	}

	const modeLabel = (m: string) => m.replace(/_/g, ' ');
</script>

<div class="max-w-4xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<ShieldAlert class="h-6 w-6 text-indigo-400" />
			Governance & Review Policies
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Configure automation thresholds, manual review requirements, pipeline behavior, and retrieval
			tuning. Values apply to the running refinery within seconds of saving.
		</p>
	</header>

	{#if $settingsQ.isError}
		<div class="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
			<div>Couldn't load governance settings. Changes cannot be saved until the settings API is reachable.</div>
		</div>
	{/if}

	<!-- Automation Thresholds -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<GitMerge class="h-5 w-5 text-indigo-400" /> Delta Knowledge & Merge Rules
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Determine when the system can automatically update an SSOT vs. requesting human review.
			</p>
		</div>
		<div class="space-y-8 p-6">
			<div class="space-y-4">
				<div class="flex items-end justify-between">
					<div>
						<span class="text-sm font-medium text-zinc-200">Auto-Merge Confidence Threshold</span>
						<p class="mt-1 text-xs text-zinc-500">
							Duplicate claims are auto-merged only when the NLI equivalence confidence clears this
							bar. 0% merges every detected equivalent pair.
							{#if defaults}<span class="text-zinc-600">Default: {defaults.autoMergeConfidence}%.</span>{/if}
						</p>
					</div>
					<span class="text-lg font-bold text-indigo-400">{ssotConfidence}%</span>
				</div>
				<input
					type="range"
					min="0"
					max="100"
					bind:value={ssotConfidence}
					class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-indigo-500 transition-colors hover:bg-zinc-700"
				/>
				<div class="flex justify-between font-mono text-[10px] text-zinc-500">
					<span>0% (Merge All Equivalents)</span>
					<span>100% (Manual Only)</span>
				</div>
			</div>

			<hr class="border-zinc-800/60" />

			<div class="flex items-start justify-between gap-4">
				<div class="pr-8">
					<h4 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
						<FileWarning class="h-4 w-4 shrink-0 text-rose-400" /> Require Review for All Contradictions
					</h4>
					<p class="mt-1 max-w-xl text-xs text-zinc-500">
						If enabled, contradicting claims are frozen as "conflicted" until a human resolves the
						review queue item. If disabled, contradictions are still logged to the review queue but
						both claims remain active.
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={requireReview}
					aria-label="Require review for all contradictions"
					onclick={() => (requireReview = !requireReview)}
					class="relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {requireReview
						? 'border-indigo-500 bg-indigo-500'
						: 'border-zinc-700 bg-zinc-800'}"
				>
					<span
						class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {requireReview
							? 'translate-x-[22px]'
							: 'translate-x-0.5'}"
					></span>
				</button>
			</div>
		</div>
	</section>

	<!-- Refinery Thresholds -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<Workflow class="h-5 w-5 text-indigo-400" /> Refinery Thresholds
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Deduplication and conflict-detection sensitivity for the claims refinery. Applies to new
				ingestion and correlation runs.
			</p>
		</div>
		<div class="space-y-8 p-6">
			<div class="space-y-4">
				<div class="flex items-end justify-between">
					<div>
						<span class="text-sm font-medium text-zinc-200">Duplicate Similarity Threshold</span>
						<p class="mt-1 text-xs text-zinc-500">
							Cosine similarity above which two claims become dedup candidates.
							{#if defaults}<span class="text-zinc-600">Default: {Math.round(defaults.dedupCosine * 100)}%.</span>{/if}
						</p>
					</div>
					<span class="text-lg font-bold text-indigo-400">{Math.round(dedupCosine * 100)}%</span>
				</div>
				<input
					type="range"
					min="0.5"
					max="1"
					step="0.01"
					bind:value={dedupCosine}
					class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-indigo-500 transition-colors hover:bg-zinc-700"
				/>
			</div>

			<div class="space-y-4">
				<div class="flex items-end justify-between">
					<div>
						<span class="text-sm font-medium text-zinc-200">Conflict Subject Similarity</span>
						<p class="mt-1 text-xs text-zinc-500">
							Cosine similarity above which two claims are treated as the same subject and checked for
							contradiction.
							{#if defaults}<span class="text-zinc-600">Default: {Math.round(defaults.conflictSubjectCosine * 100)}%.</span>{/if}
						</p>
					</div>
					<span class="text-lg font-bold text-indigo-400">{Math.round(conflictSubjectCosine * 100)}%</span>
				</div>
				<input
					type="range"
					min="0"
					max="1"
					step="0.01"
					bind:value={conflictSubjectCosine}
					class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-indigo-500 transition-colors hover:bg-zinc-700"
				/>
			</div>

			<hr class="border-zinc-800/60" />

			<div class="flex items-start justify-between gap-4">
				<div class="pr-8">
					<h4 class="text-sm font-medium text-zinc-200">LLM Equivalence Check for Dedup</h4>
					<p class="mt-1 max-w-xl text-xs text-zinc-500">
						Gate merges on an NLI equivalence verdict in addition to cosine similarity (recommended;
						costs one LLM call per candidate pair).
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={dedupUseNli}
					aria-label="LLM equivalence check for dedup"
					onclick={() => (dedupUseNli = !dedupUseNli)}
					class="relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {dedupUseNli
						? 'border-indigo-500 bg-indigo-500'
						: 'border-zinc-700 bg-zinc-800'}"
				>
					<span
						class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {dedupUseNli
							? 'translate-x-[22px]'
							: 'translate-x-0.5'}"
					></span>
				</button>
			</div>

			<div class="flex items-start justify-between gap-4">
				<div class="pr-8">
					<h4 class="text-sm font-medium text-zinc-200">Conflict Detection</h4>
					<p class="mt-1 max-w-xl text-xs text-zinc-500">
						Detect same-subject contradictions between claims during correlation and surface them in
						the review queue.
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={conflictEnabled}
					aria-label="Conflict detection"
					onclick={() => (conflictEnabled = !conflictEnabled)}
					class="relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {conflictEnabled
						? 'border-indigo-500 bg-indigo-500'
						: 'border-zinc-700 bg-zinc-800'}"
				>
					<span
						class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {conflictEnabled
							? 'translate-x-[22px]'
							: 'translate-x-0.5'}"
					></span>
				</button>
			</div>

			<div class="flex max-w-xl items-center justify-between gap-4">
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Max Claims Correlated per Document</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Cost guard for dedup/conflict LLM calls.
						{#if defaults}<span class="text-zinc-600">Default: {defaults.maxCorrelateClaims}.</span>{/if}
					</p>
				</div>
				<input
					type="number"
					min="1"
					max="5000"
					bind:value={maxCorrelateClaims}
					class="w-28 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
				/>
			</div>
		</div>
	</section>

	<!-- Pipeline -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<SearchCode class="h-5 w-5 text-indigo-400" /> Pipeline & Retrieval
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Document parsing, search reranking, and retrieval tuning. New ingestion jobs and searches pick
				these up immediately.
			</p>
		</div>
		<div class="space-y-8 p-6">
			<div class="grid gap-6 sm:grid-cols-2">
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-200" for="parse-mode">Document Parse Mode</label>
					<select
						id="parse-mode"
						bind:value={parseMode}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					>
						<option value="heuristic">Heuristic (built-in, free)</option>
						<option value="document-ai">Document AI (LLM provider extracts tables/figures)</option>
						<option value="external">External (LlamaParse)</option>
					</select>
					<p class="text-xs text-zinc-500">
						Document AI needs a configured AI provider; External needs LLAMAPARSE_API_KEY on the
						server. Both degrade to heuristic when unconfigured.
						{#if defaults}<span class="text-zinc-600">Default: {defaults.parseMode}.</span>{/if}
					</p>
				</div>
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-200" for="rerank-mode">Search Reranker</label>
					<select
						id="rerank-mode"
						bind:value={rerank}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					>
						<option value="off">Off</option>
						<option value="llm">LLM (via configured provider)</option>
						<option value="cohere">Cohere</option>
						<option value="jina">Jina</option>
					</select>
					<p class="text-xs text-zinc-500">
						Cohere/Jina require COHERE_API_KEY / JINA_API_KEY in the server environment; without a key
						the reranker is skipped.
						{#if defaults}<span class="text-zinc-600">Default: {defaults.rerank}.</span>{/if}
					</p>
				</div>
			</div>

			<hr class="border-zinc-800/60" />

			<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-zinc-200" for="search-topk">Results (top-K)</label>
					<input
						id="search-topk"
						type="number"
						min="1"
						max="100"
						bind:value={searchTopK}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<p class="text-xs text-zinc-600">Default: {defaults?.searchTopK ?? 20}</p>
				</div>
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-zinc-200" for="search-cands">Candidates / arm</label>
					<input
						id="search-cands"
						type="number"
						min="5"
						max="200"
						bind:value={searchCandidates}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<p class="text-xs text-zinc-600">Default: {defaults?.searchCandidates ?? 30}</p>
				</div>
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-zinc-200" for="search-rrfk">RRF constant (K)</label>
					<input
						id="search-rrfk"
						type="number"
						min="1"
						max="500"
						bind:value={searchRrfK}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<p class="text-xs text-zinc-600">Default: {defaults?.searchRrfK ?? 60}</p>
				</div>
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-zinc-200" for="search-snip">Snippet length</label>
					<input
						id="search-snip"
						type="number"
						min="80"
						max="2000"
						bind:value={searchSnippetLength}
						class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<p class="text-xs text-zinc-600">Default: {defaults?.searchSnippetLength ?? 240}</p>
				</div>
			</div>

			<hr class="border-zinc-800/60" />

			<div class="space-y-3">
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Copilot System-Prompt Overrides</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Replace the built-in system prompt for a copilot mode. Leave empty to use the built-in
						prompt (shown as placeholder). Applies to new copilot conversations immediately.
					</p>
				</div>
				<div class="flex flex-col gap-3 sm:flex-row">
					<select
						aria-label="Copilot mode"
						bind:value={promptMode}
						class="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 capitalize focus:border-indigo-500/50 focus:outline-none sm:w-48"
					>
						{#each promptModes as m (m)}
							<option value={m} class="capitalize">
								{modeLabel(m)}{promptOverrides[m]?.trim() ? ' •' : ''}
							</option>
						{/each}
					</select>
					<textarea
						aria-label="System prompt override"
						rows="3"
						value={promptOverrides[promptMode] ?? ''}
						oninput={(e) => setPromptOverride(promptMode, e.currentTarget.value)}
						placeholder={$settingsQ.data?.copilotPromptDefaults?.[promptMode] ?? ''}
						class="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
					></textarea>
				</div>
			</div>
		</div>
	</section>

	<!-- Source Priority -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
				<Scale class="h-5 w-5 text-indigo-400" /> Source Priority Ranking
			</h2>
			<p class="mt-1 text-sm text-zinc-400">
				Drag and drop to set the priority order. Stored as workspace policy and shown to reviewers;
				automated conflict resolution will consult this ranking once enabled.
			</p>
		</div>
		<div class="p-6">
			<div
				class="divide-y divide-zinc-800/60 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50"
			>
				{#each sources as item, index (item.id)}
					<div
						animate:flip={{ duration: 200 }}
						draggable="true"
						ondragstart={() => (dragIndex = index)}
						ondragover={(e) => {
							e.preventDefault();
							overIndex = index;
						}}
						ondragleave={() => {
							if (overIndex === index) overIndex = null;
						}}
						ondrop={(e) => {
							e.preventDefault();
							onDrop(index);
						}}
						ondragend={() => {
							dragIndex = null;
							overIndex = null;
						}}
						role="listitem"
						class="flex cursor-grab items-center gap-4 p-4 transition-colors active:cursor-grabbing {overIndex ===
							index && dragIndex !== index
							? 'bg-indigo-500/10'
							: 'hover:bg-zinc-800'} {dragIndex === index ? 'opacity-50' : ''}"
					>
						<div class="text-zinc-600 transition-colors hover:text-zinc-400">
							<GripVertical class="h-5 w-5" />
						</div>
						<div class="w-6 text-xs font-bold text-zinc-500">{index + 1}</div>
						<div class="flex-1">
							<h4 class="text-sm font-medium text-zinc-200">{item.name}</h4>
							<p class="mt-0.5 text-xs text-zinc-500">{item.desc}</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<div class="relative flex items-center justify-end gap-4 pt-4 pb-12">
		{#if showSaved}
			<div
				in:fly={{ x: -20, duration: 250 }}
				out:fade={{ duration: 150 }}
				class="flex items-center gap-2 text-sm font-medium text-emerald-400"
			>
				<CheckCircle2 class="h-4 w-4" />
				Saved Successfully
			</div>
		{/if}
		{#if saveError}
			<div in:fade={{ duration: 150 }} class="flex items-center gap-2 text-sm font-medium text-rose-400">
				<AlertTriangle class="h-4 w-4" />
				{saveError}
			</div>
		{/if}
		<button
			onclick={handleSave}
			disabled={$saveMut.isPending || $settingsQ.isLoading || $settingsQ.isError}
			class="flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{#if $saveMut.isPending}
				<Loader2 class="h-4 w-4 animate-spin" />
				Saving...
			{:else}
				<Save class="h-4 w-4" />
				Save Governance Policies
			{/if}
		</button>
	</div>
</div>

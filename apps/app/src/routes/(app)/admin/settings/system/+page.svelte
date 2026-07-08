<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		SlidersHorizontal,
		AlertTriangle,
		Layers,
		Gauge,
		KeyRound,
		Workflow,
		Cpu,
		Lock,
		Save
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { SystemSettingsResponse, SystemSettingsValues } from '@insightlibrary/api-client';

	// Super-admin platform config: GET/PUT /api/admin/system-settings (RequireSuperAdmin).
	const settingsQ = createQuery<SystemSettingsResponse>({
		queryKey: ['system-settings'],
		queryFn: () => api.getSystemSettings()
	});
	const queryClient = useQueryClient();

	// Editable groups only — pricing is managed on its own page; restartRequired is read-only.
	let queueConcurrency = $state(0);
	let queueMaxAttempts = $state(0);
	let queueClaimIdleMs = $state(0);
	let rlMax = $state(0);
	let rlWindowSecs = $state(0);
	let rlAuthMax = $state(0);
	let authAccessTtl = $state(0);
	let authRefreshTtl = $state(0);
	let pipeParseMaxPages = $state(0);
	let pipeParseMaxFileMb = $state(0);
	let pipeLowConf = $state(0);
	let pipeLinkSim = $state(0);

	// Seed the form once per page load from the persisted settings.
	let seeded = $state(false);
	$effect(() => {
		const s: SystemSettingsValues | undefined = $settingsQ.data?.settings;
		if (!s || seeded) return;
		seeded = true;
		queueConcurrency = s.queue.concurrency;
		queueMaxAttempts = s.queue.maxAttempts;
		queueClaimIdleMs = s.queue.claimIdleMs;
		rlMax = s.rateLimit.max;
		rlWindowSecs = s.rateLimit.windowSecs;
		rlAuthMax = s.rateLimit.authMax;
		authAccessTtl = s.auth.accessTtlSecs;
		authRefreshTtl = s.auth.refreshTtlSecs;
		pipeParseMaxPages = s.pipeline.parseMaxPages;
		pipeParseMaxFileMb = s.pipeline.parseMaxFileMb;
		pipeLowConf = s.pipeline.lowConfThreshold;
		pipeLinkSim = s.pipeline.linkSimThreshold;
	});

	function clampInt(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
	}
	function clampNum(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, Number(v) || lo));
	}

	// Build a patch of ONLY the editable groups, clamped to server-accepted ranges.
	function buildPatch() {
		return {
			queue: {
				concurrency: clampInt(queueConcurrency, 1, 64),
				maxAttempts: clampInt(queueMaxAttempts, 1, 20),
				claimIdleMs: clampInt(queueClaimIdleMs, 10000, 3600000)
			},
			rateLimit: {
				max: clampInt(rlMax, 1, 100000),
				windowSecs: clampInt(rlWindowSecs, 1, 3600),
				authMax: clampInt(rlAuthMax, 1, 10000)
			},
			auth: {
				accessTtlSecs: clampInt(authAccessTtl, 60, 86400),
				refreshTtlSecs: clampInt(authRefreshTtl, 3600, 31536000)
			},
			pipeline: {
				parseMaxPages: clampInt(pipeParseMaxPages, 1, 10000),
				parseMaxFileMb: clampInt(pipeParseMaxFileMb, 1, 5000),
				lowConfThreshold: clampNum(pipeLowConf, 0, 1),
				linkSimThreshold: clampNum(pipeLinkSim, 0, 1)
			}
		};
	}

	let showSaved = $state(false);
	let saveError = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const saveMut = createMutation({
		mutationFn: () => api.updateSystemSettings(buildPatch()),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['system-settings'] });
			showSaved = true;
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (showSaved = false), 3000);
		},
		onError: (e: unknown) => {
			saveError = e instanceof Error ? e.message : 'Failed to save system settings';
		}
	});

	function handleSave() {
		saveError = '';
		$saveMut.mutate();
	}
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<SlidersHorizontal class="h-6 w-6 text-indigo-400" />
			System Settings
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Platform-wide runtime configuration for the queue, rate limiting, authentication tokens, and
			the ingestion pipeline. Applies to every workspace on this deployment.
		</p>
	</header>

	<!-- Restart-required warning -->
	<div class="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
		<AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
		<div class="text-sm">
			<p class="font-medium text-amber-300">Some changes require an API restart</p>
			<p class="mt-1 text-amber-200/80">
				<span class="font-mono text-amber-200">rateLimit.*</span> and
				<span class="font-mono text-amber-200">auth.*TtlSecs</span>
				are read into config when the API boots — edits here only take effect after the API process is
				<strong class="text-amber-100">restarted</strong>.
				<span class="font-mono text-amber-200">queue.*</span> and
				<span class="font-mono text-amber-200">pipeline.*</span> changes apply live within ~10s.
			</p>
		</div>
	</div>

	{#if $settingsQ.isLoading}
		<div class="space-y-6">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-56 rounded-xl" />
			{/each}
		</div>
	{:else if $settingsQ.isError}
		<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
			{$settingsQ.error instanceof Error ? $settingsQ.error.message : 'Failed to load system settings.'}
		</div>
	{:else if $settingsQ.data}
		{@const def = $settingsQ.data.defaults}
		{@const rr = $settingsQ.data.restartRequired}

		<!-- Queue & Workers -->
		<section class="glass-panel rounded-xl border border-zinc-800" in:fly={{ y: 8, duration: 250 }}>
			<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<Layers class="h-4 w-4 text-indigo-400" /> Queue &amp; Workers
				</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Background job concurrency and retry behaviour. Applies live within ~10s.
				</p>
			</div>
			<div class="grid grid-cols-1 gap-5 p-6 sm:grid-cols-3">
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Concurrency</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Parallel jobs per worker (1–64)</span>
					<input
						type="number"
						min="1"
						max="64"
						step="1"
						bind:value={queueConcurrency}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.queue.concurrency}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Max Attempts</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Retries before a job fails (1–20)</span>
					<input
						type="number"
						min="1"
						max="20"
						step="1"
						bind:value={queueMaxAttempts}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.queue.maxAttempts}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Claim Idle (ms)</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Reclaim stuck jobs after (10k–3.6M)</span>
					<input
						type="number"
						min="10000"
						max="3600000"
						step="1000"
						bind:value={queueClaimIdleMs}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.queue.claimIdleMs}</span>
				</label>
			</div>
		</section>

		<!-- Rate Limiting -->
		<section class="glass-panel rounded-xl border border-zinc-800" in:fly={{ y: 8, duration: 250, delay: 40 }}>
			<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<Gauge class="h-4 w-4 text-indigo-400" /> Rate Limiting
				</h2>
				<p class="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
					Request throttling windows.
					<span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
						Restart required
					</span>
				</p>
			</div>
			<div class="grid grid-cols-1 gap-5 p-6 sm:grid-cols-3">
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Max Requests</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Per window, per client (1–100k)</span>
					<input
						type="number"
						min="1"
						max="100000"
						step="1"
						bind:value={rlMax}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.rateLimit.max}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Window (secs)</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Sliding window length (1–3600)</span>
					<input
						type="number"
						min="1"
						max="3600"
						step="1"
						bind:value={rlWindowSecs}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.rateLimit.windowSecs}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Auth Max</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Login/token attempts (1–10k)</span>
					<input
						type="number"
						min="1"
						max="10000"
						step="1"
						bind:value={rlAuthMax}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.rateLimit.authMax}</span>
				</label>
			</div>
		</section>

		<!-- Authentication -->
		<section class="glass-panel rounded-xl border border-zinc-800" in:fly={{ y: 8, duration: 250, delay: 80 }}>
			<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<KeyRound class="h-4 w-4 text-indigo-400" /> Authentication
				</h2>
				<p class="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
					JWT token lifetimes.
					<span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
						Restart required
					</span>
				</p>
			</div>
			<div class="grid grid-cols-1 gap-5 p-6 sm:grid-cols-2">
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Access Token TTL (secs)</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Short-lived access token (60–86,400)</span>
					<input
						type="number"
						min="60"
						max="86400"
						step="1"
						bind:value={authAccessTtl}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.auth.accessTtlSecs}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Refresh Token TTL (secs)</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Session refresh window (3,600–31.5M)</span>
					<input
						type="number"
						min="3600"
						max="31536000"
						step="1"
						bind:value={authRefreshTtl}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.auth.refreshTtlSecs}</span>
				</label>
			</div>
		</section>

		<!-- Pipeline -->
		<section class="glass-panel rounded-xl border border-zinc-800" in:fly={{ y: 8, duration: 250, delay: 120 }}>
			<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<Workflow class="h-4 w-4 text-indigo-400" /> Ingestion Pipeline
				</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Parsing limits and linking thresholds. Applies live within ~10s.
				</p>
			</div>
			<div class="grid grid-cols-1 gap-5 p-6 sm:grid-cols-2">
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Parse Max Pages</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Page cap per document (1–10k)</span>
					<input
						type="number"
						min="1"
						max="10000"
						step="1"
						bind:value={pipeParseMaxPages}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.pipeline.parseMaxPages}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Parse Max File (MB)</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Upload size ceiling (1–5,000)</span>
					<input
						type="number"
						min="1"
						max="5000"
						step="1"
						bind:value={pipeParseMaxFileMb}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.pipeline.parseMaxFileMb}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Low-Confidence Threshold</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Flag extractions below (0–1)</span>
					<input
						type="number"
						min="0"
						max="1"
						step="0.01"
						bind:value={pipeLowConf}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.pipeline.lowConfThreshold}</span>
				</label>
				<label class="flex flex-col">
					<span class="text-sm font-medium text-zinc-200">Link Similarity Threshold</span>
					<span class="mt-0.5 mb-1.5 text-xs text-zinc-500">Min similarity to auto-link (0–1)</span>
					<input
						type="number"
						min="0"
						max="1"
						step="0.01"
						bind:value={pipeLinkSim}
						class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="mt-1 text-xs text-zinc-600">Default {def.pipeline.linkSimThreshold}</span>
				</label>
			</div>
		</section>

		<!-- Save bar -->
		<div class="flex items-center justify-end gap-3">
			{#if showSaved}
				<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">
					Settings saved
				</span>
			{/if}
			{#if saveError}
				<span class="text-xs text-rose-400">{saveError}</span>
			{/if}
			<button
				onclick={handleSave}
				disabled={$saveMut.isPending || !seeded}
				class="flex items-center gap-2 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				<Save class="h-4 w-4" />
				{$saveMut.isPending ? 'Saving…' : 'Save Settings'}
			</button>
		</div>

		<!-- Read-only: inference models & service URLs (require redeploy) -->
		<section class="glass-panel rounded-xl border border-zinc-800" in:fly={{ y: 8, duration: 250, delay: 160 }}>
			<div class="flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<div>
					<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
						<Cpu class="h-4 w-4 text-indigo-400" /> Inference &amp; Services
					</h2>
					<p class="mt-1 text-sm text-zinc-400">
						Embedding/rerank models and sidecar endpoints. Changing these requires
						<strong class="text-zinc-300">redeploying the parser and inference sidecars</strong> — they
						cannot be edited from this console.
					</p>
				</div>
				<span class="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/60 px-3 py-1 text-xs font-medium text-zinc-400">
					<Lock class="h-3.5 w-3.5" /> Read-only
				</span>
			</div>
			<div class="grid grid-cols-1 gap-x-6 gap-y-5 p-6 sm:grid-cols-2">
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Dense Embedding Model</div>
					<div class="mt-1 font-mono text-sm break-all text-zinc-300">{rr.inferenceDenseModel || '—'}</div>
				</div>
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Dense Dimensions</div>
					<div class="mt-1 font-mono text-sm text-zinc-300">{rr.inferenceDenseDim}</div>
				</div>
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Sparse Model</div>
					<div class="mt-1 font-mono text-sm break-all text-zinc-300">{rr.inferenceSparseModel || '—'}</div>
				</div>
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Rerank Model</div>
					<div class="mt-1 font-mono text-sm break-all text-zinc-300">{rr.inferenceRerankModel || '—'}</div>
				</div>
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Parser Service URL</div>
					<div class="mt-1 font-mono text-sm break-all text-zinc-300">{rr.parserSvcUrl || '—'}</div>
				</div>
				<div>
					<div class="text-xs font-medium tracking-wide text-zinc-500 uppercase">Inference Service URL</div>
					<div class="mt-1 font-mono text-sm break-all text-zinc-300">{rr.inferenceSvcUrl || '—'}</div>
				</div>
			</div>
		</section>
	{/if}
</div>

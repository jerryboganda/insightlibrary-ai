<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		Server,
		Clock,
		Activity,
		CheckCircle2,
		XCircle,
		Gauge,
		Timer,
		Layers,
		Lock,
		Save
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { ProcessingStats } from '@insightlibrary/schemas';
	import type { SystemSettingsResponse, SystemSettingsValues } from '@insightlibrary/api-client';

	// Queue knobs (concurrency/maxAttempts/claimIdleMs) are RequireSuperAdmin on the server.
	const isSuperAdmin = $derived((page.data as { platformRole?: string }).platformRole === 'super_admin');

	// Live pipeline rollups — refetch every 5s so the depth counters stay current.
	const statsQ = createQuery<ProcessingStats>({
		queryKey: ['processing-stats'],
		queryFn: () => api.getProcessingStats(),
		refetchInterval: 5000
	});
	// Persisted queue configuration (GET/PUT /api/admin/system-settings).
	const settingsQ = createQuery<SystemSettingsResponse>({
		queryKey: ['system-settings'],
		queryFn: () => api.getSystemSettings()
	});
	const queryClient = useQueryClient();

	const jobs = $derived($statsQ.data?.jobs);
	const t24 = $derived($statsQ.data?.throughput24h);
	const stageDurations = $derived<Record<string, number>>($statsQ.data?.avgStageDurationsMs ?? {});
	const stageRows = $derived(
		Object.entries(jobs?.byStage ?? {})
			.map(([stage, count]) => ({ stage, count: Number(count) }))
			.sort((a, b) => b.count - a.count)
	);
	const successPct = $derived(
		$statsQ.data?.successRate != null ? Math.round($statsQ.data.successRate * 100) : null
	);

	// Persisted queue values, for read-only display and seeding the editable knobs.
	const queue = $derived<SystemSettingsValues['queue'] | undefined>($settingsQ.data?.settings.queue);
	const perKind = $derived(Object.entries(queue?.perKindConcurrency ?? {}));

	function formatDuration(ms: number | null | undefined): string {
		if (ms == null) return '—';
		if (ms < 1000) return `${Math.round(ms)} ms`;
		const s = ms / 1000;
		if (s < 60) return `${s.toFixed(1)} s`;
		const m = s / 60;
		if (m < 60) return `${m.toFixed(1)} min`;
		return `${(m / 60).toFixed(1)} h`;
	}
	function clampInt(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
	}

	// Editable knobs — seeded once from the persisted settings.
	let concurrency = $state(1);
	let maxAttempts = $state(1);
	let claimIdleMs = $state(60000);
	let seeded = $state(false);
	$effect(() => {
		const q = $settingsQ.data?.settings.queue;
		if (!q || seeded) return;
		seeded = true;
		concurrency = q.concurrency;
		maxAttempts = q.maxAttempts;
		claimIdleMs = q.claimIdleMs;
	});

	const claimIdleSecs = $derived(Math.round((Number(claimIdleMs) || 0) / 1000));

	let savedNotice = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const saveKnobs = createMutation({
		mutationFn: () =>
			api.updateSystemSettings({
				queue: {
					concurrency: clampInt(concurrency, 1, 64),
					maxAttempts: clampInt(maxAttempts, 1, 20),
					claimIdleMs: clampInt(claimIdleMs, 10000, 3600000)
				}
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['system-settings'] });
			savedNotice = 'Queue settings saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		}
	});
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Server class="h-6 w-6 text-indigo-400" />
			Processing Queue
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Live pipeline depth across ingestion stages, plus the worker concurrency knobs. Counters
			refresh automatically every few seconds.
		</p>
	</header>

	<!-- Live queue depth -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		{#if $statsQ.isLoading}
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-[104px] rounded-xl" />
			{/each}
		{:else}
			<div
				in:fly={{ y: 8, duration: 250 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Queued
					<Clock class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{(jobs?.queued ?? 0).toLocaleString()}</span>
					<span class="text-xs text-zinc-500">waiting</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 40 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Running
					<Activity class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-emerald-300">{(jobs?.active ?? 0).toLocaleString()}</span>
					<span class="text-xs text-zinc-500">active now</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 80 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Completed
					<CheckCircle2 class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{(jobs?.completed ?? 0).toLocaleString()}</span>
					<span class="text-xs text-zinc-500">+{(t24?.completed ?? 0).toLocaleString()} / 24h</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 120 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Failed
					<XCircle class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold {(jobs?.failed ?? 0) > 0 ? 'text-rose-300' : 'text-zinc-100'}">
						{(jobs?.failed ?? 0).toLocaleString()}
					</span>
					<span class="text-xs text-zinc-500">+{(t24?.failed ?? 0).toLocaleString()} / 24h</span>
				</div>
			</div>
		{/if}
	</div>

	{#if $statsQ.data}
		<p class="text-xs text-zinc-600" in:fade={{ duration: 200 }}>
			Source: {$statsQ.data.source}. Avg queued→done
			{formatDuration($statsQ.data.avgDurationMs)}{#if successPct != null}
				· {successPct}% success rate{/if}.
		</p>
	{/if}

	<!-- Per-stage breakdown -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
			<h2 class="text-lg font-semibold text-zinc-100">Depth by Stage</h2>
			<p class="mt-1 text-sm text-zinc-400">Outstanding jobs per pipeline stage, deepest first.</p>
		</div>
		{#if $statsQ.isLoading}
			<div class="space-y-3 p-6">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-10 rounded-md" />
				{/each}
			</div>
		{:else if stageRows.length === 0}
			<div class="px-6 py-10 text-center text-sm text-zinc-500">
				No jobs are currently queued across any stage.
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead
						class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
					>
						<tr>
							<th class="px-6 py-3">Stage</th>
							<th class="px-6 py-3 text-right">Jobs</th>
							<th class="px-6 py-3 text-right">Avg Duration</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
						{#each stageRows as row (row.stage)}
							<tr class="transition-colors hover:bg-zinc-900/40">
								<td class="px-6 py-3 font-mono text-xs text-zinc-300">{row.stage}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-200">{row.count.toLocaleString()}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-400">
									{formatDuration(stageDurations[row.stage] ?? null)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- Worker knobs -->
	<section class="glass-panel mt-8 overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 p-6">
			<div>
				<h2 class="text-lg font-semibold text-zinc-100">Worker Configuration</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Tune how aggressively the background worker claims and retries jobs.
				</p>
			</div>
			{#if !isSuperAdmin}
				<span
					class="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/40 px-3 py-1 text-xs font-medium text-zinc-400"
				>
					<Lock class="h-3.5 w-3.5" /> super-admin only
				</span>
			{/if}
		</div>

		{#if $settingsQ.isLoading}
			<div class="space-y-3 p-6">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-10 rounded-md" />
				{/each}
			</div>
		{:else if isSuperAdmin}
			<div class="space-y-6 p-6">
				<div class="flex max-w-2xl items-start justify-between gap-4">
					<div class="flex-1">
						<h4 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
							<Gauge class="h-4 w-4 text-zinc-500" /> Concurrency
						</h4>
						<p class="mt-1 text-xs text-zinc-500">
							Maximum jobs a single worker processes in parallel. Range 1–64.
						</p>
					</div>
					<input
						type="number"
						min="1"
						max="64"
						bind:value={concurrency}
						class="w-24 shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
				</div>

				<hr class="max-w-2xl border-zinc-800/60" />

				<div class="flex max-w-2xl items-start justify-between gap-4">
					<div class="flex-1">
						<h4 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
							<Layers class="h-4 w-4 text-zinc-500" /> Max Attempts
						</h4>
						<p class="mt-1 text-xs text-zinc-500">
							How many times a failing job is retried before it is parked as failed. Range 1–20.
						</p>
					</div>
					<input
						type="number"
						min="1"
						max="20"
						bind:value={maxAttempts}
						class="w-24 shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
				</div>

				<hr class="max-w-2xl border-zinc-800/60" />

				<div class="flex max-w-2xl items-start justify-between gap-4">
					<div class="flex-1">
						<h4 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
							<Timer class="h-4 w-4 text-zinc-500" /> Claim Idle
						</h4>
						<p class="mt-1 text-xs text-zinc-500">
							Time before an in-flight claim is considered stalled and re-queued. Range
							10,000–3,600,000 ms{#if claimIdleSecs > 0} (~{claimIdleSecs.toLocaleString()} s){/if}.
						</p>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<input
							type="number"
							min="10000"
							max="3600000"
							step="1000"
							bind:value={claimIdleMs}
							class="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
						/>
						<span class="text-zinc-400">ms</span>
					</div>
				</div>

				{#if perKind.length > 0}
					<hr class="max-w-2xl border-zinc-800/60" />
					<div class="max-w-2xl">
						<h4 class="text-sm font-medium text-zinc-200">Per-Kind Concurrency</h4>
						<p class="mt-1 text-xs text-zinc-500">
							Per-job-kind overrides (configured elsewhere), shown for reference.
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							{#each perKind as [kind, n] (kind)}
								<span
									class="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-xs text-zinc-300"
								>
									{kind}: {n}
								</span>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
				{#if savedNotice}
					<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">{savedNotice}</span>
				{/if}
				{#if $saveKnobs.isError}
					<span class="text-xs text-rose-400">
						{$saveKnobs.error instanceof Error ? $saveKnobs.error.message : 'Save failed'}
					</span>
				{/if}
				<button
					onclick={() => $saveKnobs.mutate()}
					disabled={$saveKnobs.isPending || $settingsQ.isLoading}
					class="flex items-center gap-2 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
				>
					<Save class="h-4 w-4" />
					{$saveKnobs.isPending ? 'Saving…' : 'Save Settings'}
				</button>
			</div>
		{:else}
			<!-- Read-only view for non-super-admins. -->
			<div class="space-y-4 p-6">
				<div class="flex max-w-2xl items-center justify-between gap-4 border-b border-zinc-800/60 pb-3">
					<span class="flex items-center gap-2 text-sm text-zinc-300">
						<Gauge class="h-4 w-4 text-zinc-500" /> Concurrency
					</span>
					<span class="font-mono text-sm text-zinc-200">{queue?.concurrency ?? '—'}</span>
				</div>
				<div class="flex max-w-2xl items-center justify-between gap-4 border-b border-zinc-800/60 pb-3">
					<span class="flex items-center gap-2 text-sm text-zinc-300">
						<Layers class="h-4 w-4 text-zinc-500" /> Max Attempts
					</span>
					<span class="font-mono text-sm text-zinc-200">{queue?.maxAttempts ?? '—'}</span>
				</div>
				<div class="flex max-w-2xl items-center justify-between gap-4">
					<span class="flex items-center gap-2 text-sm text-zinc-300">
						<Timer class="h-4 w-4 text-zinc-500" /> Claim Idle
					</span>
					<span class="font-mono text-sm text-zinc-200">
						{queue?.claimIdleMs != null ? `${queue.claimIdleMs.toLocaleString()} ms` : '—'}
					</span>
				</div>
				<p class="pt-1 text-xs text-zinc-500">
					These knobs can only be changed by a platform super-admin.
				</p>
			</div>
		{/if}
	</section>
</div>

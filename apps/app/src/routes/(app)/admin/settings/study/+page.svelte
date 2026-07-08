<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Brain } from '@lucide/svelte';
	import { fade } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type {
		OrgSettingsResponse,
		OrgSettingsValues,
		OrgSettingsUpdate
	} from '@insightlibrary/api-client';

	const inputClass =
		'rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none';

	// Org settings back the study-scheduler tuning (settings.study).
	const orgSettings = createQuery<OrgSettingsResponse>({
		queryKey: ['org-settings'],
		queryFn: () => api.getOrgSettings()
	});
	const queryClient = useQueryClient();

	// Study-engine form, seeded once from the persisted org settings.
	let scheduler = $state('sm2');
	let initialEase = $state(2.5);
	let minEase = $state(1.3);
	let firstIntervalDays = $state(1);
	let secondIntervalDays = $state(6);
	let requestRetention = $state(0.9);
	let maximumInterval = $state(36500);
	let seeded = $state(false);

	$effect(() => {
		const study = $orgSettings.data?.settings?.study;
		if (!study || seeded) return;
		scheduler = study.scheduler ?? 'sm2';
		initialEase = study.sm2.initialEase;
		minEase = study.sm2.minEase;
		firstIntervalDays = study.sm2.firstIntervalDays;
		secondIntervalDays = study.sm2.secondIntervalDays;
		requestRetention = study.fsrs.requestRetention;
		maximumInterval = study.fsrs.maximumInterval;
		seeded = true;
	});

	let savedNotice = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	function buildStudy(): OrgSettingsValues['study'] {
		return {
			scheduler,
			sm2: {
				initialEase: Number(initialEase),
				minEase: Number(minEase),
				firstIntervalDays: Number(firstIntervalDays),
				secondIntervalDays: Number(secondIntervalDays)
			},
			fsrs: {
				requestRetention: Number(requestRetention),
				maximumInterval: Number(maximumInterval)
			}
		};
	}

	const saveStudy = createMutation({
		mutationFn: () => {
			const update: OrgSettingsUpdate = { settings: { study: buildStudy() } };
			return api.updateOrgSettings(update);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['org-settings'] });
			savedNotice = 'Study settings saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		}
	});
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Brain class="h-6 w-6 text-indigo-400" />
			Study Engine
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Tune the spaced-repetition scheduler that drives review intervals for the whole workspace.
		</p>
	</header>

	{#if $orgSettings.isLoading}
		<div class="space-y-6">
			<Skeleton class="h-[120px] rounded-xl" />
			<Skeleton class="h-[260px] rounded-xl" />
			<Skeleton class="h-[180px] rounded-xl" />
		</div>
	{:else}
		<!-- Scheduler selection -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
			<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<h2 class="text-lg font-semibold text-zinc-100">Scheduler</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Choose the algorithm used to compute the next review date for each card.
				</p>
			</div>
			<div class="flex max-w-2xl items-start justify-between gap-4 p-6">
				<div class="flex-1">
					<h4 class="text-sm font-medium text-zinc-200">Active algorithm</h4>
					<p class="mt-1 text-xs text-zinc-500">
						SM-2 is the classic ease-factor scheduler; FSRS optimizes for a target retention rate.
					</p>
				</div>
				<select bind:value={scheduler} class="{inputClass} w-40 shrink-0">
					<option value="sm2">SM-2</option>
					<option value="fsrs">FSRS</option>
				</select>
			</div>
		</section>

		<!-- SM-2 tuning -->
		<section
			class="glass-panel overflow-hidden rounded-xl border border-zinc-800 {scheduler === 'sm2'
				? ''
				: 'opacity-60'}"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<div>
					<h2 class="text-lg font-semibold text-zinc-100">SM-2 Parameters</h2>
					<p class="mt-1 text-sm text-zinc-400">Ease factors and the first two review intervals.</p>
				</div>
				{#if scheduler === 'sm2'}
					<span
						class="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-400"
					>
						Active
					</span>
				{/if}
			</div>
			<div class="grid gap-6 p-6 sm:grid-cols-2">
				<div>
					<label for="sm2-initial-ease" class="text-sm font-medium text-zinc-200">
						Initial ease
					</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">Starting ease factor for new cards (~1.3–5).</p>
					<input
						id="sm2-initial-ease"
						type="number"
						step="0.1"
						bind:value={initialEase}
						class="{inputClass} w-full"
					/>
				</div>
				<div>
					<label for="sm2-min-ease" class="text-sm font-medium text-zinc-200">Minimum ease</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">
						Lower bound the ease factor can decay to (~1.1–3).
					</p>
					<input
						id="sm2-min-ease"
						type="number"
						step="0.1"
						bind:value={minEase}
						class="{inputClass} w-full"
					/>
				</div>
				<div>
					<label for="sm2-first-interval" class="text-sm font-medium text-zinc-200">
						First interval (days)
					</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">Gap before the first review of a new card.</p>
					<input
						id="sm2-first-interval"
						type="number"
						step="1"
						bind:value={firstIntervalDays}
						class="{inputClass} w-full"
					/>
				</div>
				<div>
					<label for="sm2-second-interval" class="text-sm font-medium text-zinc-200">
						Second interval (days)
					</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">Gap before the second review after a pass.</p>
					<input
						id="sm2-second-interval"
						type="number"
						step="1"
						bind:value={secondIntervalDays}
						class="{inputClass} w-full"
					/>
				</div>
			</div>
		</section>

		<!-- FSRS tuning -->
		<section
			class="glass-panel overflow-hidden rounded-xl border border-zinc-800 {scheduler === 'fsrs'
				? ''
				: 'opacity-60'}"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
				<div>
					<h2 class="text-lg font-semibold text-zinc-100">FSRS Parameters</h2>
					<p class="mt-1 text-sm text-zinc-400">Target retention and the interval ceiling.</p>
				</div>
				{#if scheduler === 'fsrs'}
					<span
						class="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-400"
					>
						Active
					</span>
				{/if}
			</div>
			<div class="grid gap-6 p-6 sm:grid-cols-2">
				<div>
					<label for="fsrs-retention" class="text-sm font-medium text-zinc-200">
						Request retention
					</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">
						Desired probability of recall at review time (0–1, e.g. 0.90).
					</p>
					<input
						id="fsrs-retention"
						type="number"
						step="0.01"
						min="0"
						max="1"
						bind:value={requestRetention}
						class="{inputClass} w-full"
					/>
				</div>
				<div>
					<label for="fsrs-max-interval" class="text-sm font-medium text-zinc-200">
						Maximum interval (days)
					</label>
					<p class="mt-1 mb-2 text-xs text-zinc-500">Longest gap the scheduler may assign.</p>
					<input
						id="fsrs-max-interval"
						type="number"
						step="1"
						min="1"
						bind:value={maximumInterval}
						class="{inputClass} w-full"
					/>
				</div>
			</div>
		</section>

		<!-- Save -->
		<div class="flex items-center justify-end gap-3">
			{#if savedNotice}
				<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">
					{savedNotice}
				</span>
			{/if}
			{#if $saveStudy.isError}
				<span class="text-xs text-rose-400">
					{$saveStudy.error instanceof Error ? $saveStudy.error.message : 'Save failed'}
				</span>
			{/if}
			<button
				onclick={() => $saveStudy.mutate()}
				disabled={$saveStudy.isPending || $orgSettings.isLoading}
				class="rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				{$saveStudy.isPending ? 'Saving…' : 'Save Study Settings'}
			</button>
		</div>
	{/if}
</div>

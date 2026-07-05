<script lang="ts">
	import {
		Settings2,
		Key,
		Users,
		HardDrive,
		Cpu,
		CreditCard,
		Shield,
		Info
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import type { Component } from 'svelte';
	import { cn } from '$lib/utils';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';

	const queryClient = useQueryClient();

	// Load persisted preferences to seed the form (best-effort).
	const prefsQuery = createQuery({
		queryKey: ['preferences'],
		queryFn: () => api.getPreferences()
	});

	// Persist the current form state via the preferences endpoint. A single
	// mutation backs both "Save Configuration" and "Save Policy" — each passes
	// the slice of state it owns.
	let savedNotice = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const savePrefs = createMutation({
		mutationFn: (prefs: Record<string, unknown>) => api.savePreferences(prefs),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['preferences'] });
			savedNotice = 'Saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		}
	});

	// Seed local form state from persisted preferences when they load.
	$effect(() => {
		const p = $prefsQuery.data;
		if (!p) return;
		if (typeof p.deltaExtraction === 'boolean') pipeline.deltaExtraction = p.deltaExtraction;
		if (typeof p.strictCitation === 'boolean') pipeline.strictCitation = p.strictCitation;
		if (typeof p.graphCommunity === 'boolean') pipeline.graphCommunity = p.graphCommunity;
		if (typeof p.embeddingModel === 'string') embeddingModel = p.embeddingModel;
		if (typeof p.extractionModel === 'string') extractionModel = p.extractionModel;
		if (typeof p.synthesisModel === 'string') synthesisModel = p.synthesisModel;
	});

	function saveConfiguration() {
		$savePrefs.mutate({
			deltaExtraction: pipeline.deltaExtraction,
			strictCitation: pipeline.strictCitation,
			graphCommunity: pipeline.graphCommunity,
			embeddingModel,
			extractionModel,
			synthesisModel
		});
	}

	function savePolicy() {
		$savePrefs.mutate({ sourcePriority });
	}

	// Prototype-only settings (no API endpoint) — all form state is local.
	let activeTab = $state('General');

	const configTabs: { icon: Component; label: string }[] = [
		{ icon: Settings2, label: 'General' },
		{ icon: Users, label: 'Users & Roles' },
		{ icon: Shield, label: 'Governance & Review' },
		{ icon: Key, label: 'API Keys & Integrations' }
	];

	const healthTabs: { icon: Component; label: string }[] = [
		{ icon: Cpu, label: 'AI Usage / FinOps' },
		{ icon: HardDrive, label: 'Storage & Indices' },
		{ icon: CreditCard, label: 'Billing' }
	];

	// Processing pipeline toggles
	const pipeline = $state({
		deltaExtraction: true,
		strictCitation: true,
		graphCommunity: true
	});

	// AI model routing selections
	let embeddingModel = $state('text-embedding-004 (Default)');
	let extractionModel = $state('gemini-1.5-flash (Optimized speed)');
	let synthesisModel = $state('gemini-1.5-pro (Recommended)');

	const sourcePriority = [
		'1. Official Clinical Guideline',
		'2. Latest Textbook Edition',
		'3. Core Textbook',
		'4. Board Review Book',
		'5. Lecture Notes',
		'6. User Notes',
		'7. Unknown PDF'
	];
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto flex max-w-5xl flex-col gap-8 md:flex-row">
		<!-- Settings Nav -->
		<aside class="w-full shrink-0 space-y-1 md:w-64">
			<h2 class="mb-3 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
				Configuration
			</h2>
			{#each configTabs as item (item.label)}
				{@const Icon = item.icon}
				<button
					onclick={() => (activeTab = item.label)}
					class={cn(
						'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
						activeTab === item.label
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
					)}
				>
					<Icon class="h-4 w-4" />
					{item.label}
				</button>
			{/each}

			<h2 class="mt-8 mb-3 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
				System Health
			</h2>
			{#each healthTabs as item (item.label)}
				{@const Icon = item.icon}
				<button
					onclick={() => (activeTab = item.label)}
					class={cn(
						'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
						activeTab === item.label
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
					)}
				>
					<Icon class="h-4 w-4" />
					{item.label}
				</button>
			{/each}
		</aside>

		<!-- Settings Content -->
		<div class="flex-1 space-y-6">
			{#if activeTab === 'General'}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">Processing Pipeline</h2>
						<p class="text-sm text-zinc-500">
							Configure how newly uploaded documents are handled globally.
						</p>
					</div>
					<div class="space-y-6 p-6">
						{@render pipelineRow(
							'Delta Extraction (Copilot SDK)',
							'Automatically extract new claims, deduplicate against SSOT, and find conflicts using high-reasoning models.',
							() => pipeline.deltaExtraction,
							() => (pipeline.deltaExtraction = !pipeline.deltaExtraction)
						)}
						<div class="w-full border-t border-zinc-800"></div>
						{@render pipelineRow(
							'Strict Citation Verification',
							'Reject answers or extracted claims that cannot be traced to exact PDF page boundaries or text blocks.',
							() => pipeline.strictCitation,
							() => (pipeline.strictCitation = !pipeline.strictCitation)
						)}
						<div class="w-full border-t border-zinc-800"></div>
						{@render pipelineRow(
							'Graph Community Extraction (GraphRAG)',
							'Build entity-relationships simultaneously during chunking to power graph visualization and search.',
							() => pipeline.graphCommunity,
							() => (pipeline.graphCommunity = !pipeline.graphCommunity)
						)}
					</div>
				</div>

				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300, delay: 100 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">AI Model Routing</h2>
						<p class="text-sm text-zinc-500">
							Manage API endpoints, keys, and base models. Override Gemini defaults.
						</p>
					</div>
					<div class="space-y-4 p-6">
						<div class="space-y-2">
							<label for="embed-model" class="text-xs font-medium text-zinc-400">Embedding Model</label>
							<select
								id="embed-model"
								bind:value={embeddingModel}
								class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
							>
								<option>text-embedding-004 (Default)</option>
								<option>bge-large-en-v1.5</option>
							</select>
						</div>
						<div class="space-y-2">
							<label for="extract-model" class="text-xs font-medium text-zinc-400">
								Data Extraction / Classification Model
							</label>
							<select
								id="extract-model"
								bind:value={extractionModel}
								class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
							>
								<option>gemini-1.5-flash (Optimized speed)</option>
								<option>gemini-1.5-pro</option>
							</select>
						</div>
						<div class="space-y-2">
							<label for="synth-model" class="text-xs font-medium text-zinc-400">
								Synthesis &amp; Conflict Resolution Model
							</label>
							<select
								id="synth-model"
								bind:value={synthesisModel}
								class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
							>
								<option>gemini-1.5-pro (Recommended)</option>
								<option>gemini-1.5-flash</option>
							</select>
						</div>
					</div>
					<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
						{#if savedNotice}
							<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">
								{savedNotice}
							</span>
						{/if}
						<button
							onclick={saveConfiguration}
							disabled={$savePrefs.isPending}
							class="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{$savePrefs.isPending ? 'Saving...' : 'Save Configuration'}
						</button>
					</div>
				</div>
			{:else if activeTab === 'Governance & Review'}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">Source Priority Rules</h2>
						<p class="text-sm text-zinc-500">
							Configure evidence hierarchy to resolve conflicts automatically before human review.
						</p>
					</div>
					<div class="p-6">
						<p class="mb-4 text-sm text-zinc-400">
							Drag to reorder source authority. The system trusts higher sources when merging
							contradictions.
						</p>
						<div class="space-y-2">
							{#each sourcePriority as item (item)}
								<div
									class="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 p-3"
								>
									<span class="text-sm font-medium text-zinc-300">{item}</span>
									<Settings2 class="h-4 w-4 text-zinc-600" />
								</div>
							{/each}
						</div>
					</div>
					<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
						{#if savedNotice}
							<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">
								{savedNotice}
							</span>
						{/if}
						<button
							onclick={savePolicy}
							disabled={$savePrefs.isPending}
							class="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{$savePrefs.isPending ? 'Saving...' : 'Save Policy'}
						</button>
					</div>
				</div>
			{:else}
				<div
					class="flex flex-col items-center justify-center rounded-xl border border-zinc-800 p-12 text-center glass-panel"
					in:fade={{ duration: 300 }}
				>
					<div
						class="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-zinc-500"
					>
						<Info class="h-6 w-6" />
					</div>
					<h3 class="mb-2 text-lg font-medium text-zinc-200">{activeTab} Settings</h3>
					<p class="max-w-md text-sm text-zinc-500">
						Configuration options for {activeTab.toLowerCase()} are managed in the enterprise
						dashboard. Contact your system administrator to adjust these policies.
					</p>
				</div>
			{/if}
		</div>
	</div>
</main>

{#snippet pipelineRow(title: string, description: string, get: () => boolean, onToggle: () => void)}
	<div class="flex items-center justify-between gap-4">
		<div>
			<h4 class="text-sm font-medium text-zinc-200">{title}</h4>
			<p class="mt-1 max-w-sm text-xs text-zinc-500">{description}</p>
		</div>
		<button
			type="button"
			role="switch"
			aria-label={title}
			aria-checked={get()}
			onclick={onToggle}
			class={cn(
				'relative h-6 w-11 shrink-0 rounded-full transition-colors',
				get() ? 'bg-indigo-600' : 'bg-zinc-800'
			)}
		>
			<span
				class={cn(
					'absolute top-[2px] h-5 w-5 rounded-full bg-white transition-all',
					get() ? 'left-[22px]' : 'left-[2px]'
				)}
			></span>
		</button>
	</div>
{/snippet}

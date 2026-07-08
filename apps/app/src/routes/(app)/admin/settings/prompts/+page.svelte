<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { MessageSquareText, Save, Loader2, CheckCircle2, AlertTriangle } from '@lucide/svelte';
	import { fly, fade } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { OrgSettingsResponse, OrgSettingsUpdate } from '@insightlibrary/api-client';

	// Per-mode copilot system-prompt overrides live in org settings
	// (settings.copilotPromptOverrides). Empty = the built-in default for that
	// mode is used; the built-in text is exposed as copilotPromptDefaults and
	// shown as a placeholder. Saves apply to new copilot conversations within
	// seconds (short-TTL settings cache) — no server restart.
	const settingsQ = createQuery({ queryKey: ['org-settings'], queryFn: () => api.getOrgSettings() });
	const queryClient = useQueryClient();

	// Exact copilot mode list — mirrors copilotModeSchema in @insightlibrary/schemas.
	const COPILOT_MODES = [
		'ask',
		'strict_citation',
		'research',
		'compare',
		'contradiction',
		'study',
		'teacher',
		'exam',
		'summarize',
		'deep_reasoning',
		'fast_answer',
		'ssot',
		'delta'
	] as const;

	function modeLabel(m: string): string {
		if (m === 'ssot') return 'SSOT';
		return m.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	// Local editable copy of the overrides map, seeded once from the fetched settings.
	let overrides = $state<Record<string, string>>({});
	let seeded = $state(false);
	$effect(() => {
		const d = $settingsQ.data;
		if (!d || seeded) return;
		seeded = true;
		overrides = { ...d.settings.copilotPromptOverrides };
	});

	const defaults = $derived($settingsQ.data?.copilotPromptDefaults ?? {});
	const activeCount = $derived(Object.values(overrides).filter((v) => v.trim()).length);

	// Store the raw text for a mode, or drop the key entirely when blank so an
	// empty box always falls back to the built-in default.
	function setOverride(mode: string, text: string) {
		const next = { ...overrides };
		if (text.trim()) next[mode] = text;
		else delete next[mode];
		overrides = next;
	}

	let savedNotice = $state('');
	let saveError = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const saveMut = createMutation({
		mutationFn: (input: OrgSettingsUpdate) => api.updateOrgSettings(input),
		onSuccess: (data: OrgSettingsResponse) => {
			queryClient.setQueryData(['org-settings'], data);
			queryClient.invalidateQueries({ queryKey: ['org-settings'] });
			savedNotice = 'Prompts saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		},
		onError: (e: unknown) => {
			saveError = e instanceof Error ? e.message : 'Failed to save copilot prompts';
		}
	});

	function handleSave() {
		saveError = '';
		// Send only non-empty (trimmed) overrides; an empty object clears them all.
		const nonEmpty: Record<string, string> = {};
		for (const [k, v] of Object.entries(overrides)) if (v.trim()) nonEmpty[k] = v.trim();
		$saveMut.mutate({
			settings: {
				copilotPromptOverrides: Object.keys(nonEmpty).length ? nonEmpty : null
			}
		});
	}
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<MessageSquareText class="h-6 w-6 text-indigo-400" />
			Copilot Prompts
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Override the built-in system prompt for each copilot mode. Leave a box empty to keep the
			built-in default (shown as placeholder). Changes apply to new copilot conversations within
			seconds of saving.
		</p>
	</header>

	{#if $settingsQ.isError}
		<div
			class="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300"
		>
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
			<div>Couldn't load copilot prompt settings. Changes cannot be saved until the settings API is reachable.</div>
		</div>
	{/if}

	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-900/30 p-6">
			<div>
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<MessageSquareText class="h-5 w-5 text-indigo-400" /> System-Prompt Overrides
				</h2>
				<p class="mt-1 text-sm text-zinc-400">
					One prompt per mode. Overridden modes are marked; blank ones use the built-in prompt.
				</p>
			</div>
			<span class="shrink-0 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-400">
				{activeCount} overridden
			</span>
		</div>

		{#if $settingsQ.isLoading}
			<div class="space-y-6 p-6">
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-28 rounded-md" />
				{/each}
			</div>
		{:else}
			<div class="space-y-6 p-6">
				{#each COPILOT_MODES as mode, i (mode)}
					<div class="space-y-2" in:fly={{ y: 6, duration: 200, delay: i * 20 }}>
						<div class="flex items-center justify-between">
							<label for="prompt-{mode}" class="text-sm font-medium text-zinc-200">
								{modeLabel(mode)}
							</label>
							{#if overrides[mode]?.trim()}
								<span class="text-[10px] font-medium tracking-wide text-indigo-400 uppercase">Overridden</span>
							{:else}
								<span class="text-[10px] font-medium tracking-wide text-zinc-600 uppercase">Default</span>
							{/if}
						</div>
						<textarea
							id="prompt-{mode}"
							rows="3"
							value={overrides[mode] ?? ''}
							oninput={(e) => setOverride(mode, e.currentTarget.value)}
							placeholder={defaults[mode] || 'Uses the built-in default prompt for this mode.'}
							class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
						></textarea>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<div class="relative flex items-center justify-end gap-4 pt-2 pb-12">
		{#if savedNotice}
			<div
				in:fly={{ x: -20, duration: 250 }}
				out:fade={{ duration: 150 }}
				class="flex items-center gap-2 text-sm font-medium text-emerald-400"
			>
				<CheckCircle2 class="h-4 w-4" />
				{savedNotice}
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
			class="flex items-center gap-2 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{#if $saveMut.isPending}
				<Loader2 class="h-4 w-4 animate-spin" />
				Saving…
			{:else}
				<Save class="h-4 w-4" />
				Save Prompts
			{/if}
		</button>
	</div>
</div>

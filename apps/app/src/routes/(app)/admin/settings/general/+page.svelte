<script lang="ts">
	import { Save, AlertTriangle, UploadCloud, CheckCircle2, Loader2, X } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';
	import type { OrgSettingsResponse, OrgSettingsUpdate } from '@insightlibrary/api-client';

	// Real org-scoped persistence via GET/PUT /api/org/settings (admin-gated).
	const settingsQ = createQuery({ queryKey: ['org-settings'], queryFn: () => api.getOrgSettings() });
	const queryClient = useQueryClient();

	let workspaceName = $state('');
	let strictCitation = $state(true);
	let autoSsot = $state(true);
	let logoPreview = $state<string | null>(null);
	let logoDirty = $state(false);
	let logoError = $state('');

	// Seed the form once per page load from the fetched settings.
	let seeded = $state(false);
	$effect(() => {
		const d = $settingsQ.data;
		if (!d || seeded) return;
		seeded = true;
		workspaceName = d.name ?? '';
		strictCitation = d.settings.strictCitationDefault;
		autoSsot = d.settings.autoSsotTopics;
		logoPreview = d.logo;
	});

	let showSaved = $state(false);
	let saveError = $state('');
	const saveMut = createMutation({
		mutationFn: (input: OrgSettingsUpdate) => api.updateOrgSettings(input),
		onSuccess: (data: OrgSettingsResponse) => {
			queryClient.setQueryData(['org-settings'], data);
			logoDirty = false;
			showSaved = true;
			setTimeout(() => (showSaved = false), 3000);
		},
		onError: (e: unknown) => {
			saveError = e instanceof Error ? e.message : 'Failed to save configuration';
		}
	});

	function handleSave() {
		saveError = '';
		const input: OrgSettingsUpdate = {
			settings: { strictCitationDefault: strictCitation, autoSsotTopics: autoSsot }
		};
		const name = workspaceName.trim();
		if (name) input.name = name;
		if (logoDirty) input.logo = logoPreview;
		$saveMut.mutate(input);
	}

	// Logo: stored server-side as a small data: URL (no asset pipeline needed).
	const MAX_LOGO_BYTES = 300 * 1024;
	let logoInput = $state<HTMLInputElement | null>(null);

	function pickLogo() {
		logoInput?.click();
	}

	function onLogoChange(e: Event) {
		logoError = '';
		const el = e.currentTarget as HTMLInputElement;
		const file = el.files?.[0];
		el.value = '';
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			logoError = 'Please choose an image file.';
			return;
		}
		if (file.size > MAX_LOGO_BYTES) {
			logoError = 'Logo must be 300 KB or smaller.';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				logoPreview = reader.result;
				logoDirty = true;
			}
		};
		reader.readAsDataURL(file);
	}

	function removeLogo() {
		logoPreview = null;
		logoDirty = true;
	}

	const logoInitial = $derived(workspaceName.charAt(0).toUpperCase() || 'W');
</script>

<div class="relative max-w-4xl p-6 md:p-8">
	<header class="mb-8">
		<h1 class="text-2xl font-bold tracking-tight text-zinc-100">General Settings</h1>
		<p class="mt-1 text-sm text-zinc-400">
			Manage global configuration, branding, and defaults for your tenant.
		</p>
	</header>

	{#if $settingsQ.isError}
		<div class="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
			<div>Couldn't load workspace settings. Changes cannot be saved until the settings API is reachable.</div>
		</div>
	{/if}

	<div class="space-y-8">
		<!-- Workspace Identity -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800 shadow-sm">
			<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Workspace Identity</h2>
				<p class="mt-1 text-sm text-zinc-400">
					This organization name will be visible to all invited users.
				</p>
			</div>
			<div class="space-y-6 p-6">
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-300" for="workspace-name">Workspace Name</label>
					<input
						id="workspace-name"
						type="text"
						bind:value={workspaceName}
						disabled={$settingsQ.isLoading}
						class="w-full max-w-md rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none disabled:opacity-60"
					/>
				</div>

				<div class="space-y-2">
					<span class="text-sm font-medium text-zinc-300">Workspace Logo</span>
					<div class="flex items-center gap-6">
						<div
							class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl font-bold text-white uppercase shadow-lg shadow-indigo-500/20"
						>
							{#if logoPreview}
								<img src={logoPreview} alt="Workspace logo" class="h-full w-full object-cover" />
							{:else}
								{logoInitial}
							{/if}
						</div>
						<input
							bind:this={logoInput}
							onchange={onLogoChange}
							type="file"
							accept="image/*"
							class="hidden"
						/>
						<div class="flex items-center gap-3">
							<button
								type="button"
								onclick={pickLogo}
								class="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
							>
								<UploadCloud class="h-4 w-4" /> Change Logo
							</button>
							{#if logoPreview}
								<button
									type="button"
									onclick={removeLogo}
									class="flex items-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-zinc-500 transition-colors hover:text-rose-400"
								>
									<X class="h-3.5 w-3.5" /> Remove
								</button>
							{/if}
						</div>
					</div>
					<p class="text-xs text-zinc-500">PNG/JPEG/SVG up to 300 KB. Saved with the configuration below.</p>
					{#if logoError}
						<p class="text-xs text-rose-400">{logoError}</p>
					{/if}
				</div>
			</div>
		</section>

		<!-- Platform Defaults -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800 shadow-sm">
			<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Platform Defaults</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Workspace-wide default policies, stored in the org settings and exposed to clients via the
					settings API.
				</p>
			</div>
			<div class="space-y-6 p-6">
				<div class="flex max-w-md items-start justify-between gap-4">
					<div>
						<h4 class="text-sm font-medium text-zinc-200">Strict Citation Mode by Default</h4>
						<p class="mt-0.5 text-xs leading-snug text-zinc-500">
							Default Copilot answering policy for this workspace: only answer using retrieved and
							verified citations.
						</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={strictCitation}
						aria-label="Strict citation mode"
						onclick={() => (strictCitation = !strictCitation)}
						class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {strictCitation
							? 'border-indigo-500 bg-indigo-500'
							: 'border-zinc-700 bg-zinc-800'}"
					>
						<span
							class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {strictCitation
								? 'translate-x-[22px]'
								: 'translate-x-0.5'}"
						></span>
					</button>
				</div>

				<div class="flex max-w-md items-start justify-between gap-4 border-t border-zinc-800/50 pt-6">
					<div>
						<h4 class="text-sm font-medium text-zinc-200">Auto-Generate SSOT Topics</h4>
						<p class="mt-0.5 text-xs leading-snug text-zinc-500">
							Automatically compile single source of truth topics from new document uploads.
						</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoSsot}
						aria-label="Auto-generate SSOT topics"
						onclick={() => (autoSsot = !autoSsot)}
						class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {autoSsot
							? 'border-indigo-500 bg-indigo-500'
							: 'border-zinc-700 bg-zinc-800'}"
					>
						<span
							class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {autoSsot
								? 'translate-x-[22px]'
								: 'translate-x-0.5'}"
						></span>
					</button>
				</div>
			</div>
		</section>

		<!-- Action Bar -->
		<div class="relative flex items-center justify-end gap-4 pt-4 pb-12">
			{#if showSaved}
				<div
					in:fly={{ x: -20, duration: 250 }}
					out:fade={{ duration: 150 }}
					class="flex items-center gap-2 text-sm font-medium text-emerald-400"
				>
					<CheckCircle2 class="h-4 w-4" />
					Configuration Saved
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
					Save Configuration
				{/if}
			</button>
		</div>

		<!-- Danger Zone -->
		<section class="mt-8 overflow-hidden rounded-xl border border-rose-500/20 bg-rose-500/5 shadow-sm">
			<div class="border-b border-rose-500/20 bg-rose-500/5 p-6">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-rose-400">
					<AlertTriangle class="h-5 w-5" /> Danger Zone
				</h2>
				<p class="mt-1 text-sm text-zinc-500">Irreversible and destructive workspace actions.</p>
			</div>
			<div class="flex flex-col justify-between gap-6 p-6 sm:flex-row sm:items-center">
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Delete Workspace</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Self-service workspace deletion is not available yet. Contact support to permanently
						remove your workspace and all its data from InsightLibrary AI.
					</p>
				</div>
				<button
					disabled
					title="Self-service workspace deletion is not available yet"
					class="cursor-not-allowed rounded-md border border-zinc-700 bg-zinc-900/50 px-6 py-2.5 text-sm font-medium whitespace-nowrap text-zinc-500 opacity-60"
				>
					Not Available
				</button>
			</div>
		</section>
	</div>
</div>
